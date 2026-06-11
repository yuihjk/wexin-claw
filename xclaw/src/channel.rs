use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc, oneshot},
    time::{Duration, timeout},
};

use crate::{
    logger::Logger,
    protocol::short_id,
    types::{AppPaths, ClawConfig, InboundWeixinMessage},
};

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ChannelEvent {
    #[serde(rename = "ready")]
    Ready {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    #[serde(rename = "message")]
    Message { message: InboundWeixinMessage },
    #[serde(rename = "error")]
    Error { error: String },
    #[serde(rename = "stopped")]
    Stopped,
}

#[derive(Debug, Deserialize)]
struct ChannelResponse {
    id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Clone)]
pub struct ChannelSupervisor {
    inner: Arc<ChannelInner>,
}

struct ChannelInner {
    config: ClawConfig,
    paths: AppPaths,
    logger: Logger,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    messages_tx: mpsc::Sender<InboundWeixinMessage>,
    messages_rx: Mutex<Option<mpsc::Receiver<InboundWeixinMessage>>>,
    next_id: AtomicU64,
    ready: Mutex<bool>,
    account_id: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
}

impl ChannelSupervisor {
    pub fn new(config: ClawConfig, paths: AppPaths, logger: Logger) -> Self {
        let (messages_tx, messages_rx) = mpsc::channel(100);
        Self {
            inner: Arc::new(ChannelInner {
                config,
                paths,
                logger,
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                messages_tx,
                messages_rx: Mutex::new(Some(messages_rx)),
                next_id: AtomicU64::new(1),
                ready: Mutex::new(false),
                account_id: Mutex::new(None),
                last_error: Mutex::new(None),
            }),
        }
    }

    pub async fn take_message_receiver(&self) -> Result<mpsc::Receiver<InboundWeixinMessage>> {
        self.inner
            .messages_rx
            .lock()
            .await
            .take()
            .ok_or_else(|| anyhow!("channel message receiver already taken"))
    }

    pub async fn start(&self) -> Result<()> {
        if self.inner.child.lock().await.is_some() {
            return Ok(());
        }
        self.inner
            .logger
            .info("channel worker starting via pnpm --filter codex-claw channel-worker")
            .await;
        let mut child = Command::new("pnpm")
            .arg("--filter")
            .arg("codex-claw")
            .arg("channel-worker")
            .current_dir(&self.inner.config.repo_root)
            .env("CODEX_CLAW_CHANNEL_TRANSPORT", "stdio")
            .env("CODEX_CLAW_HOME", &self.inner.paths.home)
            .env("OPENCLAW_STATE_DIR", &self.inner.paths.channel)
            .env("OPENCLAW_TMP_DIR", &self.inner.paths.channel_tmp)
            .env("OPENCLAW_OAUTH_DIR", &self.inner.paths.channel_credentials)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to spawn channel worker")?;

        let stdout = child
            .stdout
            .take()
            .context("channel worker stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("channel worker stderr unavailable")?;
        *self.inner.stdin.lock().await = child.stdin.take();
        *self.inner.child.lock().await = Some(child);

        self.spawn_stdout_reader(stdout);
        self.spawn_stderr_reader(stderr);

        timeout(Duration::from_secs(120), async {
            loop {
                if *self.inner.ready.lock().await {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .context("timed out waiting for channel worker")?
    }

    pub async fn stop(&self) {
        let _ = timeout(Duration::from_secs(3), self.request("stop", None)).await;
        if let Some(mut child) = self.inner.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }

    pub async fn send_text(&self, to: &str, text: &str) -> Result<()> {
        self.inner
            .logger
            .info(format!(
                "channel sendText requested to={} chars={}",
                short_id(to),
                text.chars().count()
            ))
            .await;
        self.request("sendText", Some(json!({ "to": to, "text": text })))
            .await?;
        Ok(())
    }

    pub async fn send_typing(&self, to: &str) -> Result<()> {
        self.request("sendTyping", Some(json!({ "to": to })))
            .await?;
        Ok(())
    }

    pub async fn status(&self) -> ChannelStatus {
        ChannelStatus {
            ready: *self.inner.ready.lock().await,
            account_id: self.inner.account_id.lock().await.clone(),
            last_error: self.inner.last_error.lock().await.clone(),
        }
    }

    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = self
            .inner
            .next_id
            .fetch_add(1, Ordering::SeqCst)
            .to_string();
        let mut message = json!({ "id": id, "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id.clone(), tx);
        let line = format!("{message}\n");
        let mut stdin_guard = self.inner.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| anyhow!("channel worker stdin unavailable"))?;
        if let Err(err) = stdin.write_all(line.as_bytes()).await {
            self.inner.pending.lock().await.remove(&id);
            return Err(err).context("failed to write channel request");
        }
        match rx.await.context("channel response sender dropped")? {
            Ok(value) => Ok(value),
            Err(error) => Err(anyhow!(error)),
        }
    }

    fn spawn_stdout_reader(&self, stdout: tokio::process::ChildStdout) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    inner
                        .logger
                        .warn(format!("Ignoring non-JSON channel line: {line}"))
                        .await;
                    continue;
                };
                if value.get("id").is_some() && value.get("ok").is_some() {
                    if let Ok(response) = serde_json::from_value::<ChannelResponse>(value) {
                        let tx = inner.pending.lock().await.remove(&response.id);
                        if let Some(tx) = tx {
                            let result = if response.ok {
                                Ok(response.result.unwrap_or(Value::Null))
                            } else {
                                Err(response
                                    .error
                                    .unwrap_or_else(|| "channel request failed".to_string()))
                            };
                            let _ = tx.send(result);
                        }
                    }
                    continue;
                }
                if let Ok(event) = serde_json::from_value::<ChannelEvent>(value) {
                    handle_event(inner.clone(), event).await;
                }
            }
            *inner.ready.lock().await = false;
            *inner.last_error.lock().await = Some("channel worker stdout closed".to_string());
        });
    }

    fn spawn_stderr_reader(&self, stderr: tokio::process::ChildStderr) {
        let logger = self.inner.logger.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logger.debug(format!("[channel stderr] {line}")).await;
            }
        });
    }
}

async fn handle_event(inner: Arc<ChannelInner>, event: ChannelEvent) {
    match event {
        ChannelEvent::Ready { account_id } => {
            *inner.ready.lock().await = true;
            *inner.account_id.lock().await = Some(account_id.clone());
            inner
                .logger
                .info(format!("channel worker ready account={account_id}"))
                .await;
        }
        ChannelEvent::Message { message } => {
            inner
                .logger
                .info(format!(
                    "channel inbound message from={} message={} chars={} hasMedia={}",
                    short_id(&message.from),
                    message.message_id,
                    message.text.chars().count(),
                    message.has_media
                ))
                .await;
            let _ = inner.messages_tx.send(message).await;
        }
        ChannelEvent::Error { error } => {
            *inner.last_error.lock().await = Some(error.clone());
            inner
                .logger
                .error(format!("channel worker error: {error}"))
                .await;
        }
        ChannelEvent::Stopped => {
            *inner.ready.lock().await = false;
            inner.logger.warn("channel worker stopped").await;
        }
    }
}

#[derive(Clone, Debug)]
pub struct ChannelStatus {
    pub ready: bool,
    pub account_id: Option<String>,
    pub last_error: Option<String>,
}
