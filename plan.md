# Plan: local `openclaw-weixin` fork + TypeScript wrapper + demo

## Goal

Use pnpm to build this repo as a small workspace with three local packages:

- `openclaw-weixin/`: local fork of the WeChat channel package, renamed as an unscoped local package and modified to remove `openclaw` runtime usage.
- `wx-channel-wrapper/`: library wrapper that depends on the local fork, not on the published `@tencent-weixin/openclaw-weixin` package.
- `wx-channel-demo/`: demo that calls the wrapper to bind handlers, receive messages, and send replies.

Important boundary:

- `wx-channel-wrapper` will **not** depend on `openclaw`.
- `wx-channel-wrapper` will **not** depend on the published `@tencent-weixin/openclaw-weixin` package.
- The local `openclaw-weixin/` fork will be treated as the source package used by the wrapper.
- The fork becomes a standalone WeChat channel library for this project, not a standard OpenClaw plugin package.

## Package naming

Recommended local package name:

```json
{
  "name": "openclaw-weixin"
}
```

Wrapper dependency:

```json
{
  "dependencies": {
    "openclaw-weixin": "workspace:*"
  }
}
```

The directory remains:

```text
openclaw-weixin/
```

Only the package name changes.

## Files/directories involved

```text
package.json
pnpm-workspace.yaml
tsconfig.base.json
plan.md
openclaw-weixin/
  package.json
  tsconfig.json
  index.ts
  src/**
wx-channel-wrapper/
  package.json
  tsconfig.json
  src/index.ts
  src/types.ts
  src/credentials.ts
  src/receive-loop.ts
  src/channel.ts
wx-channel-demo/
  package.json
  tsconfig.json
  src/main.ts
```

## Workspace setup

Root `package.json`:

- `private: true`
- package manager: pnpm
- scripts:
  - `typecheck`: run typecheck across workspace packages
  - `demo`: run `wx-channel-demo`
- dev dependencies: `typescript`, `tsx`

Root `pnpm-workspace.yaml`:

```yaml
packages:
  - openclaw-weixin
  - wx-channel-wrapper
  - wx-channel-demo
```

## Modify local `openclaw-weixin` fork

### `openclaw-weixin/package.json`

Change from published OpenClaw plugin package to local standalone fork:

- Rename package:
  - from `@tencent-weixin/openclaw-weixin`
  - to `openclaw-weixin`
- Remove `peerDependencies.openclaw`.
- Remove `devDependencies.openclaw`.
- Remove or ignore the `openclaw` metadata block because this fork is no longer packaged as a standard OpenClaw plugin for this repo.
- Keep runtime dependencies needed by the channel code, e.g. `qrcode-terminal`, `zod`.

### Remove OpenClaw SDK imports from fork source

Current OpenClaw imports found in local source:

- `index.ts`
- `src/channel.ts`
- `src/monitor/monitor.ts`
- `src/util/logger.ts`
- `src/auth/pairing.ts`
- `src/auth/accounts.ts`
- `src/messaging/send.ts`
- `src/messaging/outbound-hooks.ts`
- `src/messaging/process-message.ts`

The fork should remove all imports like:

```ts
openclaw/plugin-sdk/*
```

### Compatibility helpers to add inside fork

Add a small local compatibility module, for example:

```text
openclaw-weixin/src/standalone/openclaw-compat.ts
```

It will provide minimal replacements needed by the reusable channel code:

```ts
export type OpenClawConfig = {
  channels?: Record<string, unknown>;
};

export function normalizeAccountId(id: string): string;
export function resolvePreferredOpenClawTmpDir(): string;
export async function withFileLock<T>(filePath: string, options: unknown, fn: () => Promise<T>): Promise<T>;
export type ReplyPayload = { text?: string };
```

Implementation notes:

- `normalizeAccountId` should preserve current expected behavior well enough for Weixin IDs:
  - trim
  - lowercase where appropriate
  - replace unsupported filename/package characters consistently
- `resolvePreferredOpenClawTmpDir` can use:
  - `OPENCLAW_TMP_DIR`
  - `TMPDIR`
  - `os.tmpdir()` fallback
- `withFileLock` can start as a local serialized/no-op lock for this wrapper/demo use case.
- `OpenClawConfig` is only needed for config-shaped data used by account resolution.
- `ReplyPayload` only needs the text fields actually used by `sendMessageWeixin`.

### Specific fork source changes

#### `src/util/logger.ts`

Replace:

```ts
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
```

with local import from the compatibility helper.

#### `src/auth/accounts.ts`

Replace:

```ts
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
```

with local compatibility imports.

Change `triggerWeixinChannelReload()` so it no longer dynamically imports:

```ts
openclaw/plugin-sdk/config-runtime
```

For this standalone fork it can be a no-op that logs a debug/info message.

#### `src/auth/pairing.ts`

Replace:

```ts
import { withFileLock } from "openclaw/plugin-sdk/infra-runtime";
```

with local compatibility import.

#### `src/messaging/send.ts`

Replace:

```ts
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
```

with local compatibility type import.

#### Plugin/runtime-only modules

These modules are OpenClaw gateway integration code and are not needed by the wrapper:

- `index.ts`
- `src/channel.ts`
- `src/monitor/monitor.ts`
- `src/messaging/process-message.ts`
- `src/messaging/outbound-hooks.ts`

Recommended approach:

- Make `index.ts` export standalone low-level modules/types, not an OpenClaw plugin entry.
- Exclude gateway-only modules from the fork build/typecheck, or rewrite them as standalone stubs with no `openclaw` imports.
- The wrapper must not import these gateway-only modules.

The reusable modules for wrapper are:

- `src/api/api.ts`
- `src/api/types.ts`
- `src/messaging/send.ts`
- `src/messaging/inbound.ts`
- `src/storage/sync-buf.ts`
- `src/auth/login-qr.ts`
- `src/auth/accounts.ts`

## Wrapper public API

`wx-channel-wrapper/src/types.ts`:

```ts
import type { WeixinMessage } from "openclaw-weixin/src/api/types.js";

export interface WeixinCredentials {
  accountId: string;
  token: string;
  baseUrl?: string;
}

export interface WeixinChannelOptions {
  credentials: WeixinCredentials;
  longPollTimeoutMs?: number;
  persistCursor?: boolean;
  notifyOnStartStop?: boolean;
}

export interface InboundMessage {
  messageId: string;
  accountId: string;
  from: string;
  to?: string;
  text: string;
  contextToken?: string;
  hasMedia: boolean;
  timestamp?: number;
  raw: WeixinMessage;
}

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;
```

`wx-channel-wrapper/src/channel.ts`:

```ts
export class WeixinChannel {
  constructor(options: WeixinChannelOptions);
  onMessage(handler: MessageHandler): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(to: string, text: string): Promise<{ messageId: string }>;
  sendTyping(to: string): Promise<void>;
}
```

Behavior:

- `start()` is idempotent.
- `stop()` aborts the long-poll request and sends `notifyStop` when enabled.
- `onMessage()` supports multiple handlers and returns an unsubscribe function.
- `sendText()` resolves the latest `contextToken` for the target user and calls the local fork's `sendMessageWeixin`.
- v1 focuses on text messages. Inbound media is exposed via `hasMedia` and `raw`; media download/upload can be added later.

## Receive loop design

`wx-channel-wrapper/src/receive-loop.ts` will implement a slim loop using the local fork:

1. Load `get_updates_buf` via `loadGetUpdatesBuf` when `persistCursor !== false`.
2. Repeatedly call `getUpdates({ baseUrl, token, get_updates_buf, timeoutMs, abortSignal })`.
3. Save returned cursor via `saveGetUpdatesBuf`.
4. For each inbound `WeixinMessage`:
   - cache `msg.context_token` using `setContextToken(accountId, msg.from_user_id, msg.context_token)`;
   - normalize text via `weixinMessageToMsgContext`;
   - build `InboundMessage`;
   - dispatch to registered handlers.
5. Handler errors are caught and logged without stopping the loop.
6. Non-zero `ret` / `errcode` uses bounded retry/backoff.

## Credentials design

`wx-channel-wrapper/src/credentials.ts` exports:

```ts
loadCredentialsFromEnv(): WeixinCredentials | null;
loadStoredCredentials(accountId: string): WeixinCredentials | null;
loginWithQr(options?: { accountId?: string; timeoutMs?: number }): Promise<WeixinCredentials>;
```

Environment variables:

- `WX_ACCOUNT_ID`
- `WX_TOKEN`
- `WX_BASE_URL` optional

QR login flow will reuse the local fork's QR-login helpers and persist via its account store.

## Demo behavior

`wx-channel-demo/src/main.ts`:

1. Load credentials from env.
2. If env credentials are missing, run QR login.
3. Create `new WeixinChannel({ credentials })`.
4. Bind a message handler:
   - print inbound sender/text;
   - echo text back with `sendText(message.from, ...)`.
5. Start the channel.
6. Handle `SIGINT` / `SIGTERM` by calling `stop()`.

This demonstrates binding, receiving, and sending.

## Validation

After implementation:

1. Run `pnpm install` at repo root.
2. Verify no workspace package depends on `openclaw`:

```bash
pnpm why openclaw
```

Expected: no dependency path from wrapper/demo/fork.

3. Run typecheck for workspace packages.
4. Run an import smoke test for `wx-channel-wrapper`.
5. Run demo with env credentials or QR login:

```bash
pnpm --filter wx-channel-demo dev
```

Then send a message to the WeChat bot and verify the demo logs the inbound message and replies with echo text.
