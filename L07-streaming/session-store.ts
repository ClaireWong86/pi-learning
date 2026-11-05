import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// 会话持久化：一个 threadId 对应一个 Pi 会话文件（JSONL），index.json 保存线程元数据与用户归属。
// 恢复以会话文件为准；索引只负责查找、标题和计数，缺失/损坏时退化为“找不到线程”，不让服务起不来。

export type ThreadRecord = {
  threadId: string;
  userId: string;
  sessionFile: string;
  title: string;
  turns: number;
  createdAt: string;
  updatedAt: string;
};

export class ThreadAccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type OpenedThread = {
  record: ThreadRecord;
  sessionManager: SessionManager;
  resumed: boolean;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as { type?: string; text?: string; name?: string };
    if (item.type === "text" && item.text) parts.push(item.text);
    if (item.type === "toolCall" && item.name) parts.push(`[调用 ${item.name}]`);
  }
  return parts.join("\n");
}

export class SalesSessionStore {
  readonly dir: string;
  private indexPath: string;
  private records = new Map<string, ThreadRecord>();

  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, "index.json");
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, "utf8")) as { threads?: ThreadRecord[] };
      for (const record of raw.threads ?? []) {
        if (record && typeof record.threadId === "string" && typeof record.sessionFile === "string") {
          this.records.set(record.threadId, record);
        }
      }
    } catch {
      // 没有索引或索引损坏：从空开始，旧会话文件留在目录里不删。
      this.records.clear();
    }
  }

  private save() {
    writeFileSync(this.indexPath, JSON.stringify({ threads: [...this.records.values()] }, null, 2));
  }

  create(userId: string, requestedId?: string): OpenedThread {
    const threadId = requestedId ?? randomUUID();
    const sessionManager = SessionManager.create(process.cwd(), this.dir, { id: threadId });
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("持久化会话没有生成文件路径");
    const now = new Date().toISOString();
    const record: ThreadRecord = { threadId, userId, sessionFile, title: "", turns: 0, createdAt: now, updatedAt: now };
    this.records.set(threadId, record);
    this.save();
    return { record, sessionManager, resumed: false };
  }

  open(threadId: string, userId: string): OpenedThread {
    const record = this.records.get(threadId);
    if (!record) throw new ThreadAccessError(404, "线程不存在或已被清理");
    if (record.userId !== userId) throw new ThreadAccessError(403, "这个线程属于其他用户");
    if (!existsSync(record.sessionFile)) throw new ThreadAccessError(404, "线程的会话文件不存在");
    const sessionManager = SessionManager.open(record.sessionFile, this.dir, process.cwd());
    const resumed = sessionManager.buildSessionContext().messages.length > 0;
    return { record, sessionManager, resumed };
  }

  // 前端/评测先生成 threadId 再发首条消息：首次出现按此 id 建线程，已存在则恢复并校验归属。
  openOrCreate(threadId: string, userId: string): OpenedThread {
    if (!this.records.has(threadId)) return this.create(userId, threadId);
    return this.open(threadId, userId);
  }

  recentFor(userId: string): ThreadRecord | null {
    return this.list(userId)[0] ?? null;
  }

  list(userId: string): ThreadRecord[] {
    return [...this.records.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  touch(record: ThreadRecord, firstMessage?: string) {
    record.turns += 1;
    record.updatedAt = new Date().toISOString();
    if (!record.title && firstMessage) record.title = firstMessage.slice(0, 60);
    this.save();
  }

  history(threadId: string, userId: string) {
    const { record, sessionManager } = this.open(threadId, userId);
    const messages = sessionManager
      .buildSessionContext()
      .messages.map((message) => {
        const item = message as { role?: string; content?: unknown };
        return { role: item.role ?? "unknown", text: textOf(item.content) };
      })
      // userMemory 扩展注入的系统偏好不是用户说的话，不进历史回显。
      .filter((item) => item.text && !item.text.startsWith("[系统注入的用户偏好"));
    return { thread: record, messages };
  }
}
