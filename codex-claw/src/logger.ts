import fs from "node:fs";
import path from "node:path";

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
};

const LOG_RETENTION_DAYS_ENV = "CODEX_CLAW_LOG_RETENTION_DAYS";
const DEFAULT_LOG_RETENTION_DAYS = 7;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOG_FILE_RE = /^codex-claw-(\d{4}-\d{2}-\d{2})\.log$/;

function formatLine(level: string, message: string): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
  });
}

export function createLogger(logDir?: string): Logger {
  if (logDir) {
    cleanupOldLogsSafe(logDir);
    const cleanupTimer = setInterval(() => cleanupOldLogsSafe(logDir), LOG_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  const write = (level: string, message: string) => {
    const line = formatLine(level, message);
    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);

    if (!logDir) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(path.join(logDir, `codex-claw-${date}.log`), `${line}\n`, "utf-8");
    } catch {
      // Logging should never break the bot.
    }
  };

  return {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
    debug: (message) => {
      if (process.env.CODEX_CLAW_DEBUG === "1") write("DEBUG", message);
    },
  };
}

function cleanupOldLogsSafe(logDir: string): void {
  try {
    cleanupOldLogs(logDir, envInt(LOG_RETENTION_DAYS_ENV, DEFAULT_LOG_RETENTION_DAYS));
  } catch {
    // Logging maintenance should never break the bot.
  }
}

function cleanupOldLogs(logDir: string, retentionDays: number): void {
  if (retentionDays <= 0) return;
  fs.mkdirSync(logDir, { recursive: true });

  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);

  for (const name of fs.readdirSync(logDir)) {
    const match = LOG_FILE_RE.exec(name);
    if (!match) continue;

    const fileDate = new Date(`${match[1]}T00:00:00.000Z`);
    if (Number.isNaN(fileDate.getTime())) continue;

    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(logDir, name));
    }
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
