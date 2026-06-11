use std::{
    collections::HashMap,
    fs,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc, oneshot},
    time::{Duration, timeout},
};

use crate::{
    logger::Logger,
    protocol::{
        extract_completed_agent_text, extract_delta_text, extract_error_message, extract_thread_id,
        extract_turn_id, get_array_at, get_string_at,
    },
    types::{AppPaths, AppServerMode, AppServerStatus, AppServerStatusSnapshot, ClawConfig},
};

#[derive(Clone, Debug)]
pub struct CodexApprovalRequest {
    pub id: Value,
    pub method: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub message: String,
}

#[derive(Clone, Copy, Debug)]
pub enum CodexApprovalDecision {
    Accept,
    Decline,
}

struct ActiveTurn {
    turn_id: Option<String>,
    chunks: Vec<String>,
    tx: Option<oneshot::Sender<Result<String, String>>>,
}

#[derive(Clone)]
pub struct CodexAppServerClient {
    inner: Arc<CodexInner>,
}

struct CodexInner {
    config: ClawConfig,
    paths: AppPaths,
    logger: Logger,
    known_thread_count: Arc<dyn Fn() -> usize + Send + Sync>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    pending_approvals: Mutex<HashMap<String, Value>>,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    next_id: AtomicU64,
    status: Mutex<AppServerStatus>,
    last_error: Mutex<Option<String>>,
    last_completed_turn_at: Mutex<Option<String>>,
    approval_tx: mpsc::Sender<CodexApprovalRequest>,
    approval_rx: Mutex<Option<mpsc::Receiver<CodexApprovalRequest>>>,
}

impl CodexAppServerClient {
    pub fn new(
        config: ClawConfig,
        paths: AppPaths,
        logger: Logger,
        known_thread_count: Arc<dyn Fn() -> usize + Send + Sync>,
    ) -> Self {
        let (approval_tx, approval_rx) = mpsc::channel(32);
        Self {
            inner: Arc::new(CodexInner {
                config,
                paths,
                logger,
                known_thread_count,
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                pending_approvals: Mutex::new(HashMap::new()),
                active_turns: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                status: Mutex::new(AppServerStatus::Stopped),
                last_error: Mutex::new(None),
                last_completed_turn_at: Mutex::new(None),
                approval_tx,
                approval_rx: Mutex::new(Some(approval_rx)),
            }),
        }
    }

    pub async fn take_approval_receiver(&self) -> Result<mpsc::Receiver<CodexApprovalRequest>> {
        self.inner
            .approval_rx
            .lock()
            .await
            .take()
            .ok_or_else(|| anyhow!("codex approval receiver already taken"))
    }

    pub async fn start(&self) -> Result<()> {
        if self.inner.child.lock().await.is_some() {
            return Ok(());
        }
        self.launch_codex_app().await;
        if !fs::metadata(&self.inner.config.codex_bin).is_ok() {
            return Err(anyhow!(
                "Codex.app runtime not found: {}",
                self.inner.config.codex_bin
            ));
        }
        self.ensure_app_server_daemon().await?;
        *self.inner.status.lock().await = AppServerStatus::Starting;

        let args = self.app_server_args();
        self.inner
            .logger
            .info(format!(
                "codex app-server starting mode={:?} bin={} args={} cwd={}",
                self.inner.config.codex_app_server_mode,
                self.inner.config.codex_bin,
                args.join(" "),
                self.inner.paths.workspace
            ))
            .await;
        let mut child = Command::new(&self.inner.config.codex_bin)
            .args(&args)
            .current_dir(&self.inner.paths.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to spawn codex app-server")?;

        let stdout = child.stdout.take().context("codex stdout unavailable")?;
        let stderr = child.stderr.take().context("codex stderr unavailable")?;
        *self.inner.stdin.lock().await = child.stdin.take();
        *self.inner.child.lock().await = Some(child);
        self.spawn_stdout_reader(stdout);
        self.spawn_stderr_reader(stderr);

        self.request(
            "initialize",
            Some(json!({
                "clientInfo": {
                    "name": "codex_claw",
                    "title": "Codex Claw",
                    "version": "0.1.0"
                }
            })),
        )
        .await?;
        self.notify("initialized", None).await?;
        *self.inner.status.lock().await = AppServerStatus::Ready;
        self.inner.logger.info("codex app-server ready").await;
        Ok(())
    }

    pub async fn stop(&self) {
        let mut active = self.inner.active_turns.lock().await;
        for (_, turn) in active.iter_mut() {
            if let Some(tx) = turn.tx.take() {
                let _ = tx.send(Err("codex app-server stopped".to_string()));
            }
        }
        active.clear();
        drop(active);

        if let Some(mut child) = self.inner.child.lock().await.take() {
            let _ = child.kill().await;
        }
        *self.inner.status.lock().await = AppServerStatus::Stopped;
    }

    pub async fn start_thread(&self) -> Result<String> {
        self.ensure_started().await?;
        let mut params = json!({
            "cwd": self.inner.paths.workspace,
            "serviceName": "codex-claw"
        });
        add_optional(&mut params, "model", self.inner.config.codex_model.clone());
        add_optional(
            &mut params,
            "sandbox",
            self.inner.config.codex_sandbox.clone(),
        );
        add_optional(
            &mut params,
            "approvalPolicy",
            self.inner.config.codex_approval_policy.clone(),
        );
        add_optional(
            &mut params,
            "approvalsReviewer",
            self.inner.config.codex_approvals_reviewer.clone(),
        );
        self.inner
            .logger
            .info(format!(
                "codex thread/start cwd={}",
                self.inner.paths.workspace
            ))
            .await;
        let result = self.request("thread/start", Some(params)).await?;
        let thread_id = get_string_at(&result, &["thread", "id"])
            .ok_or_else(|| anyhow!("thread/start did not return thread.id"))?;
        self.inner
            .logger
            .info(format!("codex thread/start ok thread={thread_id}"))
            .await;
        Ok(thread_id)
    }

    pub async fn resume_thread(&self, thread_id: &str) -> Result<String> {
        self.ensure_started().await?;
        let mut params = json!({
            "threadId": thread_id,
            "cwd": self.inner.paths.workspace
        });
        add_optional(
            &mut params,
            "approvalPolicy",
            self.inner.config.codex_approval_policy.clone(),
        );
        add_optional(
            &mut params,
            "approvalsReviewer",
            self.inner.config.codex_approvals_reviewer.clone(),
        );
        add_optional(
            &mut params,
            "sandbox",
            self.inner.config.codex_sandbox.clone(),
        );
        self.inner
            .logger
            .info(format!("codex thread/resume thread={thread_id}"))
            .await;
        let result = self.request("thread/resume", Some(params)).await?;
        let resumed =
            get_string_at(&result, &["thread", "id"]).unwrap_or_else(|| thread_id.to_string());
        self.inner
            .logger
            .info(format!("codex thread/resume ok thread={resumed}"))
            .await;
        Ok(resumed)
    }

    pub async fn run_turn(&self, thread_id: &str, text: &str) -> Result<String> {
        self.ensure_started().await?;
        self.inner
            .logger
            .info(format!(
                "codex turn/start requested thread={} chars={}",
                thread_id,
                text.chars().count()
            ))
            .await;
        let (tx, rx) = oneshot::channel();
        self.inner.active_turns.lock().await.insert(
            thread_id.to_string(),
            ActiveTurn {
                turn_id: None,
                chunks: vec![],
                tx: Some(tx),
            },
        );

        let mut params = json!({
            "threadId": thread_id,
            "cwd": self.inner.paths.workspace,
            "input": [{ "type": "text", "text": text, "text_elements": [] }]
        });
        add_optional(&mut params, "model", self.inner.config.codex_model.clone());
        add_optional(
            &mut params,
            "approvalPolicy",
            self.inner.config.codex_approval_policy.clone(),
        );
        add_optional(
            &mut params,
            "approvalsReviewer",
            self.inner.config.codex_approvals_reviewer.clone(),
        );

        match self.request("turn/start", Some(params)).await {
            Ok(result) => {
                if let Some(turn_id) = extract_turn_id(&result) {
                    if let Some(turn) = self.inner.active_turns.lock().await.get_mut(thread_id) {
                        turn.turn_id = Some(turn_id.clone());
                    }
                    self.inner
                        .logger
                        .info(format!(
                            "codex turn/start ok thread={thread_id} turn={turn_id}"
                        ))
                        .await;
                } else {
                    self.inner
                        .logger
                        .warn(format!(
                            "codex turn/start ok thread={thread_id} without turn id"
                        ))
                        .await;
                }
            }
            Err(err) => {
                self.inner.active_turns.lock().await.remove(thread_id);
                return Err(err);
            }
        }

        match timeout(Duration::from_millis(self.inner.config.turn_timeout_ms), rx).await {
            Ok(Ok(Ok(text))) => Ok(text),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("codex turn response channel closed")),
            Err(_) => {
                self.inner
                    .logger
                    .error(format!(
                        "codex turn timed out thread={} after {}ms",
                        thread_id, self.inner.config.turn_timeout_ms
                    ))
                    .await;
                let turn_id = self
                    .inner
                    .active_turns
                    .lock()
                    .await
                    .remove(thread_id)
                    .and_then(|turn| turn.turn_id);
                self.decline_pending_approvals_for_thread(thread_id, "turn timed out")
                    .await;
                if let Some(turn_id) = turn_id {
                    let _ = self
                        .request(
                            "turn/interrupt",
                            Some(json!({ "threadId": thread_id, "turnId": turn_id })),
                        )
                        .await;
                }
                Err(anyhow!(
                    "Codex turn timed out after {}ms",
                    self.inner.config.turn_timeout_ms
                ))
            }
        }
    }

    pub async fn steer_turn(&self, thread_id: &str, turn_id: &str, text: &str) -> Result<()> {
        self.ensure_started().await?;
        self.request(
            "turn/steer",
            Some(json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{ "type": "text", "text": text, "text_elements": [] }]
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn resolve_approval(&self, id: &Value, decision: CodexApprovalDecision) -> bool {
        let key = rpc_id_key(id);
        let request = self.inner.pending_approvals.lock().await.remove(&key);
        let Some(request) = request else {
            return false;
        };
        let response = approval_response_for(&request, decision);
        let _ = self.respond(id.clone(), response).await;
        true
    }

    pub async fn status(&self) -> AppServerStatusSnapshot {
        let active_turns = self.inner.active_turns.lock().await.len();
        let status = *self.inner.status.lock().await;
        AppServerStatusSnapshot {
            pid: self
                .inner
                .child
                .lock()
                .await
                .as_ref()
                .and_then(|child| child.id()),
            status: if active_turns > 0 && status == AppServerStatus::Ready {
                AppServerStatus::Busy
            } else {
                status
            },
            active_turns,
            known_threads: (self.inner.known_thread_count)(),
            last_error: self.inner.last_error.lock().await.clone(),
            last_completed_turn_at: self.inner.last_completed_turn_at.lock().await.clone(),
        }
    }

    async fn ensure_started(&self) -> Result<()> {
        if self.inner.child.lock().await.is_none() {
            self.start().await?;
        }
        Ok(())
    }

    async fn launch_codex_app(&self) {
        if fs::metadata(&self.inner.config.codex_app_path).is_err() {
            self.inner
                .logger
                .warn(format!(
                    "Codex.app not found at {}; continuing with runtime only",
                    self.inner.config.codex_app_path
                ))
                .await;
            return;
        }
        let result = Command::new("open")
            .arg(&self.inner.config.codex_app_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if let Err(err) = result {
            self.inner
                .logger
                .warn(format!("failed to open Codex.app: {err}"))
                .await;
        }
        if self.inner.config.codex_app_launch_wait_ms > 0 {
            tokio::time::sleep(Duration::from_millis(
                self.inner.config.codex_app_launch_wait_ms,
            ))
            .await;
        }
    }

    async fn ensure_app_server_daemon(&self) -> Result<()> {
        if self.inner.config.codex_app_server_mode != AppServerMode::Proxy
            || !self.inner.config.codex_daemon_start
        {
            return Ok(());
        }
        let status = Command::new(&self.inner.config.codex_bin)
            .args(["app-server", "daemon", "start"])
            .current_dir(&self.inner.paths.workspace)
            .status()
            .await
            .context("failed to start codex app-server daemon")?;
        if !status.success() {
            return Err(anyhow!("codex app-server daemon start failed: {status}"));
        }
        Ok(())
    }

    fn app_server_args(&self) -> Vec<&'static str> {
        match self.inner.config.codex_app_server_mode {
            AppServerMode::Direct => vec!["app-server"],
            AppServerMode::Proxy => vec!["app-server", "proxy"],
        }
    }

    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let id_value = json!(id);
        let key = id.to_string();
        let mut message = json!({ "id": id, "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(key.clone(), tx);
        if let Err(err) = self.write_json(message).await {
            self.inner.pending.lock().await.remove(&key);
            return Err(err);
        }
        match rx.await.context("codex response sender dropped")? {
            Ok(value) => Ok(value),
            Err(error) => {
                let _ = id_value;
                Err(anyhow!(error))
            }
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        let mut message = json!({ "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_json(message).await
    }

    async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write_json(json!({ "id": id, "result": result })).await
    }

    async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<()> {
        self.write_json(json!({ "id": id, "error": { "code": code, "message": message } }))
            .await
    }

    async fn write_json(&self, message: Value) -> Result<()> {
        let line = format!("{message}\n");
        let mut stdin_guard = self.inner.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| anyhow!("codex app-server stdin unavailable"))?;
        stdin
            .write_all(line.as_bytes())
            .await
            .context("failed to write codex rpc message")
    }

    fn spawn_stdout_reader(&self, stdout: tokio::process::ChildStdout) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    this.inner
                        .logger
                        .warn(format!("Ignoring non-JSON app-server line: {line}"))
                        .await;
                    continue;
                };
                this.handle_message(message).await;
            }
            *this.inner.status.lock().await = AppServerStatus::Stopped;
            *this.inner.last_error.lock().await =
                Some("codex app-server stdout closed".to_string());
        });
    }

    fn spawn_stderr_reader(&self, stderr: tokio::process::ChildStderr) {
        let logger = self.inner.logger.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logger.debug(format!("[codex stderr] {line}")).await;
            }
        });
    }

    async fn handle_message(&self, message: Value) {
        if message.get("id").is_some() && message.get("method").is_some() {
            self.handle_server_request(message).await;
            return;
        }
        if let Some(id) = message.get("id") {
            let key = rpc_id_key(id);
            let tx = self.inner.pending.lock().await.remove(&key);
            if let Some(tx) = tx {
                let result = if let Some(error) = message.get("error") {
                    Err(get_string_at(error, &["message"])
                        .unwrap_or_else(|| "codex request failed".to_string()))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(result);
            }
            return;
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            self.handle_notification(
                method,
                message.get("params").cloned().unwrap_or(Value::Null),
            )
            .await;
        }
    }

    async fn handle_notification(&self, method: &str, params: Value) {
        match method {
            "turn/started" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    if let Some(turn) = self.inner.active_turns.lock().await.get_mut(&thread_id) {
                        turn.turn_id = extract_turn_id(&params);
                    }
                    self.inner
                        .logger
                        .info(format!(
                            "codex turn/started thread={}{}",
                            thread_id,
                            extract_turn_id(&params)
                                .map(|turn_id| format!(" turn={turn_id}"))
                                .unwrap_or_default()
                        ))
                        .await;
                }
            }
            "item/agentMessage/delta" => {
                if let Some(text) = extract_delta_text(&params) {
                    self.append_to_turn(&params, text, false).await;
                }
            }
            "item/completed" => {
                if let Some(text) = extract_completed_agent_text(&params) {
                    self.append_to_turn(&params, text, true).await;
                }
            }
            "turn/completed" => self.complete_turn(&params).await,
            "turn/failed" | "error" => {
                let message = extract_error_message(&params).unwrap_or_else(|| method.to_string());
                self.fail_latest_turn(message).await;
            }
            _ => {}
        }
    }

    async fn append_to_turn(&self, params: &Value, text: String, only_if_empty: bool) {
        let thread_id = extract_thread_id(params);
        let mut active = self.inner.active_turns.lock().await;
        let key = thread_id.or_else(|| active.keys().next().cloned());
        if let Some(key) = key {
            if let Some(turn) = active.get_mut(&key) {
                if only_if_empty && !turn.chunks.is_empty() {
                    return;
                }
                turn.chunks.push(text);
            }
        }
    }

    async fn complete_turn(&self, params: &Value) {
        let thread_id = extract_thread_id(params);
        let mut active = self.inner.active_turns.lock().await;
        let key = thread_id.or_else(|| active.keys().next().cloned());
        let Some(key) = key else {
            return;
        };
        let Some(mut turn) = active.remove(&key) else {
            return;
        };
        drop(active);
        self.clear_pending_approvals_for_thread(&key).await;
        *self.inner.last_completed_turn_at.lock().await =
            Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let text = turn.chunks.join("").trim().to_string();
        self.inner
            .logger
            .info(format!(
                "codex turn/completed thread={} responseChars={}",
                key,
                text.chars().count()
            ))
            .await;
        if let Some(tx) = turn.tx.take() {
            let _ = tx.send(Ok(if text.is_empty() {
                "Codex 本轮没有返回文本。".to_string()
            } else {
                text
            }));
        }
    }

    async fn fail_latest_turn(&self, error: String) {
        let mut active = self.inner.active_turns.lock().await;
        let key = active.keys().next().cloned();
        if let Some(key) = key {
            if let Some(mut turn) = active.remove(&key) {
                self.inner
                    .logger
                    .error(format!("codex turn failed thread={key}: {error}"))
                    .await;
                if let Some(tx) = turn.tx.take() {
                    let _ = tx.send(Err(error));
                }
            }
        }
    }

    async fn handle_server_request(&self, request: Value) {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if is_approval_request(&method) {
            let key = rpc_id_key(&id);
            self.inner
                .pending_approvals
                .lock()
                .await
                .insert(key, request.clone());
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            let approval = CodexApprovalRequest {
                id: id.clone(),
                method: method.clone(),
                thread_id: extract_thread_id(&params),
                turn_id: extract_turn_id(&params),
                message: format_approval_message(&method, &params),
            };
            if self.inner.approval_tx.send(approval).await.is_err() {
                self.inner
                    .pending_approvals
                    .lock()
                    .await
                    .remove(&rpc_id_key(&id));
                let _ = self
                    .respond(
                        id,
                        approval_response_for(&request, CodexApprovalDecision::Decline),
                    )
                    .await;
            }
            return;
        }
        match method.as_str() {
            "item/tool/requestUserInput" => {
                let _ = self.respond(id, json!({ "answers": {} })).await;
            }
            "mcpServer/elicitation/request" => {
                let _ = self
                    .respond(
                        id,
                        json!({ "action": "cancel", "content": null, "_meta": null }),
                    )
                    .await;
            }
            "item/tool/call" => {
                let _ = self
                    .respond(
                        id,
                        json!({
                            "contentItems": [{ "type": "inputText", "text": "Codex Claw does not support app-server initiated tool calls." }],
                            "success": false
                        }),
                    )
                    .await;
            }
            _ => {
                let _ = self
                    .respond_error(
                        id,
                        -32601,
                        &format!("Unsupported app-server request: {method}"),
                    )
                    .await;
            }
        }
    }

    async fn decline_pending_approvals_for_thread(&self, thread_id: &str, _reason: &str) {
        let mut to_decline = Vec::new();
        let mut approvals = self.inner.pending_approvals.lock().await;
        for (id, request) in approvals.iter() {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            if extract_thread_id(&params).as_deref() == Some(thread_id) {
                to_decline.push(id.clone());
            }
        }
        let requests: Vec<Value> = to_decline
            .into_iter()
            .filter_map(|id| approvals.remove(&id))
            .collect();
        drop(approvals);
        for request in requests {
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            let _ = self
                .respond(
                    id,
                    approval_response_for(&request, CodexApprovalDecision::Decline),
                )
                .await;
        }
    }

    async fn clear_pending_approvals_for_thread(&self, thread_id: &str) {
        let mut approvals = self.inner.pending_approvals.lock().await;
        approvals.retain(|_, request| {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            extract_thread_id(&params).as_deref() != Some(thread_id)
        });
    }
}

fn add_optional(params: &mut Value, key: &str, value: Option<String>) {
    if let Some(value) = value {
        params[key] = json!(value);
    }
}

fn rpc_id_key(id: &Value) -> String {
    id.as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| id.to_string())
}

fn is_approval_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "applyPatchApproval"
            | "execCommandApproval"
    )
}

fn approval_response_for(request: &Value, decision: CodexApprovalDecision) -> Value {
    let accepted = matches!(decision, CodexApprovalDecision::Accept);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "item/permissions/requestApproval" if accepted => {
            let permissions = request
                .get("params")
                .and_then(|params| params.get("permissions"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            json!({ "permissions": permissions, "scope": "turn", "strictAutoReview": false })
        }
        "item/permissions/requestApproval" => {
            json!({ "permissions": {}, "scope": "turn", "strictAutoReview": true })
        }
        "applyPatchApproval" | "execCommandApproval" => {
            json!({ "decision": if accepted { "approved" } else { "denied" } })
        }
        _ => json!({ "decision": if accepted { "accept" } else { "decline" } }),
    }
}

fn format_approval_message(method: &str, params: &Value) -> String {
    let mut lines = vec![
        "Codex 请求权限审批：".to_string(),
        format!("method: {method}"),
    ];
    push_optional(&mut lines, "cwd", get_string_at(params, &["cwd"]));
    push_optional(&mut lines, "reason", get_string_at(params, &["reason"]));
    push_optional(&mut lines, "command", format_command(params));
    push_optional(
        &mut lines,
        "files",
        get_array_at(params, &["files"]).map(|files| {
            if files.iter().all(Value::is_string) {
                files
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                Value::Array(files.clone()).to_string()
            }
        }),
    );
    push_optional(
        &mut lines,
        "permissions",
        params.get("permissions").map(Value::to_string),
    );
    lines.push("1: accept 2: decline".to_string());
    lines.join("\n")
}

fn push_optional(lines: &mut Vec<String>, label: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        lines.push(format!("{label}: {value}"));
    }
}

fn format_command(params: &Value) -> Option<String> {
    get_array_at(params, &["command"]).map(|command| {
        if command.iter().all(Value::is_string) {
            command
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            Value::Array(command.clone()).to_string()
        }
    })
}
