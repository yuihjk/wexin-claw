use std::{env, fs, path::PathBuf};

use anyhow::{Context, Result};

use crate::types::{AppPaths, AppServerMode, ClawConfig};

pub fn load_config() -> Result<(AppPaths, ClawConfig)> {
    let home = resolve_home();
    let paths = build_paths(home);
    ensure_home_layout(&paths)?;
    env::set_current_dir(&paths.home).context("failed to chdir to CODEX_CLAW_HOME")?;

    let codex_app_path =
        env_string("CODEX_CLAW_CODEX_APP").unwrap_or_else(|| "/Applications/Codex.app".to_string());
    let codex_bin = env_string("CODEX_CLAW_CODEX_BIN")
        .unwrap_or_else(|| format!("{codex_app_path}/Contents/Resources/codex"));

    let config = ClawConfig {
        repo_root: resolve_repo_root()?,
        codex_app_path,
        codex_bin,
        codex_app_server_mode: parse_app_server_mode(env_string(
            "CODEX_CLAW_CODEX_APP_SERVER_MODE",
        )),
        codex_app_launch_wait_ms: env_u64("CODEX_CLAW_CODEX_APP_LAUNCH_WAIT_MS", 2_000),
        codex_daemon_start: env_bool("CODEX_CLAW_CODEX_DAEMON_START", false),
        turn_timeout_ms: env_u64("CODEX_CLAW_TURN_TIMEOUT_MS", 10 * 60_000),
        coalesce_ms: env_u64("CODEX_CLAW_COALESCE_MS", 1_500),
        max_pending_messages_per_sender: env_usize(
            "CODEX_CLAW_MAX_PENDING_MESSAGES_PER_SENDER",
            20,
        ),
        max_pending_chars_per_sender: env_usize("CODEX_CLAW_MAX_PENDING_CHARS_PER_SENDER", 8_000),
        max_reply_chars: env_usize("CODEX_CLAW_MAX_REPLY_CHARS", 1_500),
        codex_model: env_string("CODEX_CLAW_CODEX_MODEL"),
        codex_sandbox: parse_sandbox(env_string("CODEX_CLAW_CODEX_SANDBOX")),
        codex_approval_policy: env_string("CODEX_CLAW_CODEX_APPROVAL_POLICY"),
        codex_approvals_reviewer: parse_approvals_reviewer(env_string(
            "CODEX_CLAW_CODEX_APPROVALS_REVIEWER",
        )),
    };
    Ok((paths, config))
}

pub fn build_paths(home: String) -> AppPaths {
    AppPaths {
        channel: format!("{home}/channel"),
        channel_tmp: format!("{home}/channel/tmp"),
        channel_credentials: format!("{home}/channel/credentials"),
        workspace: format!("{home}/workspace"),
        state: format!("{home}/state"),
        logs: format!("{home}/logs"),
        home,
    }
}

fn ensure_home_layout(paths: &AppPaths) -> Result<()> {
    for dir in [
        &paths.home,
        &paths.channel,
        &paths.channel_tmp,
        &paths.channel_credentials,
        &paths.workspace,
        &paths.state,
        &paths.logs,
    ] {
        fs::create_dir_all(dir).with_context(|| format!("failed to create directory {dir}"))?;
    }
    Ok(())
}

fn resolve_home() -> String {
    if let Some(home) = env_string("CODEX_CLAW_HOME") {
        return absolutize(home);
    }
    let user_home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    absolutize(format!("{user_home}/.codex-claw"))
}

fn resolve_repo_root() -> Result<String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .context("xclaw manifest has no parent directory")?;
    Ok(root.to_string_lossy().to_string())
}

fn absolutize(path: String) -> String {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path.to_string_lossy().to_string()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
            .to_string_lossy()
            .to_string()
    }
}

fn env_string(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env_string(name)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_usize(name: &str, fallback: usize) -> usize {
    env_string(name)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_bool(name: &str, fallback: bool) -> bool {
    match env_string(name).map(|value| value.to_ascii_lowercase()) {
        Some(value) if ["1", "true", "yes", "on"].contains(&value.as_str()) => true,
        Some(value) if ["0", "false", "no", "off"].contains(&value.as_str()) => false,
        _ => fallback,
    }
}

fn parse_app_server_mode(value: Option<String>) -> AppServerMode {
    if value.as_deref() == Some("proxy") {
        AppServerMode::Proxy
    } else {
        AppServerMode::Direct
    }
}

fn parse_sandbox(value: Option<String>) -> Option<String> {
    value
        .filter(|item| {
            ["read-only", "workspace-write", "danger-full-access"].contains(&item.as_str())
        })
        .or_else(|| Some("workspace-write".to_string()))
}

fn parse_approvals_reviewer(value: Option<String>) -> Option<String> {
    value
        .filter(|item| ["user", "auto_review"].contains(&item.as_str()))
        .or_else(|| Some("auto_review".to_string()))
}
