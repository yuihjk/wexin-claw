import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppPaths, ClawConfig } from "./types.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function resolveHome(): string {
  return path.resolve(process.env.CODEX_CLAW_HOME?.trim() || path.join(os.homedir(), ".codex-claw"));
}

export function resolveCodexAppPath(): string {
  return path.resolve(process.env.CODEX_CLAW_CODEX_APP?.trim() || "/Applications/Codex.app");
}

export function resolveCodexAppRuntime(codexAppPath = resolveCodexAppPath()): string {
  return path.join(codexAppPath, "Contents", "Resources", "codex");
}

export function buildPaths(home = resolveHome()): AppPaths {
  return {
    home,
    channel: path.join(home, "channel"),
    channelTmp: path.join(home, "channel", "tmp"),
    channelCredentials: path.join(home, "channel", "credentials"),
    workspace: path.join(home, "workspace"),
    state: path.join(home, "state"),
    logs: path.join(home, "logs"),
  };
}

export function ensureHomeLayout(paths: AppPaths): void {
  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): { paths: AppPaths; config: ClawConfig } {
  const paths = buildPaths();
  ensureHomeLayout(paths);
  process.env.CODEX_CLAW_HOME = paths.home;
  process.chdir(paths.home);

  return {
    paths,
    config: {
      home: paths.home,
      repoRoot: resolveRepoRoot(),
      codexAppPath: resolveCodexAppPath(),
      codexBin: process.env.CODEX_CLAW_CODEX_BIN?.trim() || resolveCodexAppRuntime(),
      codexAppServerMode: parseAppServerMode(process.env.CODEX_CLAW_CODEX_APP_SERVER_MODE),
      codexAppLaunchWaitMs: envInt("CODEX_CLAW_CODEX_APP_LAUNCH_WAIT_MS", 2_000),
      codexDaemonStart: parseBool(process.env.CODEX_CLAW_CODEX_DAEMON_START, false),
      turnTimeoutMs: envInt("CODEX_CLAW_TURN_TIMEOUT_MS", 10 * 60_000),
      coalesceMs: envInt("CODEX_CLAW_COALESCE_MS", 1_500),
      maxPendingMessagesPerSender: envInt("CODEX_CLAW_MAX_PENDING_MESSAGES_PER_SENDER", 20),
      maxPendingCharsPerSender: envInt("CODEX_CLAW_MAX_PENDING_CHARS_PER_SENDER", 8_000),
      maxReplyChars: envInt("CODEX_CLAW_MAX_REPLY_CHARS", 1_500),
      codexModel: process.env.CODEX_CLAW_CODEX_MODEL?.trim() || undefined,
      codexSandbox: parseSandbox(process.env.CODEX_CLAW_CODEX_SANDBOX) ?? "workspace-write",
      codexApprovalPolicy: process.env.CODEX_CLAW_CODEX_APPROVAL_POLICY?.trim() || undefined,
    },
  };
}

function parseSandbox(value: string | undefined): ClawConfig["codexSandbox"] {
  const trimmed = value?.trim();
  if (trimmed === "read-only" || trimmed === "workspace-write" || trimmed === "danger-full-access") {
    return trimmed;
  }
  return undefined;
}

function parseAppServerMode(value: string | undefined): ClawConfig["codexAppServerMode"] {
  const trimmed = value?.trim();
  if (trimmed === "proxy") return "proxy";
  return "direct";
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return fallback;
  if (["1", "true", "yes", "on"].includes(trimmed)) return true;
  if (["0", "false", "no", "off"].includes(trimmed)) return false;
  return fallback;
}

export function channelEnv(paths: AppPaths, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    CODEX_CLAW_HOME: paths.home,
    OPENCLAW_STATE_DIR: paths.channel,
    OPENCLAW_TMP_DIR: paths.channelTmp,
    OPENCLAW_OAUTH_DIR: paths.channelCredentials,
  };
}
