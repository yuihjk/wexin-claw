import type { ChildProcess } from "node:child_process";

import type { InboundWeixinMessage } from "./types.js";

export type ChannelEvent =
  | { type: "ready"; accountId: string }
  | { type: "message"; message: InboundWeixinMessage }
  | { type: "error"; error: string }
  | { type: "stopped" };

export type ChannelRequest =
  | { id: string; method: "sendText"; params: { to: string; text: string } }
  | { id: string; method: "sendTyping"; params: { to: string } }
  | { id: string; method: "stop"; params?: undefined };

export type ChannelResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: string };

export type ChannelIpcMessage = ChannelEvent | ChannelRequest | ChannelResponse;

export function isChannelResponse(message: unknown): message is ChannelResponse {
  return typeof message === "object" && message !== null && "id" in message && "ok" in message;
}

export function isChannelEvent(message: unknown): message is ChannelEvent {
  return typeof message === "object" && message !== null && "type" in message;
}

export function isChannelRequest(message: unknown): message is ChannelRequest {
  return typeof message === "object" && message !== null && "id" in message && "method" in message;
}

export function sendToParent(message: ChannelEvent | ChannelResponse): void {
  if (!process.send) return;
  process.send(message);
}

export function sendToChild(child: ChildProcess, message: ChannelRequest): void {
  if (!child.send) throw new Error("channel child IPC is unavailable");
  child.send(message);
}
