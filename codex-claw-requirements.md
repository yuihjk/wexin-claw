# codex-claw Requirements

## Goal

Add a new workspace module named `codex-claw`.

`codex-claw` bridges Weixin messages to Codex:

```text
Weixin message
  -> wx-channel-wrapper
  -> codex-claw main process
  -> codex app-server
  -> Codex response
  -> Weixin reply
```

The module must reuse `wx-channel-wrapper` for Weixin protocol behavior and must not reimplement the channel protocol.

## Runtime Directories

The program home is controlled by `CODEX_CLAW_HOME`.

Default:

```text
CODEX_CLAW_HOME=$HOME/.codex-claw
```

Required directory layout:

```text
$CODEX_CLAW_HOME/
  channel/      # wx-channel-wrapper / openclaw-weixin data
  workspace/    # Codex app-server working directory
  state/        # codex-claw state, such as thread mappings
  logs/         # codex-claw logs
```

The main process should create these directories at startup and set its working directory to:

```text
$CODEX_CLAW_HOME
```

Codex turns must run with:

```text
cwd=$CODEX_CLAW_HOME/workspace
```

This keeps Codex file reads and writes out of the repository that contains `codex-claw`.

## Channel Data Isolation

All Weixin channel data must be stored under:

```text
$CODEX_CLAW_HOME/channel
```

Before importing or starting `wx-channel-wrapper`, the channel process must set:

```text
OPENCLAW_STATE_DIR=$CODEX_CLAW_HOME/channel
OPENCLAW_TMP_DIR=$CODEX_CLAW_HOME/channel/tmp
OPENCLAW_OAUTH_DIR=$CODEX_CLAW_HOME/channel/credentials
```

These environment variables route the underlying `openclaw-weixin` fork to the desired storage paths:

```text
$CODEX_CLAW_HOME/channel/openclaw-weixin/accounts/*.json
$CODEX_CLAW_HOME/channel/openclaw-weixin/accounts/*.sync.json
$CODEX_CLAW_HOME/channel/openclaw-weixin/accounts/*.context-tokens.json
$CODEX_CLAW_HOME/channel/credentials/openclaw-weixin-*-allowFrom.json
$CODEX_CLAW_HOME/channel/tmp/openclaw-YYYY-MM-DD.log
```

`wx-channel-wrapper` must be imported only after these variables are set. A static top-level import is unsafe because some `openclaw-weixin` modules resolve paths during module load.

## Process Model

Use a multi-process architecture.

### Main Process

The main process owns:

- `CODEX_CLAW_HOME` resolution and directory creation.
- Process working directory: `$CODEX_CLAW_HOME`.
- Codex app-server lifecycle.
- Weixin sender to Codex thread mapping.
- Command handling.
- Message orchestration: receive Weixin message, start Codex turn, send Weixin reply.
- Channel worker lifecycle and restart policy.

### Channel Worker Process

The channel worker owns:

- Weixin channel environment variables.
- Dynamic import of `wx-channel-wrapper`.
- Weixin credential resolution.
- QR login when credentials are not available.
- `WeixinChannel` startup and shutdown.
- Incoming Weixin message forwarding to the main process.
- Sending Weixin text replies and typing indicators on request from the main process.

The channel worker should be spawned as a child process, not run in the main process.

## Main/Channel RPC

Use Node child-process IPC for the first implementation.

The channel worker sends events to the main process:

```ts
type ChannelEvent =
  | { type: "ready"; accountId: string }
  | { type: "message"; message: InboundMessage }
  | { type: "error"; error: string }
  | { type: "stopped" };
```

The main process sends requests to the channel worker:

```ts
type ChannelRequest =
  | { id: string; method: "sendText"; params: { to: string; text: string } }
  | { id: string; method: "sendTyping"; params: { to: string } }
  | { id: string; method: "stop"; params?: undefined };
```

The channel worker replies:

```ts
type ChannelResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: string };
```

The main process should treat Weixin channel as a transport. This keeps the design open for future transports such as Slack or Telegram.

## Codex Integration

Use Codex.app, not a global command-line Codex installation.

On macOS the default app path is:

```text
/Applications/Codex.app
```

The app-server runtime should be resolved from the app bundle:

```text
/Applications/Codex.app/Contents/Resources/codex app-server
```

The main process should best-effort launch the GUI app before connecting:

```bash
open /Applications/Codex.app
```

Then connect to the app-server exposed by Codex.app through the app-bundled proxy:

```bash
/Applications/Codex.app/Contents/Resources/codex app-server daemon start
/Applications/Codex.app/Contents/Resources/codex app-server proxy
```

The integration should use stdio JSON-RPC.

Do not use `codex exec` for the main bot flow.
Do not depend on `/opt/homebrew/bin/codex` or another global CLI wrapper for normal operation.

Configuration:

```text
CODEX_CLAW_CODEX_APP=/Applications/Codex.app
CODEX_CLAW_CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
CODEX_CLAW_CODEX_APP_SERVER_MODE=direct
CODEX_CLAW_CODEX_APP_LAUNCH_WAIT_MS=2000
CODEX_CLAW_CODEX_DAEMON_START=false
```

`CODEX_CLAW_CODEX_BIN` is only an override. The default should be derived from `CODEX_CLAW_CODEX_APP`.
`CODEX_CLAW_CODEX_APP_SERVER_MODE=proxy` is only for environments with a working Codex app-server daemon/control socket.

The main process is responsible for:

- Spawning `codex app-server`.
- Sending `initialize`.
- Sending the `initialized` notification.
- Starting, resuming, or forking threads.
- Starting turns with user text input.
- Passing `cwd=$CODEX_CLAW_HOME/workspace`.
- Streaming or collecting agent messages.
- Waiting for `turn/completed`.
- Returning the final response to the channel worker.

If a GUI handoff is needed later, Codex app deep links such as `codex://threads/new` may be added separately. They are not the primary automation interface.

## Codex JSON-RPC Support

The first implementation should support the stable app-server lifecycle needed for a Weixin bot. The transport is stdio JSONL: each line is one JSON-RPC-style message, and messages do not need a `"jsonrpc": "2.0"` field.

### Required Outgoing Messages

The main process must send these requests and notifications:

```text
initialize
initialized
thread/start
thread/resume
turn/start
```

Startup flow:

```text
spawn codex app-server
  -> initialize
  -> initialized
```

Turn flow:

```text
resolve sender thread
  -> thread/resume or thread/start
  -> turn/start
  -> collect agent output
  -> wait for turn/completed
  -> return final text to channel worker
```

Minimum `initialize` request:

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "codex_claw",
      "title": "Codex Claw",
      "version": "0.1.0"
    }
  }
}
```

After `initialize` succeeds, send:

```json
{
  "method": "initialized",
  "params": {}
}
```

Minimum `turn/start` request:

```json
{
  "method": "turn/start",
  "id": 3,
  "params": {
    "threadId": "...",
    "cwd": "$CODEX_CLAW_HOME/workspace",
    "input": [
      { "type": "text", "text": "..." }
    ]
  }
}
```

`model`, `sandbox`, approval policy, personality, and reasoning settings should be configuration-driven. Do not hard-code them in the protocol wrapper.

### Required Incoming Messages

The JSON-RPC client must handle request responses:

```ts
type CodexResponse =
  | { id: number | string; result: unknown }
  | { id: number | string; error: { code?: number; message: string; data?: unknown } };
```

It must also handle notifications:

```text
turn/started
item/agentMessage/delta
item/completed
turn/completed
```

Output collection rules:

- Prefer collecting `item/agentMessage/delta` text as the streaming output.
- Also inspect completed agent-message items in `item/completed` for versions that emit complete text there.
- Treat `turn/completed` as the end of the current turn.
- If the turn completes without agent text, return a clear fallback error to Weixin.
- If any response contains `error`, fail the pending request and include the app-server error message in logs.

The client should tolerate unknown notifications by logging them at debug level and continuing.

### Thread Operations

The app-server wrapper should expose these internal operations:

```ts
startThread(options?: StartThreadOptions): Promise<string>;
resumeThread(threadId: string): Promise<string>;
runTurn(threadId: string, text: string, options?: RunTurnOptions): Promise<string>;
```

If `thread/resume` fails because the thread no longer exists, cannot be loaded, or is incompatible with the current app-server state, create a new thread with `thread/start` and update the sender mapping.

### Per-sender Concurrency

Turns must be serialized per Weixin sender or per Codex thread.

Suggested rule:

```text
sender A messages: queued and processed in order
sender B messages: may run concurrently with sender A
```

This avoids overlapping `turn/start` calls on the same Codex thread.

### Timeout and Cancellation

Support:

```text
CODEX_CLAW_TURN_TIMEOUT_MS
```

When a turn exceeds the timeout:

1. Attempt `turn/interrupt` if supported by the current app-server schema.
2. Mark the turn failed.
3. Reply to Weixin with a timeout message.
4. If app-server becomes unhealthy, restart it and resume or recreate the affected thread on the next message.

`turn/interrupt` is an enhancement target for the first robust version. The MVP may log the timeout and restart app-server if interruption is not available.

### Approval and Sandbox Behavior

The Weixin bridge should not blindly approve high-risk Codex actions.

Recommended default:

```text
sandbox=workspace-write
cwd=$CODEX_CLAW_HOME/workspace
```

Approval behavior should be configurable. If Codex is waiting for an approval that cannot be handled through the JSON-RPC wrapper yet, reply to Weixin with a message telling the user to handle the approval locally in Codex.

Do not implement Weixin-side approval for destructive or broad-access actions in the first version.

### App-server Health State

The main process should track:

```ts
type AppServerStatus = "starting" | "ready" | "busy" | "failed" | "stopped";
```

Status data should include:

- app-server process id.
- current status.
- active turn count.
- known thread count.
- last error message.
- last completed turn time.

This state powers the `/status` command.

### Enhancement Targets

The protocol wrapper should be designed so these can be added later:

```text
thread/fork
thread/archive
thread/list
turn/steer
turn/interrupt
approval-related notifications and responses
schema generation with codex app-server generate-ts
```

Before implementing advanced methods, generate app-server TypeScript schemas for the installed Codex version:

```bash
codex app-server generate-ts --out ./schemas
```

## Thread Model

Each Weixin sender should map to one Codex thread by default.

Store thread mappings in:

```text
$CODEX_CLAW_HOME/state/threads.json
```

Suggested shape:

```json
{
  "wx_user_id": {
    "threadId": "..."
  }
}
```

Messages from the same Weixin sender continue the same Codex thread unless the sender resets the conversation.

## Weixin Behavior

At startup, the channel worker should resolve credentials in this order:

1. `WX_ACCOUNT_ID` and `WX_TOKEN` from environment variables.
2. Stored credentials from `$CODEX_CLAW_HOME/channel`.
3. QR login.

On incoming messages:

- Ignore empty text messages.
- Optionally restrict senders using `WX_ALLOW_FROM` or `WeixinChannelOptions.allowFrom`.
- Ask the channel worker to send typing before starting a Codex turn.
- Send Codex output back to the original sender.
- Split long replies into multiple Weixin messages.

### Waiting Message Merge

For the same Weixin sender, only one Codex turn may be active at a time. If new ordinary text messages arrive while that sender's Codex turn is still running, store them in a pending buffer instead of starting another turn immediately.

When the active turn completes:

1. Wait for `CODEX_CLAW_COALESCE_MS` to catch late follow-up messages.
2. Merge the pending messages into the next Codex turn.
3. Clear the pending buffer.

If there is only one pending message, send it as-is. If there are two or more pending messages, wrap them as:

```text
以下是用户在等待期间连续发送的消息，请作为同一个请求处理：

---
msg1


msg2


msg3
---
```

The join rule is exactly:

```ts
messages.join("\n\n\n")
```

Commands are not merged:

- `/help` replies immediately.
- `/status` replies immediately.
- `/new`, `/reset`, and `/新会话` clear the sender's pending buffer and reset the sender's Codex thread mapping.

## Built-in Commands

Support these commands from Weixin:

```text
/help       Show available commands.
/status     Show channel, app-server, and thread status.
/new        Clear the current sender's Codex thread.
/reset      Alias of /new.
/新会话      Alias of /new.
```

Commands should be handled by the main process before sending text to Codex.

## Workspace Integration

Add:

```text
codex-claw/
  package.json
  tsconfig.json
  src/
    main.ts
    home.ts
    channel-worker.ts
    channel-rpc.ts
    codex-app-server.ts
    thread-store.ts
    commands.ts
    text.ts
```

Update:

```text
pnpm-workspace.yaml
package.json
```

Suggested root script:

```json
{
  "scripts": {
    "claw": "pnpm --filter codex-claw dev"
  }
}
```

## Non-goals

- Do not reimplement the Weixin channel protocol.
- Do not store channel data in `~/.openclaw`.
- Do not use the repository as Codex's working directory.
- Do not use `codex exec` for the main interactive bot flow.
- Do not require Codex.app GUI interaction for normal message handling.

## Open Questions

- Channel worker restart policy: restart forever, fixed retries, or fail-fast.
- Whether Codex app-server should be one process for all senders or restarted on failure with thread resume.
- Maximum Weixin reply chunk size.
- Whether non-text media messages should be ignored, summarized, or forwarded as files into the Codex workspace.
- Whether sender authorization should default to deny unless `WX_ALLOW_FROM` is set.
