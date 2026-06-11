use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub home: String,
    pub channel: String,
    pub channel_tmp: String,
    pub channel_credentials: String,
    pub workspace: String,
    pub state: String,
    pub logs: String,
}

#[derive(Clone, Debug)]
pub struct ClawConfig {
    pub repo_root: String,
    pub codex_app_path: String,
    pub codex_bin: String,
    pub codex_app_server_mode: AppServerMode,
    pub codex_app_launch_wait_ms: u64,
    pub codex_daemon_start: bool,
    pub turn_timeout_ms: u64,
    pub coalesce_ms: u64,
    pub max_pending_messages_per_sender: usize,
    pub max_pending_chars_per_sender: usize,
    pub max_reply_chars: usize,
    pub codex_model: Option<String>,
    pub codex_sandbox: Option<String>,
    pub codex_approval_policy: Option<String>,
    pub codex_approvals_reviewer: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppServerMode {
    Direct,
    Proxy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InboundWeixinMessage {
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub from: String,
    pub to: Option<String>,
    pub text: String,
    #[serde(rename = "contextToken")]
    pub context_token: Option<String>,
    #[serde(rename = "hasMedia")]
    pub has_media: bool,
    pub timestamp: Option<i64>,
    pub raw: Option<serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppServerStatus {
    Starting,
    Ready,
    Busy,
    Stopped,
}

#[derive(Clone, Debug)]
pub struct AppServerStatusSnapshot {
    pub pid: Option<u32>,
    pub status: AppServerStatus,
    pub active_turns: usize,
    pub known_threads: usize,
    pub last_error: Option<String>,
    pub last_completed_turn_at: Option<String>,
}
