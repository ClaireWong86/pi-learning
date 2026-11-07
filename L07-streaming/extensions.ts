import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendAudit } from "./audit.ts";
import { getLive } from "./live.ts";
import { applyGuard, scopeTightening, scopeViolation } from "./sales-query.ts";

function inputOf(event: { input: unknown }) {
  return event.input as Record<string, unknown>;
}

function copyQuery(input: Record<string, unknown>, query: ReturnType<typeof applyGuard> & { allow: true }) {
  input.filters = query.query.filters;
  input.dateFrom = query.query.dateFrom;
  input.dateTo = query.query.dateTo;
  input.groupBy = query.query.groupBy;
  input.compare = query.query.compare ?? "none";
  input.order = query.query.order;
  input.rank = query.query.rank ?? "none";
  input.limit = query.query.limit;
}

// 单次提问内的工具调用预算。多步任务放开后，用它防死循环和原地重复查。
export const MAX_TOOL_CALLS = 8;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function stepGuardExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "query_data") return;
    const live = getLive();
    if (!live) return { block: true, reason: "已拦截：没有用户上下文。" };
    live.toolCallCount += 1;
    const signature = stableStringify(event.input);
    const overLimit = live.toolCallCount > MAX_TOOL_CALLS;
    const duplicate = !overLimit && live.seenToolCalls.has(signature);
    if (!overLimit && !duplicate) {
      live.seenToolCalls.add(signature);
      return;
    }
    const kind = overLimit ? "step" : "duplicate";
    const reason = overLimit
      ? `已拦截：单次任务工具调用已达上限 ${MAX_TOOL_CALLS} 次。请基于已有工具结果作答，并说明没有查完的部分。`
      : "已拦截：相同参数已经查询过。请使用已有的工具结果，或者换一个子问题继续查。";
    live.blockedIds.add(event.toolCallId);
    console.log(`🚧 [${kind}] ${reason}`);
    const entry = appendAudit({
      layer: "extension",
      userId: live.user.id,
      userName: live.user.name,
      decision: "blocked",
      kind,
      tool: "query_data",
      reason,
    });
    live.emit({ type: "audit", id: event.toolCallId, entry });
    live.emit({ type: "guard", id: event.toolCallId, blocked: true, kind, reason });
    return { block: true, reason };
  });
}

export function limitGuardExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "query_data") return;
    const live = getLive();
    if (!live) return { block: true, reason: "已拦截：没有用户上下文。" };
    const decision = applyGuard(inputOf(event), live.user);
    if (decision.allow || decision.kind !== "limit") return;
    live.blockedIds.add(event.toolCallId);
    console.log(`🚧 [limit] ${decision.error}`);
    const entry = appendAudit({
      layer: "extension",
      userId: live.user.id,
      userName: live.user.name,
      decision: "blocked",
      kind: "limit",
      tool: "query_data",
      reason: decision.error,
    });
    live.emit({ type: "audit", id: event.toolCallId, entry });
    live.emit({ type: "guard", id: event.toolCallId, blocked: true, kind: "limit", reason: decision.error });
    return { block: true, reason: decision.error };
  });
}

export function permissionGuardExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "query_data") return;
    const live = getLive();
    if (!live) return { block: true, reason: "已拦截：没有用户上下文。" };
    const mentioned = scopeViolation(live.input, live.user);
    if (mentioned) {
      live.blockedIds.add(event.toolCallId);
      console.log(`🚧 [permission] ${mentioned}`);
      const entry = appendAudit({
        layer: "extension",
        userId: live.user.id,
        userName: live.user.name,
        decision: "blocked",
        kind: "permission",
        tool: "query_data",
        reason: mentioned,
      });
      live.emit({ type: "audit", id: event.toolCallId, entry });
      live.emit({ type: "guard", id: event.toolCallId, blocked: true, kind: "permission", reason: mentioned });
      return { block: true, reason: mentioned };
    }
    const decision = applyGuard(inputOf(event), live.user);
    if (!decision.allow && decision.kind === "permission") {
      live.blockedIds.add(event.toolCallId);
      console.log(`🚧 [permission] ${decision.error}`);
      const entry = appendAudit({
        layer: "extension",
        userId: live.user.id,
        userName: live.user.name,
        decision: "blocked",
        kind: "permission",
        tool: "query_data",
        reason: decision.error,
      });
      live.emit({ type: "audit", id: event.toolCallId, entry });
      live.emit({ type: "guard", id: event.toolCallId, blocked: true, kind: "permission", reason: decision.error });
      return { block: true, reason: decision.error };
    }
    if (!decision.allow) return;
    const beforeFilters = inputOf(event).filters;
    const change = scopeTightening(beforeFilters, decision.query.filters);
    copyQuery(inputOf(event), decision);
    live.emit({
      type: "guard",
      id: event.toolCallId,
      blocked: false,
      tightened: change !== null,
      change,
      effective: {
        filters: decision.query.filters,
        dateFrom: decision.query.dateFrom,
        dateTo: decision.query.dateTo,
        groupBy: decision.query.groupBy,
        compare: decision.query.compare ?? "none",
        order: decision.query.order,
        rank: decision.query.rank ?? "none",
        limit: decision.query.limit,
      },
    });
  });
}

export function auditExtension(pi: ExtensionAPI) {
  const started = new Map<string, number>();
  pi.on("tool_execution_start", (event) => {
    started.set(event.toolCallId, Date.now());
    console.log(`📝 [审计] 开始 ${event.toolName} ${JSON.stringify(event.args)}`);
  });
  pi.on("tool_execution_end", (event) => {
    const live = getLive();
    const cost = Date.now() - (started.get(event.toolCallId) ?? Date.now());
    started.delete(event.toolCallId);
    if (live?.blockedIds.has(event.toolCallId)) {
      console.log(`📝 [审计] ${event.toolName} 已拦截，耗时 ${cost}ms`);
      return;
    }
    const details = event.result?.details as { matchedRows?: number; amount?: number | null } | undefined;
    const entry = appendAudit({
      layer: "extension",
      userId: live?.user.id ?? "unknown",
      userName: live?.user.name ?? "unknown",
      decision: event.isError ? "error" : "allow",
      tool: event.toolName,
      matchedRows: details?.matchedRows,
      durationMs: cost,
      reason: event.isError ? "工具执行失败" : undefined,
    });
    console.log(`📝 [审计] ${event.toolName} ${event.isError ? "失败" : "成功"}，${cost}ms，命中 ${details?.matchedRows ?? "—"} 行`);
    live?.emit({ type: "audit", id: event.toolCallId, entry });
  });
}

export function userMemoryExtension(pi: ExtensionAPI) {
  pi.on("context", (event) => {
    const live = getLive();
    if (!live) return;
    const scope = live.user.regions === "*" ? "全部地区" : `仅${live.user.regions.join("、")}`;
    const memory = `[系统注入的用户偏好，非用户输入]
- 当前用户：${live.user.name}，${live.user.department}，${live.user.role}
- 数据权限：${scope}
- 回答展示单位：${live.user.unit}（工具已换算，禁止自己除以 10000）
- 语言：中文
权限外的地区不要查询，也不要估计。`;
    console.log(`🧠 [context] ${live.user.name}，权限 ${scope}，单位 ${live.user.unit}`);
    return {
      messages: [{ role: "user", content: memory, timestamp: Date.now() }, ...event.messages],
    };
  });
}
