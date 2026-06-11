use crate::types::{AppServerStatus, AppServerStatusSnapshot};

pub struct CommandStatus {
    pub channel_ready: bool,
    pub channel_account_id: Option<String>,
    pub channel_last_error: Option<String>,
    pub codex: AppServerStatusSnapshot,
    pub pending: usize,
}

pub fn handle_command(text: &str, status: impl FnOnce() -> CommandStatus) -> CommandAction {
    let command = text.trim();
    if !command.starts_with('/') {
        return CommandAction::None;
    }
    match command {
        "/help" => CommandAction::Reply(
            [
                "可用命令：",
                "/help - 显示帮助",
                "/status - 显示运行状态",
                "/new - 开始新会话",
                "/reset - 开始新会话",
                "/新会话 - 开始新会话",
            ]
            .join("\n"),
        ),
        "/status" => CommandAction::Reply(format_status(status())),
        "/new" | "/reset" | "/新会话" => CommandAction::ResetAndReply(
            "已重置当前微信用户的 Codex 会话。下一条普通消息会创建新 thread。".to_string(),
        ),
        _ => CommandAction::None,
    }
}

pub enum CommandAction {
    None,
    Reply(String),
    ResetAndReply(String),
}

fn format_status(status: CommandStatus) -> String {
    let codex_status = match status.codex.status {
        AppServerStatus::Starting => "starting",
        AppServerStatus::Ready => "ready",
        AppServerStatus::Busy => "busy",
        AppServerStatus::Stopped => "stopped",
    };
    [
        format!(
            "channel: {}{}",
            if status.channel_ready {
                "ready"
            } else {
                "not ready"
            },
            status
                .channel_account_id
                .map(|account| format!(" ({account})"))
                .unwrap_or_default()
        ),
        format!(
            "codex: {}{}",
            codex_status,
            status
                .codex
                .pid
                .map(|pid| format!(" pid={pid}"))
                .unwrap_or_default()
        ),
        format!("activeTurns: {}", status.codex.active_turns),
        format!("knownThreads: {}", status.codex.known_threads),
        format!("pendingForYou: {}", status.pending),
        status
            .channel_last_error
            .map(|error| format!("channelLastError: {error}"))
            .unwrap_or_default(),
        status
            .codex
            .last_error
            .map(|error| format!("codexLastError: {error}"))
            .unwrap_or_default(),
        status
            .codex
            .last_completed_turn_at
            .map(|time| format!("lastCompletedTurnAt: {time}"))
            .unwrap_or_default(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}
