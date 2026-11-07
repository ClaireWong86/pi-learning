import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { bootSalesAgent, openSalesSession } from "./agent.ts";
import { setLive, type LiveEvent } from "./live.ts";
import { mountDataApi } from "./sales-api.ts";
import { dataHealth } from "./sales-query.ts";
import { resolveUser, USERS } from "./sales-data.ts";
import { SalesSessionStore, ThreadAccessError, type ThreadRecord } from "./session-store.ts";
import { linkDependencies, type TraceCall } from "./trace-model.ts";

type StreamEvent = {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: Array<{ text?: string }>; details?: unknown };
  isError?: boolean;
};

type ToolDetails = {
  ok?: boolean;
  group?: string | null;
  winner?: { key?: string; rank?: "min" | "max" } | null;
  groups?: Array<{ key?: string; amount?: number }> | null;
};

function sse(event: Record<string, unknown>) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function preview(text: string) {
  const line = text.split("\n").find((item) => item.startsWith("结果：") || item.startsWith("已拦截") || item.startsWith("无法查询"));
  return (line ?? text).slice(0, 240);
}

const boot = await bootSalesAgent();
const modelLabel = `${boot.model.provider}/${boot.model.id}`;

// 会话持久化：threadId -> 会话文件（见 session-store.ts）。活跃 session 缓存在内存里，
// 进程重启后按 threadId 从磁盘恢复。SALES_SESSION_DIR 可覆盖目录（评测/冒烟用临时目录）。
const here = dirname(fileURLToPath(import.meta.url));
const sessionStore = new SalesSessionStore(process.env.SALES_SESSION_DIR ?? join(here, "data", "sessions"));
type LiveSession = Awaited<ReturnType<typeof openSalesSession>>;
const liveSessions = new Map<string, { session: LiveSession; record: ThreadRecord }>();
const busyThreads = new Set<string>();

const app = express();
app.use(express.json());
mountDataApi(app);
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ model: modelLabel, tools: ["query_data"], ...dataHealth() });
});
app.get("/api/threads", (req: Request, res: Response) => {
  const user = resolveUser(typeof req.query.userId === "string" ? req.query.userId : "u002");
  if (!user) return res.status(400).json({ error: "未知用户" });
  const threads = sessionStore.list(user.id).map(({ sessionFile: _file, ...rest }) => rest);
  res.json({ threads });
});
function userFrom(value: unknown) {
  return resolveUser(typeof value === "string" ? value : "u002");
}

function publicThread(record: { sessionFile: string }) {
  const { sessionFile: _file, ...rest } = record;
  return rest;
}

app.get("/api/threads/:threadId/history", (req: Request, res: Response) => {
  const user = userFrom(req.query.userId);
  if (!user) return res.status(400).json({ error: "未知用户" });
  try {
    const { thread, messages, rounds } = sessionStore.history(String(req.params.threadId), user.id);
    res.json({ thread: publicThread(thread), messages, rounds });
  } catch (error) {
    if (error instanceof ThreadAccessError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.patch("/api/threads/:threadId", (req: Request, res: Response) => {
  const user = userFrom(req.body?.userId);
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!user) return res.status(400).json({ error: "未知用户" });
  if (!title) return res.status(400).json({ error: "标题不能为空" });
  try {
    const thread = sessionStore.rename(String(req.params.threadId), user.id, title);
    res.json({ thread: publicThread(thread) });
  } catch (error) {
    if (error instanceof ThreadAccessError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.post("/api/threads/:threadId/archive", (req: Request, res: Response) => {
  const user = userFrom(req.body?.userId);
  if (!user) return res.status(400).json({ error: "未知用户" });
  try {
    const thread = sessionStore.archive(String(req.params.threadId), user.id, true);
    res.json({ thread: publicThread(thread) });
  } catch (error) {
    if (error instanceof ThreadAccessError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.post("/api/threads/:threadId/unarchive", (req: Request, res: Response) => {
  const user = userFrom(req.body?.userId);
  if (!user) return res.status(400).json({ error: "未知用户" });
  try {
    const thread = sessionStore.archive(String(req.params.threadId), user.id, false);
    res.json({ thread: publicThread(thread) });
  } catch (error) {
    if (error instanceof ThreadAccessError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.delete("/api/threads/:threadId", async (req: Request, res: Response) => {
  const user = userFrom(req.query.userId);
  if (!user) return res.status(400).json({ error: "未知用户" });
  const threadId = String(req.params.threadId);
  try {
    const live = liveSessions.get(threadId);
    if (live) {
      liveSessions.delete(threadId);
      await live.session.abort().catch(() => undefined);
    }
    sessionStore.remove(threadId, user.id);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof ThreadAccessError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "public")));

function entryUserText(entry: { type?: string; message?: { role?: string; content?: unknown } }) {
  if (entry.type !== "message" || entry.message?.role !== "user") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: string; text?: string };
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("")
    .trim();
}

async function placeLeaf(session: LiveSession, target: string | null) {
  const current = session.sessionManager.getLeafId();
  if (target === current) return;
  if (target === null) {
    session.sessionManager.resetLeaf();
    session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
    return;
  }
  if (!session.sessionManager.getEntry(target)) return;
  await session.navigateTree(target);
}

async function rewindRepeatedQuestion(session: LiveSession, message: string) {
  let lastUser: { id: string; parentId: string | null; text: string } | undefined;
  for (const entry of session.sessionManager.getBranch()) {
    const text = entryUserText(entry);
    if (!text || text.startsWith("[系统注入的用户偏好")) continue;
    lastUser = { id: entry.id, parentId: entry.parentId, text };
  }
  if (!lastUser || lastUser.text !== message || session.sessionManager.getLeafId() === lastUser.id) return;
  await placeLeaf(session, lastUser.parentId);
}

app.post("/chat", async (req: Request, res: Response) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const requestedUser = typeof req.body?.userId === "string" ? req.body.userId : "u002";
  const user = resolveUser(requestedUser);
  const fresh = req.body?.fresh === true;
  const requestedThread = typeof req.body?.threadId === "string" && req.body.threadId ? req.body.threadId : null;
  if (!message) return res.status(400).json({ error: "message 不能为空" });
  if (!user) return res.status(400).json({ error: "未知用户" });

  // 选定线程：fresh 必新建；带 threadId 先看活跃缓存、再从磁盘恢复；都没传则续该用户最近的线程。
  let session: LiveSession;
  let record: ThreadRecord;
  let resumed = false;
  try {
    const cached = !fresh && requestedThread ? liveSessions.get(requestedThread) : undefined;
    if (cached) {
      if (cached.record.userId !== user.id) return res.status(403).json({ error: "这个线程属于其他用户" });
      session = cached.session;
      record = cached.record;
      resumed = true;
    } else {
      const opened = fresh
        ? sessionStore.create(user.id)
        : requestedThread
          ? sessionStore.openOrCreate(requestedThread, user.id)
          : sessionStore.recentFor(user.id)
            ? sessionStore.open(sessionStore.recentFor(user.id)!.threadId, user.id)
            : sessionStore.create(user.id);
      record = opened.record;
      resumed = opened.resumed;
      const existing = liveSessions.get(record.threadId);
      if (existing) {
        session = existing.session;
        resumed = true;
      } else {
        session = await openSalesSession(boot, opened.sessionManager);
        liveSessions.set(record.threadId, { session, record });
      }
    }
  } catch (error) {
    if (error instanceof ThreadAccessError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const threadId = record.threadId;
  if (busyThreads.has(threadId)) return res.status(429).json({ error: "这个线程正在处理上一条消息，稍等" });
  busyThreads.add(threadId);
  const continueFrom = typeof req.body?.continueFrom === "string" ? req.body.continueFrom : "";
  const regenerate = req.body?.regenerate === true;
  const forkFrom = regenerate ? (typeof req.body?.forkFrom === "string" ? req.body.forkFrom : null) : undefined;
  try {
    if (continueFrom) await placeLeaf(session, continueFrom);
    else if (regenerate) await placeLeaf(session, forkFrom ?? null);
    if (!continueFrom) await rewindRepeatedQuestion(session, message);
  } catch (error) {
    console.error("切换会话分支失败", error instanceof Error ? error.message : error);
  }
  const forkPoint = session.sessionManager.getLeafId();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const startedAt = Date.now();
  const turns: Array<{ index: number; startedAt: number; durationMs?: number }> = [];
  const calls: TraceCall[] = [];
  const callStarted = new Map<string, number>();
  const audits: Array<Record<string, unknown>> = [];

  const send = (event: Record<string, unknown>) => {
    if (!res.writableEnded && !res.destroyed) res.write(sse(event));
  };

  const ensureCall = (id: string) => {
    const found = calls.find((item) => item.id === id);
    if (found) return found;
    const created: TraceCall = { id, name: "query_data", turnIndex: turns.length || 1, args: {}, outcome: "running" };
    calls.push(created);
    return created;
  };

  setLive({
    user,
    input: message,
    blockedIds: new Set<string>(),
    toolCallCount: 0,
    seenToolCalls: new Set<string>(),
    emit(event: LiveEvent) {
      if (event.type === "guard" && typeof event.id === "string") {
        const call = ensureCall(event.id);
        if (event.blocked === true) {
          call.outcome = "blocked";
          if (typeof event.kind === "string") call.blockKind = event.kind;
          if (typeof event.reason === "string") call.blockReason = event.reason;
        } else if (event.effective) {
          call.effective = event.effective;
          if (event.tightened === true) call.tightened = true;
        }
      }
      if (event.type === "audit" && event.entry && typeof event.entry === "object") {
        const entry = event.entry as Record<string, unknown>;
        audits.push({ ...entry, id: typeof event.id === "string" ? event.id : undefined });
      }
      send(event);
    },
  });

  send({
    type: "trace_start",
    model: modelLabel,
    tools: ["query_data"],
    input: message,
    threadId,
    resumed,
    user: { id: user.id, name: user.name, scope: user.regions === "*" ? "全部地区" : user.regions.join("、") },
    startedAt,
  });

  const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? 10_000);
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, heartbeatMs);

  let settled = false;
  const off = session.subscribe((event) => {
    const streamed = event as StreamEvent;
    if (streamed.type === "turn_start") {
      turns.push({ index: turns.length + 1, startedAt: Date.now() });
      send({ type: "turn", phase: "start", index: turns.length });
      return;
    }
    if (streamed.type === "turn_end") {
      const turn = turns[turns.length - 1];
      if (turn && turn.durationMs === undefined) turn.durationMs = Date.now() - turn.startedAt;
      send({ type: "turn", phase: "end", index: turns.length, durationMs: turn?.durationMs });
      return;
    }
    if (streamed.type === "message_update") {
      const inner = streamed.assistantMessageEvent;
      if (inner?.type === "text_delta" && inner.delta) send({ type: "text", delta: inner.delta });
      if (inner?.type === "thinking_delta" && inner.delta) send({ type: "thinking", delta: inner.delta });
      return;
    }
    if (streamed.type === "tool_execution_start") {
      const id = streamed.toolCallId ?? `call-${calls.length + 1}`;
      callStarted.set(id, Date.now());
      const call = ensureCall(id);
      call.name = streamed.toolName ?? "query_data";
      call.turnIndex = turns.length || 1;
      call.args = streamed.args;
      send({ type: "tool_start", id, name: streamed.toolName, args: streamed.args, turnIndex: call.turnIndex });
      return;
    }
    if (streamed.type === "tool_execution_end") {
      const call = streamed.toolCallId ? calls.find((item) => item.id === streamed.toolCallId) : undefined;
      const text = streamed.result?.content?.map((part) => part.text ?? "").join("") ?? "";
      const details = streamed.result?.details as ToolDetails | undefined;
      const began = streamed.toolCallId ? callStarted.get(streamed.toolCallId) : undefined;
      const durationMs = began ? Date.now() - began : undefined;
      if (call) {
        if (call.outcome !== "blocked") {
          const failed = streamed.isError === true || details?.ok === false || text.startsWith("已拦截") || text.startsWith("无法查询");
          call.outcome = failed ? "error" : "ok";
        }
        call.resultPreview = preview(text);
        if (call.outcome === "ok") {
          call.group = details?.group ?? null;
          if (details?.winner?.key && details.winner.rank && details.group) {
            call.extremum = { group: details.group, rank: details.winner.rank, key: details.winner.key };
          }
          if (details?.groups) {
            call.groups = details.groups.filter((group) => group.key).map((group) => ({ key: String(group.key), amount: Number(group.amount ?? 0) }));
          }
        }
      }
      send({
        type: "tool_end",
        id: streamed.toolCallId,
        name: streamed.toolName,
        result: text,
        isError: streamed.isError === true || call?.outcome === "blocked" || call?.outcome === "error",
        durationMs,
      });
    }
  });

  res.on("close", () => {
    if (settled) return;
    clearInterval(heartbeat);
    off();
    setLive(null);
    void session.abort();
  });

  try {
    console.log(`💬 ${user.name} ${message}`);
    await session.prompt(message);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    send({ type: "error", message: text });
  } finally {
    settled = true;
    clearInterval(heartbeat);
    off();
    setLive(null);
    sessionStore.touch(record, message);
    for (const call of calls) if (call.outcome === "running") call.outcome = "error";
    const linked = linkDependencies(calls);
    for (const audit of audits) {
      const call = linked.find((item) => item.id === audit.id);
      if (call) call.audit = audit;
    }
    const durationMs = Date.now() - startedAt;
    sessionStore.appendRound(threadId, {
      input: message,
      model: modelLabel,
      user: user.name,
      scope: user.regions === "*" ? "全部地区" : user.regions.join("、"),
      duration: `${(durationMs / 1000).toFixed(1)} 秒`,
      turns: String(turns.length),
      callCount: String(linked.length),
      calls: linked,
      audits,
      done: true,
    });
    if (!res.writableEnded) {
      send({
        type: "trace_end",
        model: modelLabel,
        tools: ["query_data"],
        input: message,
        threadId,
        resumed,
        user: { id: user.id, name: user.name },
        durationMs,
        turns,
        calls: linked,
        leafId: session.sessionManager.getLeafId(),
        forkPoint,
      });
      send({ type: "done" });
      res.end();
    }
    busyThreads.delete(threadId);
  }
});

const port = Number(process.env.PORT ?? 3000);
process.env.SALES_API_BASE = `http://127.0.0.1:${port}`;
const server = app.listen(port, () => {
  console.log(`🤖 使用模型：${modelLabel}`);
  console.log(`📚 只读数据：${USERS.u002.name} 可见全部，${USERS.u001.name} 仅华东`);
  console.log(`💾 会话目录：${sessionStore.dir}`);
  console.log(`→ http://localhost:${port}`);
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
