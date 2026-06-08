import type { AppServerStatusSnapshot } from "./types.js";

export type CommandContext = {
  senderId: string;
  resetThread(): void;
  getStatus(): {
    channel: { ready: boolean; accountId?: string; lastError?: string };
    codex: AppServerStatusSnapshot;
    pending: number;
  };
};

export function handleCommand(text: string, context: CommandContext): string | null {
  const command = text.trim();
  if (!command.startsWith("/")) return null;

  if (command === "/help") {
    return [
      "可用命令：",
      "/help - 显示帮助",
      "/status - 显示运行状态",
      "/new - 开始新会话",
      "/reset - 开始新会话",
      "/新会话 - 开始新会话",
    ].join("\n");
  }

  if (command === "/status") {
    const status = context.getStatus();
    return [
      `channel: ${status.channel.ready ? "ready" : "not ready"}${status.channel.accountId ? ` (${status.channel.accountId})` : ""}`,
      `codex: ${status.codex.status}${status.codex.pid ? ` pid=${status.codex.pid}` : ""}`,
      `activeTurns: ${status.codex.activeTurns}`,
      `knownThreads: ${status.codex.knownThreads}`,
      `pendingForYou: ${status.pending}`,
      status.channel.lastError ? `channelLastError: ${status.channel.lastError}` : "",
      status.codex.lastError ? `codexLastError: ${status.codex.lastError}` : "",
    ].filter(Boolean).join("\n");
  }

  if (command === "/new" || command === "/reset" || command === "/新会话") {
    context.resetThread();
    return "已重置当前微信用户的 Codex 会话。下一条普通消息会创建新 thread。";
  }

  return null;
}
