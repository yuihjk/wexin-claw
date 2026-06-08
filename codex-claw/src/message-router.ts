import path from "node:path";

import type { ChannelSupervisor } from "./channel-supervisor.js";
import type { CodexAppServerClient } from "./codex-app-server.js";
import { handleCommand } from "./commands.js";
import type { Logger } from "./logger.js";
import { SenderQueue } from "./sender-queue.js";
import { splitReply } from "./text.js";
import type { ClawConfig, InboundWeixinMessage } from "./types.js";
import { ThreadStore } from "./thread-store.js";

export class MessageRouter {
  private readonly queue: SenderQueue;

  constructor(
    private readonly config: ClawConfig,
    private readonly channel: ChannelSupervisor,
    private readonly codex: CodexAppServerClient,
    private readonly threadStore: ThreadStore,
    private readonly logger: Logger,
  ) {
    this.queue = new SenderQueue({
      coalesceMs: config.coalesceMs,
      maxPendingMessages: config.maxPendingMessagesPerSender,
      maxPendingChars: config.maxPendingCharsPerSender,
      onState: (message) => this.logger.info(message),
      onQueued: async (senderId) => {
        await this.channel.sendText(senderId, "Codex 还在处理上一条消息，已把这条加入等待合并。");
      },
      onDropped: async (senderId, droppedCount) => {
        this.logger.warn(`queue dropped pending messages sender=${shortId(senderId)} count=${droppedCount}`);
        await this.channel.sendText(senderId, "等待队列太长，已丢弃较早的待处理消息。");
      },
    });
  }

  async handleInbound(message: InboundWeixinMessage): Promise<void> {
    const text = message.text.trim();
    this.logger.info(`router inbound from=${shortId(message.from)} message=${message.messageId} rawChars=${message.text.length} trimmedChars=${text.length}`);
    if (!text) {
      this.logger.info(`router ignored empty message from=${shortId(message.from)} message=${message.messageId}`);
      return;
    }

    const commandReply = handleCommand(text, {
      senderId: message.from,
      resetThread: () => {
        this.threadStore.delete(message.from);
        this.queue.reset(message.from);
      },
      getStatus: () => ({
        channel: this.channel.getStatus(),
        codex: this.codex.getStatus(),
        pending: this.queue.getPendingCount(message.from),
      }),
    });
    if (commandReply) {
      this.logger.info(`router command handled from=${shortId(message.from)} command=${text.split(/\s+/, 1)[0]} replyChars=${commandReply.length}`);
      await this.channel.sendText(message.from, commandReply);
      return;
    }

    this.logger.info(`router enqueue codex message from=${shortId(message.from)} chars=${text.length}`);
    this.queue.enqueue(message.from, text, async (mergedText) => {
      await this.processCodexMessage(message.from, mergedText);
    });
  }

  private async processCodexMessage(senderId: string, text: string): Promise<void> {
    try {
      this.logger.info(`router codex processing start sender=${shortId(senderId)} chars=${text.length}`);
      await this.channel.sendTyping(senderId).catch((err) => {
        this.logger.warn(`sendTyping failed: ${String(err)}`);
      });
      const threadId = await this.resolveThread(senderId);
      const response = await this.codex.runTurn(threadId, text);
      const chunks = splitReply(response, this.config.maxReplyChars);
      this.logger.info(`router codex response sender=${shortId(senderId)} thread=${threadId} responseChars=${response.length} chunks=${chunks.length || 1}`);
      for (const chunk of chunks.length ? chunks : ["Codex 本轮没有返回文本。"]) {
        await this.channel.sendText(senderId, chunk);
      }
      this.logger.info(`router codex processing done sender=${shortId(senderId)} thread=${threadId}`);
    } catch (err) {
      this.logger.error(`Codex turn failed for sender=${senderId}: ${String(err)}`);
      try {
        await this.channel.sendText(senderId, `Codex 处理失败：${String(err)}`);
      } catch (sendErr) {
        this.logger.error(`failed to send Codex error to sender=${shortId(senderId)}: ${String(sendErr)}`);
      }
    }
  }

  private async resolveThread(senderId: string): Promise<string> {
    const existing = this.threadStore.get(senderId);
    if (existing) {
      try {
        const resumed = await this.codex.resumeThread(existing);
        this.threadStore.set(senderId, resumed);
        return resumed;
      } catch (err) {
        this.logger.warn(`thread resume failed sender=${senderId} thread=${existing}: ${String(err)}`);
      }
    }
    const created = await this.codex.startThread();
    this.threadStore.set(senderId, created);
    this.logger.info(`created thread sender=${senderId} thread=${created} store=${path.join(this.config.home, "state", "threads.json")}`);
    return created;
  }
}

function shortId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
