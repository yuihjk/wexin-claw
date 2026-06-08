export type AppPaths = {
  home: string;
  channel: string;
  channelTmp: string;
  channelCredentials: string;
  workspace: string;
  state: string;
  logs: string;
};

export type ClawConfig = {
  home: string;
  repoRoot: string;
  codexAppPath: string;
  codexBin: string;
  codexAppServerMode: "proxy" | "direct";
  codexAppLaunchWaitMs: number;
  codexDaemonStart: boolean;
  turnTimeoutMs: number;
  coalesceMs: number;
  maxPendingMessagesPerSender: number;
  maxPendingCharsPerSender: number;
  maxReplyChars: number;
  codexModel?: string;
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  codexApprovalPolicy?: string;
};

export type InboundWeixinMessage = {
  messageId: string;
  accountId: string;
  from: string;
  to?: string;
  text: string;
  contextToken?: string;
  hasMedia: boolean;
  timestamp?: number;
  raw?: unknown;
};

export type AppServerStatus = "starting" | "ready" | "busy" | "failed" | "stopped";

export type AppServerStatusSnapshot = {
  pid?: number;
  status: AppServerStatus;
  activeTurns: number;
  knownThreads: number;
  lastError?: string;
  lastCompletedTurnAt?: string;
};
