import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// 会话持久化：一个 threadId 对应一个 Pi 会话文件（JSONL），index.json 保存线程元数据与用户归属。
// 恢复以会话文件为准；索引只负责查找、标题和计数，缺失/损坏时退化为“找不到线程”，不让服务起不来。

export type ThreadRecord = {
  threadId: string;
  userId: string;
  sessionFile: string;
  title: string;
  turns: number;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HistoryPart =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: string;
      isError?: boolean;
    };

export type HistoryMessage = {
  role: string;
  text: string;
  parts?: HistoryPart[];
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function spokenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const item = asRecord(part);
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    if (item.type === "toolCall" && typeof item.name === "string") parts.push(`[调用 ${item.name}]`);
  }
  return parts.join("\n");
}

export function conclusionOf(text: string) {
  const index = text.indexOf("结论：");
  if (index < 0) return text.trim();
  return text.slice(index).trim();
}

function safeThreadId(threadId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) throw new ThreadAccessError(400, "线程编号不合法");
  return threadId;
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

  rename(threadId: string, userId: string, title: string) {
    const record = this.owned(threadId, userId);
    record.title = title.trim().slice(0, 60);
    record.updatedAt = new Date().toISOString();
    this.save();
    return record;
  }

  archive(threadId: string, userId: string, archived: boolean) {
    const record = this.owned(threadId, userId);
    record.archived = archived;
    record.updatedAt = new Date().toISOString();
    this.save();
    return record;
  }

  remove(threadId: string, userId: string) {
    const record = this.owned(threadId, userId);
    this.records.delete(record.threadId);
    this.save();
    for (const file of [record.sessionFile, this.traceFile(record.threadId)]) {
      const fromRoot = relative(this.dir, file);
      if (fromRoot.startsWith("..") || fromRoot.startsWith("/")) continue;
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }

  appendRound(threadId: string, round: unknown) {
    const id = safeThreadId(threadId);
    const rounds = this.readRounds(id);
    rounds.push(round);
    writeFileSync(this.traceFile(id), JSON.stringify(rounds));
  }

  readRounds(threadId: string): unknown[] {
    try {
      const raw = JSON.parse(readFileSync(this.traceFile(safeThreadId(threadId)), "utf8")) as unknown;
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private owned(threadId: string, userId: string) {
    const record = this.records.get(safeThreadId(threadId));
    if (!record) throw new ThreadAccessError(404, "线程不存在或已被清理");
    if (record.userId !== userId) throw new ThreadAccessError(403, "这个线程属于其他用户");
    return record;
  }

  private traceFile(threadId: string) {
    return join(this.dir, `${threadId}.trace.json`);
  }

  history(threadId: string, userId: string) {
    const { record, sessionManager } = this.open(threadId, userId);
    const messages = historyMessages(sessionManager.buildSessionContext().messages);
    return { thread: record, messages, rounds: this.readRounds(threadId) };
  }
}

function historyMessages(source: readonly unknown[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  let assistant: HistoryMessage | null = null;
  const flush = () => {
    if (!assistant) return;
    const text = assistant.parts?.find((part) => part.type === "text");
    assistant.text = text && text.type === "text" ? text.text : assistant.text;
    if (assistant.text || assistant.parts?.some((part) => part.type === "tool-call")) messages.push(assistant);
    assistant = null;
  };
  for (const message of source) {
    const item = asRecord(message);
    const role = typeof item.role === "string" ? item.role : "unknown";
    if (role === "toolResult") {
      const callId = String(item.toolCallId ?? "");
      const text = textOf(item.content);
      const part = assistant?.parts?.find((entry) => entry.type === "tool-call" && entry.toolCallId === callId);
      if (part && part.type === "tool-call") {
        part.result = text;
        part.isError = item.isError === true || text.startsWith("已拦截") || text.startsWith("无法查询");
      }
      continue;
    }
    if (role === "assistant") {
      if (!assistant) assistant = { role: "assistant", text: "", parts: [] };
      if (Array.isArray(item.content)) {
        for (const raw of item.content) {
          const part = asRecord(raw);
          if (part.type !== "toolCall") continue;
          assistant.parts?.push({
            type: "tool-call",
            toolCallId: String(part.id ?? ""),
            toolName: String(part.name ?? "query_data"),
            args: asRecord(part.arguments),
          });
        }
      }
      const spoken = conclusionOf(spokenText(item.content));
      if (spoken) {
        assistant.parts?.push({ type: "text", text: spoken });
        assistant.text = spoken;
      }
      continue;
    }
    flush();
    const text = textOf(item.content);
    if (!text || text.startsWith("[系统注入的用户偏好")) continue;
    messages.push({ role, text });
  }
  flush();
  return messages;
}
