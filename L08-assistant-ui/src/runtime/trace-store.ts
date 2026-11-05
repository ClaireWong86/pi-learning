import { useSyncExternalStore } from "react";
import type { SseEvent } from "./sse.ts";

export type TraceCallView = {
  id: string;
  name: string;
  turnIndex: number;
  args: unknown;
  effective?: unknown;
  outcome: "ok" | "error" | "blocked" | "running";
  resultPreview?: string;
  extremum?: { key?: string } | null;
  dependsOn?: Array<{ callId: string; value: string; take: string }>;
};

export type TraceRound = {
  input: string;
  model: string;
  user: string;
  duration: string;
  turns: string;
  callCount: string;
  calls: TraceCallView[];
  done: boolean;
};

export type TraceState = {
  empty: boolean;
  threadId: string | null;
  rounds: TraceRound[];
  startedAt: number | null;
  reveal: number;
};

const EMPTY: TraceState = { empty: true, threadId: null, rounds: [], startedAt: null, reveal: 0 };

type Bucket = { rounds: TraceRound[]; startedAt: number | null };

let ownerUser: string | null = null;
let activeThreadId: string | null = null;
let reveal = 0;
const threads = new Map<string, Bucket>();
let state: TraceState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function bucket(threadId: string) {
  const found = threads.get(threadId);
  if (found) return found;
  const created: Bucket = { rounds: [], startedAt: null };
  threads.set(threadId, created);
  return created;
}

function publish() {
  const entry = activeThreadId ? threads.get(activeThreadId) : undefined;
  state = {
    empty: !entry || entry.rounds.length === 0,
    threadId: activeThreadId,
    rounds: entry ? entry.rounds.map((round) => ({ ...round, calls: round.calls.map((call) => ({ ...call })) })) : [],
    startedAt: entry?.startedAt ?? null,
    reveal,
  };
  emit();
}

function activeRound() {
  if (!activeThreadId) return null;
  const rounds = bucket(activeThreadId).rounds;
  return rounds[rounds.length - 1] ?? null;
}

export function noteUser(userId: string) {
  if (ownerUser === userId) return;
  const switching = ownerUser !== null;
  ownerUser = userId;
  if (!switching) return;
  threads.clear();
  activeThreadId = null;
  publish();
}

export function showThread(threadId: string | null) {
  if (!threadId || threadId.startsWith("__LOCALID_")) return;
  if (state.startedAt && activeThreadId && activeThreadId !== threadId) return;
  activeThreadId = threadId;
  publish();
}

function asCall(value: unknown): TraceCallView {
  const record = value && typeof value === "object" ? (value as TraceCallView) : ({} as TraceCallView);
  return {
    id: String(record.id ?? ""),
    name: String(record.name ?? "query_data"),
    turnIndex: Number(record.turnIndex ?? 0),
    args: record.args,
    effective: record.effective,
    outcome: record.outcome ?? "ok",
    resultPreview: record.resultPreview,
    extremum: record.extremum,
    dependsOn: record.dependsOn,
  };
}

export function dispatchTrace(event: SseEvent) {
  if (event.type === "trace_start") {
    const threadId = String(event.threadId ?? activeThreadId ?? "");
    if (threadId) activeThreadId = threadId;
    const user = event.user as { name?: string; scope?: string } | undefined;
    const entry = bucket(activeThreadId || "local");
    if (!activeThreadId) activeThreadId = "local";
    entry.rounds.push({
      input: String(event.input ?? ""),
      model: String(event.model ?? "—"),
      user: user?.name ? `${user.name}${user.scope ? ` · ${user.scope}` : ""}` : "—",
      duration: "0.0 秒",
      turns: "0",
      callCount: "0",
      calls: [],
      done: false,
    });
    entry.startedAt = Date.now();
    publish();
    return;
  }

  const round = activeRound();
  if (!round || !activeThreadId) return;
  const entry = bucket(activeThreadId);

  if (event.type === "turn") {
    if (event.phase === "start") round.turns = String(event.index ?? round.turns);
  } else if (event.type === "tool_start") {
    round.calls.push({
      id: String(event.id ?? `call-${round.calls.length + 1}`),
      name: String(event.name ?? "query_data"),
      turnIndex: Number(event.turnIndex ?? round.turns ?? 0),
      args: event.args,
      outcome: "running",
    });
    round.callCount = String(round.calls.length);
  } else if (event.type === "guard") {
    const call = round.calls.find((item) => item.id === event.id);
    if (call && event.blocked === true) {
      call.outcome = "blocked";
      call.resultPreview = String(event.reason ?? "");
    } else if (call && event.effective) {
      call.effective = event.effective;
    }
  } else if (event.type === "tool_end") {
    const call = round.calls.find((item) => item.id === event.id);
    if (call && call.outcome !== "blocked") {
      const text = String(event.result ?? "");
      const failed = event.isError === true || text.startsWith("已拦截") || text.startsWith("无法查询");
      call.outcome = failed ? "error" : "ok";
      call.resultPreview =
        text
          .split("\n")
          .find((line) => line.startsWith("结果：") || line.startsWith("已拦截") || line.startsWith("无法查询")) ?? "";
    }
  } else if (event.type === "trace_end") {
    const calls = Array.isArray(event.calls) ? event.calls.map(asCall) : round.calls;
    round.calls = calls;
    round.done = true;
    round.turns = String(Array.isArray(event.turns) ? event.turns.length : round.turns);
    round.callCount = String(calls.length);
    round.duration = `${(Number(event.durationMs) / 1000).toFixed(1)} 秒`;
    entry.startedAt = null;
    const multi = calls.filter((item) => item.outcome === "ok").length > 1 || calls.some((item) => (item.dependsOn?.length ?? 0) > 0);
    if (multi) reveal += 1;
  } else {
    return;
  }
  publish();
}

export function tickDuration() {
  if (!state.startedAt || !activeThreadId) return;
  const round = activeRound();
  if (!round || round.done) return;
  round.duration = `${((Date.now() - state.startedAt) / 1000).toFixed(1)} 秒`;
  publish();
}

export function useTrace() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => EMPTY,
  );
}
