import path from "node:path";

import { buildPaths, ensureHomeLayout } from "./home.js";
import { isChannelRequest, sendToParent, type ChannelRequest } from "./channel-rpc.js";

let stopping = false;

async function resolveCredentials(wrapper: typeof import("wx-channel-wrapper")) {
  const envCredentials = wrapper.loadCredentialsFromEnv();
  if (envCredentials) {
    console.log(`[codex-claw:channel] using credentials from env for account=${envCredentials.accountId}`);
    return envCredentials;
  }

  const accountId = process.env.WX_ACCOUNT_ID?.trim();
  if (accountId) {
    const stored = wrapper.loadStoredCredentials(accountId);
    if (stored) {
      console.log(`[codex-claw:channel] using stored credentials for account=${stored.accountId}`);
      return stored;
    }
  }

  const latestStored = wrapper.loadLatestStoredCredentials();
  if (latestStored) {
    console.log(`[codex-claw:channel] using latest stored credentials for account=${latestStored.accountId}`);
    return latestStored;
  }

  console.log("[codex-claw:channel] credentials not found; starting QR login.");
  return await wrapper.loginWithQr({ accountId, verbose: true });
}

async function main(): Promise<void> {
  const paths = buildPaths(process.env.CODEX_CLAW_HOME);
  ensureHomeLayout(paths);
  process.chdir(paths.home);

  process.env.OPENCLAW_STATE_DIR = paths.channel;
  process.env.OPENCLAW_TMP_DIR = paths.channelTmp;
  process.env.OPENCLAW_OAUTH_DIR = paths.channelCredentials;

  const wrapper = await import("wx-channel-wrapper");
  const credentials = await resolveCredentials(wrapper);
  const allowFrom = process.env.WX_ALLOW_FROM?.split(",").map((item) => item.trim()).filter(Boolean);
  const channel = new wrapper.WeixinChannel({
    credentials,
    allowFrom: allowFrom?.length ? allowFrom : undefined,
  });

  channel.onMessage((message) => {
    console.log(`[codex-claw:channel] inbound from=${shortId(message.from)} message=${message.messageId} chars=${message.text.length} hasMedia=${message.hasMedia}`);
    sendToParent({
      type: "message",
      message: {
        messageId: message.messageId,
        accountId: message.accountId,
        from: message.from,
        to: message.to,
        text: message.text,
        contextToken: message.contextToken,
        hasMedia: message.hasMedia,
        timestamp: message.timestamp,
      },
    });
  });

  process.on("message", (raw) => {
    if (!isChannelRequest(raw)) return;
    void handleRequest(raw, channel);
  });

  process.once("disconnect", () => void stop(channel, "parent disconnect"));
  process.once("SIGINT", () => void stop(channel, "SIGINT"));
  process.once("SIGTERM", () => void stop(channel, "SIGTERM"));

  await channel.start();
  sendToParent({ type: "ready", accountId: credentials.accountId });
  console.log(`[codex-claw:channel] ready account=${credentials.accountId} home=${paths.home} channel=${path.relative(paths.home, paths.channel)}`);
}

async function handleRequest(request: ChannelRequest, channel: import("wx-channel-wrapper").WeixinChannel): Promise<void> {
  try {
    if (request.method === "sendText") {
      console.log(`[codex-claw:channel] sendText to=${shortId(request.params.to)} chars=${request.params.text.length}`);
      const result = await channel.sendText(request.params.to, request.params.text);
      console.log(`[codex-claw:channel] sendText ok to=${shortId(request.params.to)} messageId=${result.messageId}`);
      sendToParent({ id: request.id, ok: true, result });
      return;
    }
    if (request.method === "sendTyping") {
      console.log(`[codex-claw:channel] sendTyping to=${shortId(request.params.to)}`);
      await channel.sendTyping(request.params.to);
      sendToParent({ id: request.id, ok: true });
      return;
    }
    if (request.method === "stop") {
      sendToParent({ id: request.id, ok: true });
      await stop(channel, "parent stop request");
      return;
    }
  } catch (err) {
    console.error(`[codex-claw:channel] request failed method=${request.method}: ${String(err)}`);
    sendToParent({ id: request.id, ok: false, error: String(err) });
  }
}

async function stop(channel: import("wx-channel-wrapper").WeixinChannel, reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[codex-claw:channel] stopping reason=${reason}`);
  try {
    await channel.stop();
  } finally {
    sendToParent({ type: "stopped" });
    process.exit(0);
  }
}

main().catch((err) => {
  sendToParent({ type: "error", error: String(err) });
  console.error(`[codex-claw:channel] fatal: ${String(err)}`);
  process.exit(1);
});

function shortId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
