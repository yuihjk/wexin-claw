use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::Arc,
};

use chrono::{Datelike, Duration, Utc};
use serde_json::json;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Logger {
    log_dir: String,
    debug: bool,
    lock: Arc<Mutex<()>>,
}

impl Logger {
    pub fn new(log_dir: String) -> Self {
        let logger = Self {
            log_dir,
            debug: std::env::var("CODEX_CLAW_DEBUG").ok().as_deref() == Some("1"),
            lock: Arc::new(Mutex::new(())),
        };
        logger.cleanup_old_logs();
        logger
    }

    pub async fn info(&self, message: impl AsRef<str>) {
        self.write("INFO", message.as_ref()).await;
    }

    pub async fn warn(&self, message: impl AsRef<str>) {
        self.write("WARN", message.as_ref()).await;
    }

    pub async fn error(&self, message: impl AsRef<str>) {
        self.write("ERROR", message.as_ref()).await;
    }

    pub async fn debug(&self, message: impl AsRef<str>) {
        if self.debug {
            self.write("DEBUG", message.as_ref()).await;
        }
    }

    fn cleanup_old_logs(&self) {
        let retention = std::env::var("CODEX_CLAW_LOG_RETENTION_DAYS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(7);
        if retention <= 0 {
            return;
        }
        let cutoff = Utc::now().date_naive() - Duration::days(retention);
        let Ok(entries) = fs::read_dir(&self.log_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("codex-claw-") || !name.ends_with(".log") {
                continue;
            }
            let date = &name["codex-claw-".len()..name.len() - ".log".len()];
            let Ok(file_date) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
                continue;
            };
            if file_date < cutoff {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    async fn write(&self, level: &str, message: &str) {
        let line = json!({
            "time": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "level": level,
            "message": message,
        })
        .to_string();
        if level == "ERROR" {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
        let _guard = self.lock.lock().await;
        let _ = fs::create_dir_all(&self.log_dir);
        let now = Utc::now();
        let path = format!(
            "{}/codex-claw-{:04}-{:02}-{:02}.log",
            self.log_dir,
            now.year(),
            now.month(),
            now.day()
        );
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
}
