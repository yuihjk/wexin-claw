import { getConfig, notifyStart, notifyStop, sendTyping as sendTypingApi } from "openclaw-weixin/src/api/api.js";
import { TypingStatus } from "openclaw-weixin/src/api/types.js";
import { DEFAULT_BASE_URL, CDN_BASE_URL } from "openclaw-weixin/src/auth/accounts.js";
import { getContextToken, restoreContextTokens } from "openclaw-weixin/src/messaging/inbound.js";
import { sendMessageWeixin } from "openclaw-weixin/src/messaging/send.js";

import { runReceiveLoop } from "./receive-loop.js";
import type { MessageHandler, WeixinChannelOptions, WeixinCredentials } from "./types.js";

function resolveCredentials(input: WeixinCredentials): Required<Pick<WeixinCredentials, "accountId" | "baseUrl" | "cdnBaseUrl">> & {
  token?: string;
} {
  return {
    accountId: input.accountId,
    token: input.token,
    baseUrl: input.baseUrl ?? DEFAULT_BASE_URL,
    cdnBaseUrl: input.cdnBaseUrl ?? CDN_BASE_URL,
  };
}

export class WeixinChannel {
  private readonly credentials: ReturnType<typeof resolveCredentials>;
  private readonly handlers = new Set<MessageHandler>();
  private readonly longPollTimeoutMs?: number;
  private readonly persistCursor: boolean;
  private readonly notifyOnStartStop: boolean;
  private readonly allowFrom?: string[];
  private abortController?: AbortController;
  private receiveTask?: Promise<void>;

  constructor(options: WeixinChannelOptions) {
    this.credentials = resolveCredentials(options.credentials);
    this.longPollTimeoutMs = options.longPollTimeoutMs;
    this.persistCursor = options.persistCursor !== false;
    this.notifyOnStartStop = options.notifyOnStartStop !== false;
    this.allowFrom = options.allowFrom;
    restoreContextTokens(this.credentials.accountId);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async start(): Promise<void> {
    if (this.receiveTask) return;
    const controller = new AbortController();
    this.abortController = controller;

    if (this.notifyOnStartStop) {
      await notifyStart({ baseUrl: this.credentials.baseUrl, token: this.credentials.token });
    }

    this.receiveTask = runReceiveLoop({
      credentials: this.credentials,
      handlers: () => this.handlers,
      abortSignal: controller.signal,
      longPollTimeoutMs: this.longPollTimeoutMs,
      persistCursor: this.persistCursor,
      allowFrom: this.allowFrom,
      onError: (err) => {
        console.error(`[wx-channel-wrapper] ${String(err)}`);
      },
    }).finally(() => {
      if (this.abortController === controller) {
        this.abortController = undefined;
        this.receiveTask = undefined;
      }
    });
  }

  async stop(): Promise<void> {
    const task = this.receiveTask;
    this.abortController?.abort();
    if (task) {
      try {
        await task;
      } catch (err) {
        if ((err as Error).message !== "aborted") throw err;
      }
    }

    if (this.notifyOnStartStop) {
      await notifyStop({ baseUrl: this.credentials.baseUrl, token: this.credentials.token });
    }
  }

  async sendText(to: string, text: string): Promise<{ messageId: string }> {
    return sendMessageWeixin({
      to,
      text,
      opts: {
        baseUrl: this.credentials.baseUrl,
        token: this.credentials.token,
        contextToken: getContextToken(this.credentials.accountId, to),
      },
    });
  }

  async sendTyping(to: string): Promise<void> {
    const contextToken = getContextToken(this.credentials.accountId, to);
    const config = await getConfig({
      baseUrl: this.credentials.baseUrl,
      token: this.credentials.token,
      ilinkUserId: to,
      contextToken,
    });
    if (!config.typing_ticket) return;
    await sendTypingApi({
      baseUrl: this.credentials.baseUrl,
      token: this.credentials.token,
      body: {
        ilink_user_id: to,
        typing_ticket: config.typing_ticket,
        status: TypingStatus.TYPING,
      },
    });
  }
}
