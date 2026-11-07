import { useSyncExternalStore } from "react";
import type { SseEvent } from "./sse.ts";

export type AuditView = {
  id?: string;
  userName: string;
  decision: string;
  kind?: string;
  matchedRows?: number;
  durationMs?: number;
  reason?: string;
};

export type TraceCallView = {
  id: string;
  name: string;
  turnIndex: number;
  args: unknown;
  effective?: unknown;
  outcome: "ok" | "error" | "blocked" | "running";
  blockKind?: string;
  blockReason?: string;
  tightened?: boolean;
  resultPreview?: string;
  extremum?: { key?: string } | null;
  dependsOn?: Array<{ callId: string; value: string; take: string }>;
  audit?: AuditView;
};

export type TraceRound = {
  input: string;
  model: string;
  user: string;
  scope: string;
  duration: string;
  turns: string;
  callCount: string;
  calls: TraceCallView[];
  audits: AuditView[];
  done: boolean;
  branchId?: string;
  parentBranchId?: string | null;
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
let activeBranchId: string | null = null;
let pendingBranch: { branchId: string; parentBranchId: string | null } | null = null;
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

function branchChain(rounds: TraceRound[], branchId: string | null) {
  const plain = rounds.filter((round) => !round.branchId);
  if (!branchId) return rounds;
  const byBranch = new Map<string, TraceRound>();
  for (const round of rounds) {
    if (round.branchId) byBranch.set(round.branchId, round);
  }
  const path: TraceRound[] = [];
  const seen = new Set<string>();
  let cursor = byBranch.get(branchId);
  while (cursor?.branchId && !seen.has(cursor.branchId)) {
    seen.add(cursor.branchId);
    path.unshift(cursor);
    cursor = cursor.parentBranchId ? byBranch.get(cursor.parentBranchId) : undefined;
  }
  if (path.length === 0) return plain.length > 0 ? plain : rounds;
  return [...plain, ...path];
}

function publish() {
  const entry = activeThreadId ? threads.get(activeThreadId) : undefined;
  const rounds = entry ? branchChain(entry.rounds, activeBranchId) : [];
  state = {
    empty: rounds.length === 0,
    threadId: activeThreadId,
    rounds: rounds.map((round) => ({ ...round, calls: round.calls.map((call) => ({ ...call })) })),
    startedAt: entry?.startedAt ?? null,
    reveal,
  };
  emit();
}

export function beginRound(branchId: string, parentBranchId: string | null) {
  if (!branchId) return;
  pendingBranch = { branchId, parentBranchId };
  activeBranchId = branchId;
}

export function showBranch(branchId: string | null) {
  activeBranchId = branchId;
  publish();
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
  activeBranchId = null;
  pendingBranch = null;
  publish();
}

export function hydrateThread(threadId: string, rounds: unknown[]) {
  if (!threadId || threadId.startsWith("__LOCALID_")) return;
  const parsed = rounds.map((round) => {
    const item = round && typeof round === "object" ? (round as TraceRound) : ({} as TraceRound);
    return {
      input: String(item.input ?? ""),
      model: String(item.model ?? "—"),
      user: String(item.user ?? "—"),
      scope: String(item.scope ?? "—"),
      duration: String(item.duration ?? "—"),
      turns: String(item.turns ?? "0"),
      callCount: String(item.callCount ?? (Array.isArray(item.calls) ? item.calls.length : 0)),
      calls: Array.isArray(item.calls) ? item.calls.map((call) => asCall(call)) : [],
      audits: Array.isArray(item.audits) ? item.audits.map((audit) => asAudit(audit, audit.id)) : [],
      done: true,
      branchId: item.branchId ? String(item.branchId) : undefined,
      parentBranchId: item.parentBranchId ? String(item.parentBranchId) : null,
    };
  });
  threads.set(threadId, { rounds: parsed, startedAt: null });
  if (!state.startedAt) {
    activeThreadId = threadId;
    publish();
  }
}

export function showThread(threadId: string | null) {
  if (!threadId || threadId.startsWith("__LOCALID_")) return;
  if (state.startedAt && activeThreadId && activeThreadId !== threadId) return;
  activeThreadId = threadId;
  publish();
}

function asAudit(value: unknown, id?: string): AuditView {
  const entry = value && typeof value === "object" ? (value as AuditView) : ({} as AuditView);
  const rows = entry.matchedRows;
  const duration = entry.durationMs;
  return {
    id,
    userName: String(entry.userName ?? "—"),
    decision: String(entry.decision ?? "—"),
    kind: entry.kind ? String(entry.kind) : undefined,
    matchedRows: typeof rows === "number" ? rows : undefined,
    durationMs: typeof duration === "number" ? duration : undefined,
    reason: entry.reason ? String(entry.reason) : undefined,
  };
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
    blockKind: record.blockKind ? String(record.blockKind) : undefined,
    blockReason: record.blockReason ? String(record.blockReason) : undefined,
    tightened: record.tightened === true,
    audit: record.audit,
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
    const branch = pendingBranch;
    pendingBranch = null;
    entry.rounds.push({
      input: String(event.input ?? ""),
      model: String(event.model ?? "—"),
      user: user?.name ? String(user.name) : "—",
      scope: user?.scope ? String(user.scope) : "—",
      duration: "0.0 秒",
      turns: "0",
      callCount: "0",
      calls: [],
      audits: [],
      done: false,
      branchId: branch?.branchId,
      parentBranchId: branch?.parentBranchId,
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
      call.blockKind = String(event.kind ?? "");
      call.blockReason = String(event.reason ?? "");
      call.resultPreview = call.blockReason;
    } else if (call) {
      if (event.effective) call.effective = event.effective;
      if (event.tightened === true) call.tightened = true;
    }
  } else if (event.type === "audit") {
    const audit = asAudit(event.entry, typeof event.id === "string" ? event.id : undefined);
    round.audits.push(audit);
    const call = audit.id ? round.calls.find((item) => item.id === audit.id) : [...round.calls].reverse().find((item) => !item.audit);
    if (call) call.audit = audit;
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
    const incoming = Array.isArray(event.calls) ? event.calls.map(asCall) : round.calls;
    const previous = new Map(round.calls.map((call) => [call.id, call]));
    const calls = incoming.map((call) => {
      const prior = previous.get(call.id);
      if (!prior) return call;
      return {
        ...call,
        blockKind: call.blockKind || prior.blockKind,
        blockReason: prior.blockReason,
        tightened: prior.tightened,
        audit: prior.audit,
        effective: call.effective ?? prior.effective,
      };
    });
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
