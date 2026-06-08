import fs from "node:fs";
import path from "node:path";

type ThreadRecord = {
  threadId: string;
  updatedAt: string;
};

type ThreadStoreFile = Record<string, ThreadRecord>;

export class ThreadStore {
  private data: ThreadStoreFile = {};

  constructor(private readonly filePath: string) {
    this.load();
  }

  get size(): number {
    return Object.keys(this.data).length;
  }

  get(senderId: string): string | undefined {
    return this.data[senderId]?.threadId;
  }

  set(senderId: string, threadId: string): void {
    this.data[senderId] = { threadId, updatedAt: new Date().toISOString() };
    this.save();
  }

  delete(senderId: string): void {
    delete this.data[senderId];
    this.save();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as ThreadStoreFile;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.data = parsed;
      }
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
}
