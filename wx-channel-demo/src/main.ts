import { WeixinChannel, loadCredentialsFromEnv, loadStoredCredentials, loginWithQr } from "wx-channel-wrapper";
import type { WeixinCredentials } from "wx-channel-wrapper";

async function resolveCredentials(): Promise<WeixinCredentials> {
  const envCredentials = loadCredentialsFromEnv();
  if (envCredentials) {
    console.log(`[demo] using credentials from env for account=${envCredentials.accountId}`);
    return envCredentials;
  }

  const accountId = process.env.WX_ACCOUNT_ID?.trim();
  if (accountId) {
    const stored = loadStoredCredentials(accountId);
    if (stored) {
      console.log(`[demo] using stored credentials for account=${stored.accountId}`);
      return stored;
    }
  }

  console.log("[demo] WX_ACCOUNT_ID/WX_TOKEN not found; starting QR login.");
  return await loginWithQr({ accountId, verbose: true });
}

async function main(): Promise<void> {
  const credentials = await resolveCredentials();
  const channel = new WeixinChannel({ credentials });

  channel.onMessage(async (message) => {
    const preview = message.text || (message.hasMedia ? "[media]" : "[empty]");
    console.log(`[in] from=${message.from} text=${JSON.stringify(preview)}`);

    if (!message.text.trim()) return;
    await channel.sendTyping(message.from).catch((err) => {
      console.warn(`[demo] sendTyping failed: ${String(err)}`);
    });
    const result = await channel.sendText(message.from, `echo: ${message.text}`);
    console.log(`[out] to=${message.from} messageId=${result.messageId}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[demo] received ${signal}, stopping...`);
    try {
      await channel.stop();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await channel.start();
  console.log(`[demo] listening with account=${credentials.accountId}`);
}

main().catch((err) => {
  console.error(`[demo] fatal: ${String(err)}`);
  process.exit(1);
});
