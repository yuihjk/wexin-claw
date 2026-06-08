import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

import type { Logger } from "./logger.js";
import type { AppPaths, AppServerStatus, AppServerStatusSnapshot, ClawConfig } from "./types.js";
import { getStringAt, hasId, isNotification, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse } from "./codex-protocol.js";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type ActiveTurn = {
  threadId: string;
  chunks: string[];
  resolve(text: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class CodexAppServerClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private activeTurns = new Map<string, ActiveTurn>();
  private status: AppServerStatus = "stopped";
  private lastError: string | undefined;
  private lastCompletedTurnAt: string | undefined;
  private stderrTail = "";

  constructor(
    private readonly config: ClawConfig,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
    private readonly knownThreadCount: () => number,
  ) {}

  async start(): Promise<void> {
    if (this.proc) return;
    await this.launchCodexApp();
    if (!fs.existsSync(this.config.codexBin)) {
      throw new Error(`Codex.app runtime not found: ${this.config.codexBin}`);
    }
    await this.ensureAppServerDaemon();
    this.status = "starting";
    const args = this.appServerArgs();
    this.logger.info(`codex app-server starting mode=${this.config.codexAppServerMode} bin=${this.config.codexBin} args=${args.join(" ")} cwd=${this.paths.workspace}`);
    this.proc = spawn(this.config.codexBin, args, {
      cwd: this.paths.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.proc.once("exit", (code, signal) => {
      const stderr = this.stderrTail.trim();
      this.lastError = [
        `codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        stderr ? `stderr: ${stderr}` : "",
      ].filter(Boolean).join("\n");
      this.status = "stopped";
      this.proc = undefined;
      for (const pending of this.pending.values()) pending.reject(new Error(this.lastError));
      this.pending.clear();
      for (const turn of this.activeTurns.values()) {
        clearTimeout(turn.timer);
        turn.reject(new Error(this.lastError));
      }
      this.activeTurns.clear();
      this.logger.warn(this.lastError);
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.stderrTail = `${this.stderrTail}${text}`.slice(-8_000);
      this.logger.debug(`[codex stderr] ${text.trim()}`);
    });

    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_claw",
        title: "Codex Claw",
        version: "0.1.0",
      },
    });
    this.notify("initialized");
    this.status = "ready";
    this.logger.info(`codex app-server ready pid=${this.proc.pid ?? "unknown"}`);
  }

  private async launchCodexApp(): Promise<void> {
    if (!fs.existsSync(this.config.codexAppPath)) {
      this.logger.warn(`Codex.app not found at ${this.config.codexAppPath}; continuing with runtime only`);
      return;
    }

    await new Promise<void>((resolve) => {
      const proc = spawn("open", [this.config.codexAppPath], {
        stdio: "ignore",
      });
      proc.once("exit", (code) => {
        if (code !== 0) this.logger.warn(`open Codex.app exited with code=${code}`);
        resolve();
      });
      proc.once("error", (err) => {
        this.logger.warn(`failed to open Codex.app: ${String(err)}`);
        resolve();
      });
    });

    if (this.config.codexAppLaunchWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.codexAppLaunchWaitMs));
    }
  }

  private appServerArgs(): string[] {
    if (this.config.codexAppServerMode === "direct") return ["app-server"];
    return ["app-server", "proxy"];
  }

  private async ensureAppServerDaemon(): Promise<void> {
    if (this.config.codexAppServerMode !== "proxy" || !this.config.codexDaemonStart) return;

    const args = ["app-server", "daemon", "start"];
    this.logger.info(`codex app-server daemon start bin=${this.config.codexBin} args=${args.join(" ")}`);
    const result = await runCommand(this.config.codexBin, args, this.paths.workspace);
    if (result.stdout.trim()) this.logger.info(`codex app-server daemon stdout: ${result.stdout.trim()}`);
    if (result.stderr.trim()) this.logger.warn(`codex app-server daemon stderr: ${result.stderr.trim()}`);
    if (result.code !== 0) {
      throw new Error(`codex app-server daemon start failed code=${result.code}\n${result.stderr || result.stdout}`.trim());
    }
    this.logger.info("codex app-server daemon ready");
  }

  async stop(): Promise<void> {
    for (const turn of this.activeTurns.values()) {
      clearTimeout(turn.timer);
      turn.reject(new Error("codex app-server stopped"));
    }
    this.activeTurns.clear();

    if (!this.proc) {
      this.status = "stopped";
      return;
    }
    const proc = this.proc;
    this.proc = undefined;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 3_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.status = "stopped";
  }

  async startThread(): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: this.paths.workspace,
      serviceName: "codex-claw",
    };
    if (this.config.codexModel) params.model = this.config.codexModel;
    if (this.config.codexSandbox) params.sandbox = this.config.codexSandbox;
    if (this.config.codexApprovalPolicy) params.approvalPolicy = this.config.codexApprovalPolicy;
    this.logger.info(`codex thread/start cwd=${this.paths.workspace}`);
    const result = await this.request("thread/start", params);
    const threadId = getStringAt(result, ["thread", "id"]);
    if (!threadId) throw new Error("thread/start did not return thread.id");
    this.logger.info(`codex thread/start ok thread=${threadId}`);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<string> {
    this.logger.info(`codex thread/resume thread=${threadId}`);
    const result = await this.request("thread/resume", {
      threadId,
      cwd: this.paths.workspace,
      ...(this.config.codexApprovalPolicy ? { approvalPolicy: this.config.codexApprovalPolicy } : {}),
      ...(this.config.codexSandbox ? { sandbox: this.config.codexSandbox } : {}),
    });
    const resumed = getStringAt(result, ["thread", "id"]) ?? threadId;
    this.logger.info(`codex thread/resume ok thread=${resumed}`);
    return resumed;
  }

  async runTurn(threadId: string, text: string): Promise<string> {
    await this.ensureStarted();
    this.logger.info(`codex turn/start requested thread=${threadId} chars=${text.length}`);
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const turn = this.activeTurns.get(threadId);
        if (!turn) return;
        this.activeTurns.delete(threadId);
        void this.interruptTurn(threadId);
        reject(new Error(`Codex turn timed out after ${this.config.turnTimeoutMs}ms`));
      }, this.config.turnTimeoutMs);

      this.activeTurns.set(threadId, {
        threadId,
        chunks: [],
        resolve,
        reject,
        timer,
      });

      const params: Record<string, unknown> = {
        threadId,
        cwd: this.paths.workspace,
        input: [{ type: "text", text, text_elements: [] }],
      };
      if (this.config.codexModel) params.model = this.config.codexModel;
      if (this.config.codexApprovalPolicy) params.approvalPolicy = this.config.codexApprovalPolicy;

      this.request("turn/start", params).catch((err) => {
        clearTimeout(timer);
        this.activeTurns.delete(threadId);
        this.logger.error(`codex turn/start request failed thread=${threadId}: ${String(err)}`);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  getStatus(): AppServerStatusSnapshot {
    return {
      pid: this.proc?.pid,
      status: this.activeTurns.size > 0 && this.status === "ready" ? "busy" : this.status,
      activeTurns: this.activeTurns.size,
      knownThreads: this.knownThreadCount(),
      lastError: this.lastError,
      lastCompletedTurnAt: this.lastCompletedTurnAt,
    };
  }

  private async ensureStarted(): Promise<void> {
    if (!this.proc || this.status === "stopped" || this.status === "failed") {
      await this.start();
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method, ...(params === undefined ? {} : { params }) };
    this.logger.debug(`codex rpc -> id=${id} method=${method}`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(message);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.logger.debug(`codex rpc -> notification method=${method}`);
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  private send(message: unknown): void {
    if (!this.proc) throw new Error("codex app-server is not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn(`Ignoring non-JSON app-server line: ${line}`);
      return;
    }

    if (hasId(message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }
    if (isNotification(message)) {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      this.logger.error(`codex rpc <- id=${response.id} error=${response.error.message}`);
      pending.reject(new Error(response.error.message));
    } else {
      this.logger.debug(`codex rpc <- id=${response.id} ok`);
      pending.resolve(response.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    this.logger.debug(`codex event <- ${method}`);
    if (method === "item/agentMessage/delta") {
      const text = extractDeltaText(params);
      if (text) this.appendToTurn(params, text, { onlyIfEmpty: false });
      return;
    }
    if (method === "item/completed") {
      const text = extractCompletedAgentText(params);
      if (text) this.appendToTurn(params, text, { onlyIfEmpty: true });
      return;
    }
    if (method === "turn/completed") {
      this.completeTurn(params);
      return;
    }
    if (method === "turn/failed" || method === "error") {
      const message = extractErrorMessage(params) ?? `${method}`;
      this.logger.error(`codex event failed method=${method} message=${message}`);
      this.failLatestTurn(new Error(message));
      return;
    }
    this.logger.debug(`Unhandled codex notification ${method}`);
  }

  private appendToTurn(params: unknown, text: string, options: { onlyIfEmpty: boolean }): void {
    const threadId = extractThreadId(params);
    const turn = threadId ? this.activeTurns.get(threadId) : [...this.activeTurns.values()].at(-1);
    if (!turn) return;
    if (options.onlyIfEmpty && turn.chunks.length > 0) return;
    turn.chunks.push(text);
    this.logger.debug(`codex agent text thread=${turn.threadId} deltaChars=${text.length} totalChunks=${turn.chunks.length}`);
  }

  private completeTurn(params: unknown): void {
    const threadId = extractThreadId(params);
    const turn = threadId ? this.activeTurns.get(threadId) : [...this.activeTurns.values()][0];
    if (!turn) return;
    this.activeTurns.delete(turn.threadId);
    clearTimeout(turn.timer);
    this.lastCompletedTurnAt = new Date().toISOString();
    const text = turn.chunks.join("").trim();
    this.logger.info(`codex turn/completed thread=${turn.threadId} responseChars=${text.length}`);
    turn.resolve(text || "Codex 本轮没有返回文本。");
  }

  private failLatestTurn(error: Error): void {
    const turn = [...this.activeTurns.values()].at(-1);
    if (!turn) return;
    this.activeTurns.delete(turn.threadId);
    clearTimeout(turn.timer);
    turn.reject(error);
  }

  private async interruptTurn(threadId: string): Promise<void> {
    try {
      await this.request("turn/interrupt", { threadId });
    } catch (err) {
      this.logger.warn(`turn/interrupt failed: ${String(err)}`);
    }
  }
}

function extractDeltaText(params: unknown): string | undefined {
  return (
    getStringAt(params, ["delta"]) ??
    getStringAt(params, ["text"]) ??
    getStringAt(params, ["item", "text"]) ??
    getStringAt(params, ["message", "text"])
  );
}

function extractCompletedAgentText(params: unknown): string | undefined {
  const type = getStringAt(params, ["item", "type"]) ?? getStringAt(params, ["type"]);
  if (type && type !== "agent_message" && type !== "agentMessage") return undefined;
  return getStringAt(params, ["item", "text"]) ?? getStringAt(params, ["text"]);
}

function extractErrorMessage(params: unknown): string | undefined {
  return getStringAt(params, ["message"]) ?? getStringAt(params, ["error", "message"]);
}

function extractThreadId(params: unknown): string | undefined {
  return (
    getStringAt(params, ["threadId"]) ??
    getStringAt(params, ["thread_id"]) ??
    getStringAt(params, ["thread", "id"]) ??
    getStringAt(params, ["turn", "threadId"]) ??
    getStringAt(params, ["turn", "thread_id"]) ??
    getStringAt(params, ["item", "threadId"]) ??
    getStringAt(params, ["item", "thread_id"])
  );
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
