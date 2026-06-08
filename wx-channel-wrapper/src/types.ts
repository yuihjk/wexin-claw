import type { WeixinMessage } from "openclaw-weixin/src/api/types.js";

export type WeixinCredentials = {
  accountId: string;
  token?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
};

export type WeixinChannelOptions = {
  credentials: WeixinCredentials;
  longPollTimeoutMs?: number;
  persistCursor?: boolean;
  notifyOnStartStop?: boolean;
  allowFrom?: string[];
};

export type InboundMessage = {
  messageId: string;
  accountId: string;
  from: string;
  to?: string;
  text: string;
  contextToken?: string;
  hasMedia: boolean;
  timestamp?: number;
  raw: WeixinMessage;
};

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;
