import { mergeWaitingMessages, pendingCharCount } from "./text.js";

type SenderState = {
  running: boolean;
  pending: string[];
  pendingNotified: boolean;
};

export type SenderQueueOptions = {
  coalesceMs: number;
  maxPendingMessages: number;
  maxPendingChars: number;
  onQueued?: (senderId: string) => Promise<void> | void;
  onDropped?: (senderId: string, droppedCount: number) => Promise<void> | void;
  onState?: (message: string) => void;
};

export class SenderQueue {
  private states = new Map<string, SenderState>();

  constructor(private readonly options: SenderQueueOptions) {}

  enqueue(senderId: string, text: string, run: (mergedText: string) => Promise<void>): void {
    const state = this.getState(senderId);
    if (!state.running) {
      this.options.onState?.(`queue start sender=${shortId(senderId)} chars=${text.length}`);
      state.running = true;
      void this.runLoop(senderId, text, run);
      return;
    }

    state.pending.push(text);
    const dropped = this.trimPending(state);
    if (dropped > 0) void this.options.onDropped?.(senderId, dropped);
    this.options.onState?.(`queue pending sender=${shortId(senderId)} pending=${state.pending.length} dropped=${dropped}`);
    if (!state.pendingNotified) {
      state.pendingNotified = true;
      void Promise.resolve(this.options.onQueued?.(senderId)).catch((err: unknown) => {
        this.options.onState?.(`queue onQueued failed sender=${shortId(senderId)} error=${String(err)}`);
      });
    }
  }

  reset(senderId: string): void {
    const state = this.getState(senderId);
    state.pending = [];
    state.pendingNotified = false;
    this.options.onState?.(`queue reset sender=${shortId(senderId)}`);
  }

  getPendingCount(senderId: string): number {
    return this.getState(senderId).pending.length;
  }

  private async runLoop(senderId: string, firstText: string, run: (mergedText: string) => Promise<void>): Promise<void> {
    const state = this.getState(senderId);
    let nextText = firstText;
    try {
      while (nextText) {
        await run(nextText);
        await this.coalesceDelay();
        const pending = state.pending.splice(0);
        state.pendingNotified = false;
        nextText = mergeWaitingMessages(pending);
        if (nextText) {
          this.options.onState?.(`queue merged sender=${shortId(senderId)} count=${pending.length} chars=${nextText.length}`);
        }
      }
    } finally {
      state.running = false;
      this.options.onState?.(`queue idle sender=${shortId(senderId)}`);
    }
  }

  private trimPending(state: SenderState): number {
    let dropped = 0;
    while (state.pending.length > this.options.maxPendingMessages) {
      state.pending.shift();
      dropped += 1;
    }
    while (pendingCharCount(state.pending) > this.options.maxPendingChars && state.pending.length > 1) {
      state.pending.shift();
      dropped += 1;
    }
    return dropped;
  }

  private coalesceDelay(): Promise<void> {
    if (this.options.coalesceMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.options.coalesceMs));
  }

  private getState(senderId: string): SenderState {
    let state = this.states.get(senderId);
    if (!state) {
      state = { running: false, pending: [], pendingNotified: false };
      this.states.set(senderId, state);
    }
    return state;
  }
}

function shortId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
