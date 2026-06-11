use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use tokio::{
    sync::{Mutex, RwLock, mpsc},
    time::Duration,
};

use crate::{
    channel::ChannelSupervisor,
    codex::{CodexAppServerClient, CodexApprovalDecision, CodexApprovalRequest},
    commands::{CommandAction, CommandStatus, handle_command},
    logger::Logger,
    protocol::short_id,
    text::{merge_waiting_messages, pending_char_count, split_reply},
    thread_store::ThreadStore,
    types::{ClawConfig, InboundWeixinMessage},
};

#[derive(Default)]
struct SenderState {
    running: bool,
    pending: Vec<String>,
    pending_notified: bool,
}

#[derive(Clone)]
pub struct MessageRouter {
    inner: Arc<RouterInner>,
}

struct RouterInner {
    config: ClawConfig,
    channel: ChannelSupervisor,
    codex: CodexAppServerClient,
    thread_store: Arc<RwLock<ThreadStore>>,
    logger: Logger,
    queues: Mutex<HashMap<String, SenderState>>,
    pending_approvals: Mutex<HashMap<String, CodexApprovalRequest>>,
}

impl MessageRouter {
    pub fn new(
        config: ClawConfig,
        channel: ChannelSupervisor,
        codex: CodexAppServerClient,
        thread_store: Arc<RwLock<ThreadStore>>,
        logger: Logger,
    ) -> Self {
        Self {
            inner: Arc::new(RouterInner {
                config,
                channel,
                codex,
                thread_store,
                logger,
                queues: Mutex::new(HashMap::new()),
                pending_approvals: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn run_messages(&self, mut rx: mpsc::Receiver<InboundWeixinMessage>) {
        while let Some(message) = rx.recv().await {
            let router = self.clone();
            tokio::spawn(async move {
                if let Err(err) = router.handle_inbound(message).await {
                    router
                        .inner
                        .logger
                        .error(format!("message handler failed: {err}"))
                        .await;
                }
            });
        }
    }

    pub async fn run_approvals(&self, mut rx: mpsc::Receiver<CodexApprovalRequest>) {
        while let Some(request) = rx.recv().await {
            if let Err(err) = self.handle_approval_request(request).await {
                self.inner
                    .logger
                    .error(format!("approval handler failed: {err}"))
                    .await;
            }
        }
    }

    async fn handle_inbound(&self, message: InboundWeixinMessage) -> Result<()> {
        let text = message.text.trim().to_string();
        self.inner
            .logger
            .info(format!(
                "router inbound from={} message={} rawChars={} trimmedChars={} text={:?}",
                short_id(&message.from),
                message.message_id,
                message.text.chars().count(),
                text.chars().count(),
                text
            ))
            .await;
        if text.is_empty() {
            return Ok(());
        }
        if self.handle_approval_reply(&message.from, &text).await? {
            return Ok(());
        }
        if self.handle_command(&message.from, &text).await? {
            return Ok(());
        }
        self.enqueue(message.from, text).await;
        Ok(())
    }

    async fn handle_command(&self, sender_id: &str, text: &str) -> Result<bool> {
        if !text.trim().starts_with('/') {
            return Ok(false);
        }
        let status = if text.trim() == "/status" {
            let channel = self.inner.channel.status().await;
            let codex = self.inner.codex.status().await;
            let pending = self.pending_count(sender_id).await;
            Some(CommandStatus {
                channel_ready: channel.ready,
                channel_account_id: channel.account_id,
                channel_last_error: channel.last_error,
                codex,
                pending,
            })
        } else {
            None
        };
        let action = handle_command(text, || status.expect("status requested"));
        match action {
            CommandAction::None => Ok(false),
            CommandAction::Reply(reply) => {
                self.inner.channel.send_text(sender_id, &reply).await?;
                Ok(true)
            }
            CommandAction::ResetAndReply(reply) => {
                self.inner.thread_store.write().await.delete(sender_id)?;
                self.reset_queue(sender_id).await;
                self.inner.channel.send_text(sender_id, &reply).await?;
                Ok(true)
            }
        }
    }

    async fn enqueue(&self, sender_id: String, text: String) {
        let mut queues = self.inner.queues.lock().await;
        let state = queues.entry(sender_id.clone()).or_default();
        if state.running {
            self.inner
                .logger
                .info(format!(
                    "queue pending sender={} chars={} pending={}",
                    short_id(&sender_id),
                    text.chars().count(),
                    state.pending.len() + 1
                ))
                .await;
            state.pending.push(text);
            let dropped = trim_pending(
                state,
                self.inner.config.max_pending_messages_per_sender,
                self.inner.config.max_pending_chars_per_sender,
            );
            if !state.pending_notified {
                state.pending_notified = true;
                let channel = self.inner.channel.clone();
                let sender = sender_id.clone();
                tokio::spawn(async move {
                    let _ = channel
                        .send_text(&sender, "Codex 还在处理上一条消息，已把这条加入等待合并。")
                        .await;
                });
            }
            if dropped > 0 {
                let channel = self.inner.channel.clone();
                let sender = sender_id.clone();
                tokio::spawn(async move {
                    let _ = channel
                        .send_text(&sender, "等待队列太长，已丢弃较早的待处理消息。")
                        .await;
                });
            }
            return;
        }
        state.running = true;
        self.inner
            .logger
            .info(format!(
                "queue start sender={} chars={}",
                short_id(&sender_id),
                text.chars().count()
            ))
            .await;
        drop(queues);
        let router = self.clone();
        tokio::spawn(async move {
            router.run_sender_loop(sender_id, text).await;
        });
    }

    async fn run_sender_loop(&self, sender_id: String, mut next_text: String) {
        loop {
            self.process_codex_message(&sender_id, &next_text).await;
            if self.inner.config.coalesce_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.inner.config.coalesce_ms)).await;
            }
            let mut queues = self.inner.queues.lock().await;
            let state = queues.entry(sender_id.clone()).or_default();
            if state.pending.is_empty() {
                state.running = false;
                state.pending_notified = false;
                self.inner
                    .logger
                    .info(format!("queue idle sender={}", short_id(&sender_id)))
                    .await;
                break;
            }
            let pending = std::mem::take(&mut state.pending);
            state.pending_notified = false;
            drop(queues);
            next_text = merge_waiting_messages(&pending);
            if next_text.is_empty() {
                self.inner
                    .logger
                    .warn(format!(
                        "queue merged empty sender={} count={}",
                        short_id(&sender_id),
                        pending.len()
                    ))
                    .await;
                break;
            }
            self.inner
                .logger
                .info(format!(
                    "queue merged sender={} count={} chars={}",
                    short_id(&sender_id),
                    pending.len(),
                    next_text.chars().count()
                ))
                .await;
        }
    }

    async fn process_codex_message(&self, sender_id: &str, text: &str) {
        self.inner
            .logger
            .info(format!(
                "router codex processing start sender={} chars={} text={:?}",
                short_id(sender_id),
                text.chars().count(),
                text
            ))
            .await;
        let result = async {
            self.inner.channel.send_typing(sender_id).await.ok();
            let thread_id = self.resolve_thread(sender_id).await?;
            self.inner
                .logger
                .info(format!(
                    "router codex thread resolved sender={} thread={}",
                    short_id(sender_id),
                    thread_id
                ))
                .await;
            let response = self.inner.codex.run_turn(&thread_id, text).await?;
            let chunks = split_reply(&response, self.inner.config.max_reply_chars);
            self.inner
                .logger
                .info(format!(
                    "router codex response sender={} thread={} responseChars={} chunks={}",
                    short_id(sender_id),
                    thread_id,
                    response.chars().count(),
                    chunks.len()
                ))
                .await;
            if chunks.is_empty() {
                self.inner
                    .channel
                    .send_text(sender_id, "Codex 本轮没有返回文本。")
                    .await?;
            } else {
                for chunk in chunks {
                    self.inner.channel.send_text(sender_id, &chunk).await?;
                }
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;

        if let Err(err) = result {
            self.inner
                .logger
                .error(format!("Codex turn failed for sender={sender_id}: {err}"))
                .await;
            let _ = self
                .inner
                .channel
                .send_text(sender_id, &format!("Codex 处理失败：{err}"))
                .await;
        }
        self.inner.pending_approvals.lock().await.remove(sender_id);
    }

    async fn resolve_thread(&self, sender_id: &str) -> Result<String> {
        let existing = {
            let store = self.inner.thread_store.read().await;
            store.get(sender_id)
        };
        if let Some(existing) = existing {
            match self.inner.codex.resume_thread(&existing).await {
                Ok(resumed) => {
                    {
                        let mut store = self.inner.thread_store.write().await;
                        store.set(sender_id, resumed.clone())?;
                    }
                    return Ok(resumed);
                }
                Err(err) => {
                    self.inner
                        .logger
                        .warn(format!(
                            "thread resume failed sender={} thread={}: {err}",
                            short_id(sender_id),
                            existing
                        ))
                        .await;
                }
            }
        }
        let created = self.inner.codex.start_thread().await?;
        {
            let mut store = self.inner.thread_store.write().await;
            store.set(sender_id, created.clone())?;
        }
        self.inner
            .logger
            .info(format!(
                "created thread sender={} thread={}",
                short_id(sender_id),
                created
            ))
            .await;
        Ok(created)
    }

    async fn handle_approval_request(&self, request: CodexApprovalRequest) -> Result<()> {
        let sender_id = if let Some(thread_id) = &request.thread_id {
            self.inner
                .thread_store
                .read()
                .await
                .find_sender_by_thread(thread_id)
        } else {
            None
        };
        let Some(sender_id) = sender_id else {
            self.inner
                .codex
                .resolve_approval(&request.id, CodexApprovalDecision::Decline)
                .await;
            return Ok(());
        };
        self.inner
            .pending_approvals
            .lock()
            .await
            .insert(sender_id.clone(), request.clone());
        self.inner
            .logger
            .info(format!(
                "approval request sent sender={} method={}",
                short_id(&sender_id),
                request.method
            ))
            .await;
        self.inner
            .channel
            .send_text(&sender_id, &request.message)
            .await?;
        Ok(())
    }

    async fn handle_approval_reply(&self, sender_id: &str, text: &str) -> Result<bool> {
        let request = self
            .inner
            .pending_approvals
            .lock()
            .await
            .get(sender_id)
            .cloned();
        let Some(request) = request else {
            return Ok(false);
        };
        if let Some(decision) = parse_approval_choice(text) {
            self.inner
                .codex
                .resolve_approval(&request.id, decision)
                .await;
            self.inner.pending_approvals.lock().await.remove(sender_id);
            return Ok(true);
        }
        if let (Some(thread_id), Some(turn_id)) = (&request.thread_id, &request.turn_id) {
            if let Err(err) = self.inner.codex.steer_turn(thread_id, turn_id, text).await {
                self.inner
                    .channel
                    .send_text(
                        sender_id,
                        &format!("发送用户意见失败：{err}\n请回复：\n1: accept 2: decline"),
                    )
                    .await?;
            }
        } else {
            self.inner
                .channel
                .send_text(sender_id, "当前审批请求缺少 turnId，无法把这条消息作为用户意见发送。请回复：\n1: accept 2: decline")
                .await?;
        }
        Ok(true)
    }

    async fn reset_queue(&self, sender_id: &str) {
        let mut queues = self.inner.queues.lock().await;
        let state = queues.entry(sender_id.to_string()).or_default();
        state.pending.clear();
        state.pending_notified = false;
    }

    async fn pending_count(&self, sender_id: &str) -> usize {
        self.inner
            .queues
            .lock()
            .await
            .get(sender_id)
            .map(|state| state.pending.len())
            .unwrap_or(0)
    }
}

fn trim_pending(state: &mut SenderState, max_messages: usize, max_chars: usize) -> usize {
    let mut dropped = 0;
    while state.pending.len() > max_messages {
        state.pending.remove(0);
        dropped += 1;
    }
    while pending_char_count(&state.pending) > max_chars && state.pending.len() > 1 {
        state.pending.remove(0);
        dropped += 1;
    }
    dropped
}

fn parse_approval_choice(text: &str) -> Option<CodexApprovalDecision> {
    match text.trim().to_ascii_lowercase().as_str() {
        "1" | "accept" => Some(CodexApprovalDecision::Accept),
        "2" | "decline" => Some(CodexApprovalDecision::Decline),
        _ => None,
    }
}
