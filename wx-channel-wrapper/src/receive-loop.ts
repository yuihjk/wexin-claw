import { getUpdates } from "openclaw-weixin/src/api/api.js";
import type { WeixinMessage } from "openclaw-weixin/src/api/types.js";
import { MessageItemType } from "openclaw-weixin/src/api/types.js";
import { SESSION_EXPIRED_ERRCODE, getRemainingPauseMs, pauseSession } from "openclaw-weixin/src/api/session-guard.js";
import { DEFAULT_BASE_URL } from "openclaw-weixin/src/auth/accounts.js";
import { setContextToken, weixinMessageToMsgContext } from "openclaw-weixin/src/messaging/inbound.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "openclaw-weixin/src/storage/sync-buf.js";

import type { InboundMessage, MessageHandler, WeixinCredentials } from "./types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export type ReceiveLoopOptions = {
  credentials: WeixinCredentials;
  handlers: Iterable<MessageHandler> | (() => Iterable<MessageHandler>);
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  persistCursor?: boolean;
  allowFrom?: string[];
  onError?: (error: unknown) => void;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function hasMedia(msg: WeixinMessage): boolean {
  return msg.item_list?.some((item) =>
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VOICE ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VIDEO,
  ) ?? false;
}

function buildMessage(msg: WeixinMessage, accountId: string): InboundMessage {
  const ctx = weixinMessageToMsgContext(msg, accountId);
  const from = msg.from_user_id ?? "";
  if (msg.context_token && from) {
    setContextToken(accountId, from, msg.context_token);
  }
  return {
    messageId: String(msg.message_id ?? ctx.MessageSid),
    accountId,
    from,
    to: msg.to_user_id,
    text: ctx.Body,
    contextToken: msg.context_token,
    hasMedia: hasMedia(msg),
    timestamp: msg.create_time_ms,
    raw: msg,
  };
}

function getHandlers(handlers: ReceiveLoopOptions["handlers"]): Iterable<MessageHandler> {
  return typeof handlers === "function" ? handlers() : handlers;
}

export async function runReceiveLoop(options: ReceiveLoopOptions): Promise<void> {
  const { credentials, abortSignal, persistCursor = true, onError } = options;
  const accountId = credentials.accountId;
  const allowSet = options.allowFrom?.length ? new Set(options.allowFrom) : undefined;
  const syncPath = getSyncBufFilePath(accountId);
  let getUpdatesBuf = persistCursor ? loadGetUpdatesBuf(syncPath) ?? "" : "";
  let nextTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const response = await getUpdates({
        baseUrl: credentials.baseUrl ?? DEFAULT_BASE_URL,
        token: credentials.token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (response.longpolling_timeout_ms != null && response.longpolling_timeout_ms > 0) {
        nextTimeoutMs = response.longpolling_timeout_ms;
      }

      const isError =
        (response.ret !== undefined && response.ret !== 0) ||
        (response.errcode !== undefined && response.errcode !== 0);
      if (isError) {
        const sessionExpired = response.ret === SESSION_EXPIRED_ERRCODE || response.errcode === SESSION_EXPIRED_ERRCODE;
        if (sessionExpired) {
          pauseSession(accountId);
          await sleep(getRemainingPauseMs(accountId), abortSignal);
          continue;
        }
        consecutiveFailures += 1;
        onError?.(new Error(`getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`));
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, abortSignal);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        continue;
      }

      consecutiveFailures = 0;
      if (response.get_updates_buf) {
        getUpdatesBuf = response.get_updates_buf;
        if (persistCursor) saveGetUpdatesBuf(syncPath, getUpdatesBuf);
      }

      for (const raw of response.msgs ?? []) {
        const from = raw.from_user_id ?? "";
        if (allowSet && !allowSet.has(from)) continue;

        const message = buildMessage(raw, accountId);
        for (const handler of [...getHandlers(options.handlers)]) {
          try {
            await handler(message);
          } catch (err) {
            onError?.(err);
          }
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) return;
      consecutiveFailures += 1;
      onError?.(err);
      await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, abortSignal);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
    }
  }
}
