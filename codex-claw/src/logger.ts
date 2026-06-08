import fs from "node:fs";
import path from "node:path";

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
};

function formatLine(level: string, message: string): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
  });
}

export function createLogger(logDir?: string): Logger {
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
