import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { channelEnv } from "./home.js";
import { isChannelEvent, isChannelResponse, sendToChild, type ChannelEvent, type ChannelRequest } from "./channel-rpc.js";
import type { Logger } from "./logger.js";
import type { AppPaths, ClawConfig, InboundWeixinMessage } from "./types.js";

type PendingRpc = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class ChannelSupervisor {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<string, PendingRpc>();
  private messageHandlers = new Set<(message: InboundWeixinMessage) => void | Promise<void>>();
  private ready = false;
  private accountId: string | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly config: ClawConfig,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
  ) {}

  onMessage(handler: (message: InboundWeixinMessage) => void | Promise<void>): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.child) return;
    const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "channel-worker.ts");
    this.logger.info(`channel worker starting script=${workerPath}`);
    this.child = fork(workerPath, [], {
      cwd: this.config.repoRoot,
      env: channelEnv(this.paths),
      execArgv: ["--import", "tsx"],
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    this.child.on("message", (message) => this.handleMessage(message));
    this.child.once("exit", (code, signal) => {
      this.ready = false;
      this.child = undefined;
      this.lastError = `channel worker exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      for (const pending of this.pending.values()) pending.reject(new Error(this.lastError));
      this.pending.clear();
      this.logger.warn(this.lastError);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for channel worker")), 120_000);
      const off = this.onReady(() => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("stop");
    } catch {
      this.child.kill("SIGTERM");
    }
  }

  async sendText(to: string, text: string): Promise<void> {
    this.logger.info(`channel sendText requested to=${shortId(to)} chars=${text.length}`);
    await this.request("sendText", { to, text });
    this.logger.info(`channel sendText ok to=${shortId(to)} chars=${text.length}`);
  }

  async sendTyping(to: string): Promise<void> {
    this.logger.debug(`channel sendTyping requested to=${shortId(to)}`);
    await this.request("sendTyping", { to });
  }

  getStatus(): { ready: boolean; accountId?: string; lastError?: string } {
    return { ready: this.ready, accountId: this.accountId, lastError: this.lastError };
  }

  private readyHandlers = new Set<() => void>();

  private onReady(handler: () => void): () => void {
    if (this.ready) {
      queueMicrotask(handler);
      return () => {};
    }
    this.readyHandlers.add(handler);
    return () => this.readyHandlers.delete(handler);
  }

  private request(method: ChannelRequest["method"], params?: ChannelRequest["params"]): Promise<unknown> {
    if (!this.child) throw new Error("channel worker is not running");
    const id = String(this.nextId++);
    const request = { id, method, ...(params === undefined ? {} : { params }) } as ChannelRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      sendToChild(this.child as ChildProcess, request);
    });
  }

  private handleMessage(message: unknown): void {
    if (isChannelResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }
    if (isChannelEvent(message)) {
      this.handleEvent(message);
    }
  }

  private handleEvent(event: ChannelEvent): void {
    if (event.type === "ready") {
      this.ready = true;
      this.accountId = event.accountId;
      this.logger.info(`channel worker ready account=${event.accountId}`);
      for (const handler of [...this.readyHandlers]) handler();
      this.readyHandlers.clear();
      return;
    }
    if (event.type === "message") {
      this.logger.info(`channel inbound message from=${shortId(event.message.from)} message=${event.message.messageId} chars=${event.message.text.length} hasMedia=${event.message.hasMedia}`);
      for (const handler of [...this.messageHandlers]) {
        void Promise.resolve(handler(event.message)).catch((err: unknown) => {
          this.logger.error(`message handler failed: ${String(err)}`);
        });
      }
      return;
    }
    if (event.type === "error") {
      this.lastError = event.error;
      this.logger.error(`channel worker error: ${event.error}`);
      return;
    }
    if (event.type === "stopped") {
      this.ready = false;
      this.logger.warn("channel worker stopped");
    }
  }
}

function shortId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
