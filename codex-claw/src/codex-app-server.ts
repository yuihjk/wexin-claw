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
  turnId?: string;
  chunks: string[];
  resolve(text: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type CodexApprovalRequest = {
  id: JsonRpcId;
  method: string;
  threadId?: string;
  turnId?: string;
  message: string;
};

export type CodexApprovalDecision = "accept" | "decline";
export type CodexApprovalHandler = (request: CodexApprovalRequest) => Promise<void> | void;

export class CodexAppServerClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private pendingApprovals = new Map<JsonRpcId, JsonRpcRequest>();
  private activeTurns = new Map<string, ActiveTurn>();
  private status: AppServerStatus = "stopped";
  private lastError: string | undefined;
  private lastCompletedTurnAt: string | undefined;
  private stderrTail = "";
  private approvalHandler?: CodexApprovalHandler;

  constructor(
    private readonly config: ClawConfig,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
    private readonly knownThreadCount: () => number,
  ) {}

  setApprovalHandler(handler: CodexApprovalHandler): void {
    this.approvalHandler = handler;
  }

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
      this.pendingApprovals.clear();
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
    if (this.config.codexApprovalsReviewer) params.approvalsReviewer = this.config.codexApprovalsReviewer;
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
      ...(this.config.codexApprovalsReviewer ? { approvalsReviewer: this.config.codexApprovalsReviewer } : {}),
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
        this.declinePendingApprovalsForThread(threadId, "turn timed out");
        void this.interruptTurn(turn);
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
      if (this.config.codexApprovalsReviewer) params.approvalsReviewer = this.config.codexApprovalsReviewer;

      this.request("turn/start", params)
        .then((result) => {
          const turnId = extractTurnId(result);
          const turn = this.activeTurns.get(threadId);
          if (turn && turnId) {
            turn.turnId = turnId;
            this.logger.info(`codex turn/start ok thread=${threadId} turn=${turnId}`);
          }
        })
        .catch((err) => {
          clearTimeout(timer);
          this.activeTurns.delete(threadId);
          this.logger.error(`codex turn/start request failed thread=${threadId}: ${String(err)}`);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
    await this.ensureStarted();
    this.logger.info(`codex turn/steer requested thread=${threadId} turn=${turnId} chars=${text.length}`);
    await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    this.logger.info(`codex turn/steer ok thread=${threadId} turn=${turnId}`);
  }

  resolveApproval(id: JsonRpcId, decision: CodexApprovalDecision): boolean {
    const request = this.pendingApprovals.get(id);
    if (!request) return false;
    this.pendingApprovals.delete(id);
    this.respond(id, approvalResponseFor(request, decision));
    this.logger.info(`codex approval resolved id=${id} method=${request.method} decision=${decision}`);
    return true;
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

    if (isServerRequest(message)) {
      this.handleServerRequest(message);
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
    if (method === "turn/started") {
      this.markTurnStarted(params);
      return;
    }
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

  private handleServerRequest(request: JsonRpcRequest): void {
    if (isApprovalRequest(request.method)) {
      this.pendingApprovals.set(request.id, request);
      const approval = buildApprovalRequest(request);
      this.logger.warn(`codex approval requested id=${request.id} method=${request.method} thread=${approval.threadId ?? "unknown"}`);
      if (!this.approvalHandler) {
        this.respond(request.id, approvalResponseFor(request, "decline"));
        this.pendingApprovals.delete(request.id);
        this.logger.warn(`codex approval auto-declined id=${request.id}: no approval handler configured`);
        return;
      }
      void Promise.resolve(this.approvalHandler(approval)).catch((err: unknown) => {
        this.logger.error(`codex approval handler failed id=${request.id}: ${String(err)}`);
        if (this.pendingApprovals.has(request.id)) {
          this.pendingApprovals.delete(request.id);
          this.respond(request.id, approvalResponseFor(request, "decline"));
        }
      });
      return;
    }

    this.logger.warn(`unsupported codex server request ${request.method} id=${request.id}`);
    switch (request.method) {
      case "item/tool/requestUserInput":
        this.respond(request.id, { answers: {} });
        return;
      case "mcpServer/elicitation/request":
        this.respond(request.id, { action: "cancel", content: null, _meta: null });
        return;
      case "item/tool/call":
        this.respond(request.id, {
          contentItems: [{ type: "inputText", text: "Codex Claw does not support app-server initiated tool calls." }],
          success: false,
        });
        return;
      default:
        this.respondError(request.id, -32601, `Unsupported app-server request: ${request.method}`);
    }
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.logger.debug(`codex rpc -> response id=${id} ok`);
    this.send({ id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.logger.debug(`codex rpc -> response id=${id} error=${message}`);
    this.send({ id, error: { code, message } });
  }

  private markTurnStarted(params: unknown): void {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const turn = threadId ? this.activeTurns.get(threadId) : [...this.activeTurns.values()].at(-1);
    if (!turn) return;
    if (turnId) turn.turnId = turnId;
    this.logger.info(`codex turn/started thread=${turn.threadId}${turn.turnId ? ` turn=${turn.turnId}` : ""}`);
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
    this.clearPendingApprovalsForThread(turn.threadId);
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
    this.clearPendingApprovalsForThread(turn.threadId);
    turn.reject(error);
  }

  private declinePendingApprovalsForThread(threadId: string, reason: string): void {
    for (const [id, request] of this.pendingApprovals) {
      if (extractThreadId(request.params) !== threadId) continue;
      this.pendingApprovals.delete(id);
      this.respond(id, approvalResponseFor(request, "decline"));
      this.logger.warn(`codex approval auto-declined id=${id} method=${request.method}: ${reason}`);
    }
  }

  private clearPendingApprovalsForThread(threadId: string): void {
    for (const [id, request] of this.pendingApprovals) {
      if (extractThreadId(request.params) === threadId) this.pendingApprovals.delete(id);
    }
  }

  private async interruptTurn(turn: ActiveTurn): Promise<void> {
    if (!turn.turnId) {
      this.logger.warn(`turn/interrupt skipped thread=${turn.threadId}: missing turnId`);
      return;
    }
    try {
      await this.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
    } catch (err) {
      this.logger.warn(`turn/interrupt failed: ${String(err)}`);
    }
  }
}

function isServerRequest(value: unknown): value is JsonRpcRequest {
  return typeof value === "object" && value !== null && "id" in value && "method" in value;
}

function isApprovalRequest(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(method);
}

function buildApprovalRequest(request: JsonRpcRequest): CodexApprovalRequest {
  const params = request.params;
  return {
    id: request.id,
    method: request.method,
    threadId: extractThreadId(params),
    turnId: extractTurnId(params),
    message: formatApprovalMessage(request.method, params),
  };
}

function approvalResponseFor(request: JsonRpcRequest, decision: CodexApprovalDecision): unknown {
  const accepted = decision === "accept";
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return { decision: accepted ? "accept" : "decline" };
    case "item/fileChange/requestApproval":
      return { decision: accepted ? "accept" : "decline" };
    case "item/permissions/requestApproval":
      return accepted
        ? { permissions: getRecordAt(request.params, ["permissions"]) ?? {}, scope: "turn", strictAutoReview: false }
        : { permissions: {}, scope: "turn", strictAutoReview: true };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: accepted ? "approved" : "denied" };
    default:
      return { decision: accepted ? "accept" : "decline" };
  }
}

function formatApprovalMessage(method: string, params: unknown): string {
  const lines = [
    "Codex 请求权限审批：",
    `method: ${method}`,
    formatOptional("cwd", getStringAt(params, ["cwd"])),
    formatOptional("reason", getStringAt(params, ["reason"])),
    formatOptional("command", formatCommand(params)),
    formatOptional("files", formatStringArray(params, ["files"])),
    formatOptional("permissions", formatJson(getRecordAt(params, ["permissions"]))),
  ].filter((line): line is string => Boolean(line));

  lines.push("1: accept 2: decline");
  return lines.join("\n");
}

function formatOptional(label: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `${label}: ${value}`;
}

function formatCommand(params: unknown): string | undefined {
  const command = getArrayAt(params, ["command"]);
  if (!command) return undefined;
  if (command.every((item) => typeof item === "string")) return command.join(" ");
  return JSON.stringify(command);
}

function formatStringArray(value: unknown, path: string[]): string | undefined {
  const array = getArrayAt(value, path);
  if (!array) return undefined;
  if (array.every((item) => typeof item === "string")) return array.join(", ");
  return JSON.stringify(array);
}

function formatJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}

function getRecordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || !(key in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "object" && cursor !== null && !Array.isArray(cursor) ? cursor as Record<string, unknown> : undefined;
}

function getArrayAt(value: unknown, path: string[]): unknown[] | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || !(key in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Array.isArray(cursor) ? cursor : undefined;
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

function extractTurnId(params: unknown): string | undefined {
  return (
    getStringAt(params, ["turnId"]) ??
    getStringAt(params, ["turn_id"]) ??
    getStringAt(params, ["turn", "id"])
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
