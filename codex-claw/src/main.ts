import path from "node:path";

import { CodexAppServerClient } from "./codex-app-server.js";
import { ChannelSupervisor } from "./channel-supervisor.js";
import { loadConfig } from "./home.js";
import { createLogger } from "./logger.js";
import { MessageRouter } from "./message-router.js";
import { ThreadStore } from "./thread-store.js";

function formatUnknown(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

async function main(): Promise<void> {
  const { paths, config } = loadConfig();
  const logger = createLogger(paths.logs);
  logger.info(`codex-claw starting home=${paths.home}`);

  const threadStore = new ThreadStore(path.join(paths.state, "threads.json"));
  const codex = new CodexAppServerClient(config, paths, logger, () => threadStore.size);
  const channel = new ChannelSupervisor(config, paths, logger);
  const router = new MessageRouter(config, channel, codex, threadStore, logger);

  channel.onMessage((message) => router.handleInbound(message));

  let shutdownStarted = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info(`received ${reason}, stopping...`);
    const results = await Promise.allSettled([channel.stop(), codex.stop()]);
    for (const result of results) {
      if (result.status === "rejected") logger.warn(`shutdown cleanup failed: ${formatUnknown(result.reason)}`);
    }
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.once("uncaughtException", (err) => {
    logger.error(`uncaughtException: ${formatUnknown(err)}`);
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (reason) => {
    logger.error(`unhandledRejection: ${formatUnknown(reason)}`);
    void shutdown("unhandledRejection", 1);
  });

  try {
    logger.info("starting codex app-server client");
    await codex.start();
    logger.info("codex app-server client ready");
    logger.info("starting channel worker");
    await channel.start();
    logger.info("channel worker ready");
    logger.info("codex-claw ready");
  } catch (err) {
    logger.error(`startup failed: ${formatUnknown(err)}`);
    await shutdown("startup failure", 1);
  }
}

main().catch((err) => {
  console.error(`[codex-claw] fatal: ${String(err)}`);
  process.exit(1);
});
