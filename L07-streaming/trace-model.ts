export type Extremum = { group: string; rank: "min" | "max"; key: string };
export type TraceGroup = { key: string; amount: number };
export type DependsOn = { callId: string; column: string; value: string; take: "extremum" | "max" };

export type TraceCall = {
  id: string;
  name: string;
  turnIndex: number;
  args: unknown;
  effective?: unknown;
  outcome: "ok" | "error" | "blocked" | "running";
  blockKind?: string;
  resultPreview?: string;
  group?: string | null;
  extremum?: Extremum | null;
  groups?: TraceGroup[] | null;
  dependsOn?: DependsOn[];
};

const COLUMNS = ["日期", "产品", "地区", "销售额", "数量", "销售人员"] as const;
export type FilterColumn = (typeof COLUMNS)[number];

export type FilterRef = {
  step: number;
  column: FilterColumn;
  take: "extremum" | "max";
};

export type TrajectoryStep = {
  dateFrom?: string;
  dateTo?: string;
  groupBy?: Array<"产品" | "地区" | "销售人员" | "月份">;
  compare?: "yoy" | "mom";
  rank?: "min" | "max";
  filters?: Array<{ column: FilterColumn; value: string }>;
  filtersFrom?: FilterRef[];
};

export type TrajectorySpec = {
  minCalls: number;
  maxCalls: number;
  ordered: boolean;
  steps: TrajectoryStep[];
};

export type TurnLink = {
  turn: number;
  column: FilterColumn;
  take: "extremum" | "max";
};

export type TrajectoryScore = { pass: boolean; calls: number; turns: number; detail: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function callsOf(trace: unknown): TraceCall[] {
  const calls = asRecord(trace).calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((item) => asRecord(item) as TraceCall);
}

export function okCalls(trace: unknown): TraceCall[] {
  return callsOf(trace).filter((call) => call.outcome === "ok");
}

export function normalizedFilters(args: Record<string, unknown>) {
  let raw = args.filters;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => asRecord(item)).map((item) => ({ column: String(item.column ?? ""), value: String(item.value ?? "") }));
}

function groupedBy(call: TraceCall, column: string) {
  if (call.group === column || call.extremum?.group === column) return true;
  const groupBy = asRecord(call.args).groupBy;
  const names = Array.isArray(groupBy) ? groupBy.map(String) : typeof groupBy === "string" && groupBy ? [groupBy] : [];
  return names.includes(column);
}

export function takenValue(call: TraceCall, column: string, take: "extremum" | "max"): string | null {
  if (take === "extremum") return call.extremum?.group === column ? call.extremum.key : null;
  if (!groupedBy(call, column)) return null;
  const groups = call.groups ?? [];
  if (groups.length === 0) return call.extremum?.rank === "max" && call.extremum.group === column ? call.extremum.key : null;
  let best = groups[0];
  if (!best) return null;
  for (const item of groups) if (item.amount > best.amount) best = item;
  return best.key;
}

function valueFromTrace(trace: unknown, column: string, take: "extremum" | "max") {
  const calls = okCalls(trace);
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const value = takenValue(calls[index]!, column, take);
    if (value) return value;
  }
  return null;
}

export function linkDependencies(calls: TraceCall[]): TraceCall[] {
  return calls.map((call, index) => {
    if (call.outcome !== "ok") return { ...call, dependsOn: [] };
    const filters = normalizedFilters(asRecord(call.args));
    const dependsOn: DependsOn[] = [];
    for (const filter of filters) {
      for (let prev = index - 1; prev >= 0; prev -= 1) {
        const earlier = calls[prev];
        if (!earlier || earlier.outcome !== "ok") continue;
        if (earlier.extremum?.group === filter.column && earlier.extremum.key === filter.value) {
          dependsOn.push({ callId: earlier.id, column: filter.column, value: filter.value, take: "extremum" });
          break;
        }
        const top = takenValue(earlier, filter.column, "max");
        if (top && top === filter.value) {
          dependsOn.push({ callId: earlier.id, column: filter.column, value: filter.value, take: "max" });
          break;
        }
      }
    }
    return { ...call, dependsOn };
  });
}

function matchesShape(args: Record<string, unknown>, step: TrajectoryStep) {
  if (step.dateFrom && args.dateFrom !== step.dateFrom) return false;
  if (step.dateTo && args.dateTo !== step.dateTo) return false;
  if (step.groupBy) {
    const groupBy = Array.isArray(args.groupBy) ? args.groupBy.map(String) : typeof args.groupBy === "string" && args.groupBy ? [args.groupBy] : [];
    if (JSON.stringify(groupBy) !== JSON.stringify(step.groupBy)) return false;
  }
  if (step.compare) {
    const compare = args.compare === "同比" ? "yoy" : args.compare === "环比" ? "mom" : args.compare;
    if (compare !== step.compare) return false;
  }
  if (step.rank) {
    const rank = args.rank === "最高" ? "max" : args.rank === "最低" ? "min" : args.rank;
    if (rank !== step.rank) return false;
  }
  if (step.filters) {
    const filters = normalizedFilters(args);
    for (const expected of step.filters) {
      if (!filters.some((item) => item.column === expected.column && item.value === expected.value)) return false;
    }
  }
  return true;
}

function matchesStep(call: TraceCall, step: TrajectoryStep, matched: TraceCall[]) {
  const args = asRecord(call.args);
  if (!matchesShape(args, step)) return false;
  if (!step.filtersFrom) return true;
  const filters = normalizedFilters(args);
  for (const source of step.filtersFrom) {
    const prior = matched[source.step];
    const value = prior ? takenValue(prior, source.column, source.take) : null;
    if (!value) return false;
    if (!filters.some((item) => item.column === source.column && item.value === value)) return false;
  }
  return true;
}

export function scoreTrajectory(trace: unknown, spec: TrajectorySpec): TrajectoryScore {
  const calls = okCalls(trace);
  const turns = Array.isArray(asRecord(trace).turns) ? (asRecord(trace).turns as unknown[]).length : 0;
  const problems: string[] = [];
  if (!trace) problems.push("无轨迹");
  if (calls.length < spec.minCalls) problems.push(`成功调用 ${calls.length} 次 < 最少 ${spec.minCalls} 次`);
  if (calls.length > spec.maxCalls) problems.push(`成功调用 ${calls.length} 次 > 最多 ${spec.maxCalls} 次`);
  const signatures = calls.map((call) => JSON.stringify(call.args));
  if (new Set(signatures).size !== signatures.length) problems.push("有相同参数的重复调用");

  const matched: TraceCall[] = [];
  if (spec.ordered) {
    let cursor = 0;
    let prevTurn = 0;
    for (const step of spec.steps) {
      const found = calls.findIndex((call, index) => index >= cursor && call.turnIndex > prevTurn && matchesStep(call, step, matched));
      if (found < 0) break;
      const call = calls[found];
      if (!call) break;
      matched.push(call);
      prevTurn = call.turnIndex;
      cursor = found + 1;
    }
    if (matched.length < spec.steps.length) {
      const step = spec.steps[matched.length];
      const rest = calls.slice(cursor);
      const shapeHits = step ? rest.filter((call) => matchesShape(asRecord(call.args), step)) : [];
      if (shapeHits.length && shapeHits.every((call) => call.turnIndex <= prevTurn)) problems.push(`步骤 ${matched.length + 1} 与上一步在同一轮`);
      else if (shapeHits.length && step?.filtersFrom) problems.push(`步骤 ${matched.length + 1} 的过滤值不是上一步工具结果`);
    }
  } else {
    const used = new Set<number>();
    for (const step of spec.steps) {
      const found = calls.findIndex((call, index) => !used.has(index) && matchesStep(call, step, matched));
      if (found < 0) break;
      const call = calls[found];
      if (!call) break;
      used.add(found);
      matched.push(call);
    }
  }
  if (matched.length < spec.steps.length) problems.push(`步骤只匹配 ${matched.length}/${spec.steps.length}`);
  const detail = problems.length ? problems.join("；") : `${calls.length} 次成功调用 / ${turns} 轮，步骤 ${matched.length}/${spec.steps.length}`;
  return { pass: problems.length === 0, calls: calls.length, turns, detail };
}

export function traceOk(trace: unknown) {
  if (!trace) return false;
  const record = asRecord(trace);
  if (typeof record.model !== "string" || typeof record.input !== "string" || typeof record.durationMs !== "number") return false;
  if (!Array.isArray(record.turns) || !Array.isArray(record.calls) || !Array.isArray(record.tools)) return false;
  return callsOf(trace).every((call) => typeof call.turnIndex === "number" && (call.outcome === "ok" || call.outcome === "error" || call.outcome === "blocked"));
}

export function scoreCallBudget(trace: unknown, exact = 1) {
  const count = okCalls(trace).filter((call) => call.name === "query_data" || !call.name).length;
  const pass = count === exact;
  return { pass, ok: count, detail: pass ? `成功调用 ${count} 次` : `成功调用 ${count} 次，期望 ${exact} 次` };
}

function limitOf(call: TraceCall) {
  const raw = asRecord(call.args).limit;
  if (raw === undefined || raw === null || raw === "") return 20;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : 20;
}

export function scoreRepair(trace: unknown) {
  const calls = callsOf(trace);
  const blocked = calls.find((call) => call.outcome === "blocked" && (call.blockKind === "limit" || limitOf(call) > 100));
  if (!blocked) return { pass: false, detail: "没有被限额拦住的调用" };
  const retry = calls.find((call) => call.outcome === "ok" && call.turnIndex > blocked.turnIndex && limitOf(call) <= 100);
  if (!retry) return { pass: false, detail: "拦住之后没有在更后的轮次把 limit 降到 100 以内再查成功" };
  return { pass: true, detail: `限额拦住后改为 ${limitOf(retry)} 再查成功` };
}

export function scoreTurnLinks(turns: Array<{ links?: TurnLink[] }>, traces: unknown[]) {
  if (!turns.some((turn) => turn.links?.length)) return null;
  const problems: string[] = [];
  turns.forEach((turn, index) => {
    for (const link of turn.links ?? []) {
      const value = valueFromTrace(traces[link.turn], link.column, link.take);
      if (!value) {
        problems.push(`第 ${index + 1} 轮缺少第 ${link.turn + 1} 轮的${link.column}`);
        continue;
      }
      const hit = okCalls(traces[index]).some((call) => normalizedFilters(asRecord(call.args)).some((filter) => filter.column === link.column && filter.value === value));
      if (!hit) problems.push(`第 ${index + 1} 轮的${link.column}不是「${value}」`);
    }
  });
  return { pass: problems.length === 0, detail: problems.length ? problems.join("；") : "跨轮依赖对齐" };
}
