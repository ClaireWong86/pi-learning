import { existsSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit } from "./audit.ts";
import {
  PRODUCTS,
  REGIONS,
  SALESPEOPLE,
  SEED_VERSION,
  allowsRegion,
  datasetName,
  resolveUser,
  salesRows,
  type User,
} from "./sales-data.ts";

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "data");

function databasePath() {
  return join(dataDir, datasetName() === "shift" ? "sales-shift.sqlite" : "sales.sqlite");
}

const TEXT_COLUMNS = ["日期", "产品", "地区", "销售人员"] as const;
const NUMBER_COLUMNS = ["销售额", "数量"] as const;
const FILTER_COLUMNS = [...TEXT_COLUMNS, ...NUMBER_COLUMNS] as const;
const GROUP_COLUMNS = ["产品", "地区", "销售人员", "月份"] as const;
const OPERATORS = ["=", "!=", ">", "<", ">=", "<=", "contains", "in"] as const;

const COLUMN_SQL: Record<(typeof FILTER_COLUMNS)[number], string> = {
  日期: "date",
  产品: "product",
  地区: "region",
  销售额: "amount",
  数量: "quantity",
  销售人员: "salesperson",
};

const GROUP_SQL: Record<(typeof GROUP_COLUMNS)[number], string> = {
  ...COLUMN_SQL,
  月份: "substr(date, 1, 7)",
};

const CATALOG: Record<string, readonly string[]> = {
  产品: PRODUCTS,
  地区: REGIONS,
  销售人员: SALESPEOPLE,
};

export type Filter = {
  column: (typeof FILTER_COLUMNS)[number];
  operator: (typeof OPERATORS)[number];
  value: string;
};

export type NormalizedQuery = {
  filters: Filter[];
  dateFrom?: string;
  dateTo?: string;
  groupBy: (typeof GROUP_COLUMNS)[number][];
  compare?: "yoy" | "mom";
  order: "asc" | "desc";
  limit: number;
  rank?: "min" | "max";
};

export type Totals = { amount: number; quantity: number; count: number };

export type GroupRow = Totals & { key: string };

export type DetailRow = {
  date: string;
  product: string;
  region: string;
  amount: number;
  quantity: number;
  salesperson: string;
};

export type OkResult = {
  ok: true;
  source: string;
  conditions: string;
  dbFrom: string;
  dbTo: string;
  dbRows: number;
  matchedRows: number;
  detailLimit: number;
  scope: string;
  unit: User["unit"];
  totals: Totals;
  basis: string;
  compare?: {
    mode: "yoy" | "mom";
    label: "同比" | "环比";
    currentFrom: string;
    currentTo: string;
    baseFrom: string;
    baseTo: string;
    current: Totals;
    base: Totals;
    deltaAmount: number;
    rate: string | null;
  };
  groups?: GroupRow[];
  allGroups?: GroupRow[];
  groupLabel?: string;
  winner?: { key: string; amount: number; rank: "min" | "max" };
  details: DetailRow[];
};

export type ErrResult = {
  ok: false;
  blocked?: "limit" | "permission" | "input";
  error: string;
};

export type QueryResult = OkResult | ErrResult;

type GuardDecision =
  | { allow: true; query: NormalizedQuery }
  | { allow: false; kind: "limit" | "permission" | "input"; error: string };

let database: DatabaseSync | null = null;
let databaseFile = "";

function seed(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sales (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      product TEXT NOT NULL,
      region TEXT NOT NULL,
      amount INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      salesperson TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO sales (id, date, product, region, amount, quantity, salesperson) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of salesRows()) {
    insert.run(row.id, row.date, row.product, row.region, row.amount, row.quantity, row.salesperson);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(String(SEED_VERSION));
  db.close();
}

export function getSalesDatabase() {
  const path = databasePath();
  if (database?.isOpen && databaseFile === path) return database;
  if (database?.isOpen) database.close();
  database = null;
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(path)) {
    const probe = new DatabaseSync(path);
    let version = 0;
    try {
      const row = probe.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      version = Number(row?.value ?? 0);
    } catch {
      version = 0;
    }
    probe.close();
    if (version !== SEED_VERSION) rmSync(path);
  }
  if (!existsSync(path)) seed(path);
  database = new DatabaseSync(path, { readOnly: true });
  databaseFile = path;
  return database;
}

function int(value: unknown) {
  const n = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function isColumn(value: string): value is (typeof FILTER_COLUMNS)[number] {
  return (FILTER_COLUMNS as readonly string[]).includes(value);
}

function isOperator(value: string): value is (typeof OPERATORS)[number] {
  return (OPERATORS as readonly string[]).includes(value);
}

function isGroup(value: string): value is (typeof GROUP_COLUMNS)[number] {
  return (GROUP_COLUMNS as readonly string[]).includes(value);
}

export function parseISODate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function isoDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isFullMonth(from: string, to: string) {
  const start = parseISODate(from);
  const end = parseISODate(to);
  if (!start || !end) return false;
  return start.year === end.year && start.month === end.month && start.day === 1 && end.day === lastDay(start.year, start.month);
}

function shiftMonth(from: string, months: number) {
  const start = parseISODate(from);
  if (!start) throw new Error("非法日期");
  const shifted = new Date(Date.UTC(start.year, start.month - 1 + months, 1));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  return { from: isoDate(year, month, 1), to: isoDate(year, month, lastDay(year, month)) };
}

function shiftYear(value: string, delta: number) {
  const parsed = parseISODate(value);
  if (!parsed) throw new Error("非法日期");
  const day = Math.min(parsed.day, lastDay(parsed.year + delta, parsed.month));
  return isoDate(parsed.year + delta, parsed.month, day);
}

function previousEqualWindow(from: string, to: string) {
  const start = parseISODate(from);
  const end = parseISODate(to);
  if (!start || !end) throw new Error("非法日期");
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  const prevEnd = startMs - 86_400_000;
  const prevStart = prevEnd - (days - 1) * 86_400_000;
  const a = new Date(prevStart);
  const b = new Date(prevEnd);
  return {
    from: isoDate(a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate()),
    to: isoDate(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate()),
  };
}

export function comparisonWindow(from: string, to: string, mode: "yoy" | "mom") {
  if (mode === "yoy") {
    if (isFullMonth(from, to)) return shiftMonth(from, -12);
    return { from: shiftYear(from, -1), to: shiftYear(to, -1) };
  }
  if (isFullMonth(from, to)) return shiftMonth(from, -1);
  return previousEqualWindow(from, to);
}

function fail(kind: "limit" | "permission" | "input", error: string): GuardDecision {
  return { allow: false, kind, error };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function parseFilters(value: unknown): Filter[] | GuardDecision {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail("input", "无法查询：filters 必须是数组。");
  const filters: Filter[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) return fail("input", "无法查询：过滤条件必须是对象。");
    const column = String(record.column ?? "");
    const operator = String(record.operator ?? "");
    const rawValue = record.value === undefined || record.value === null ? "" : String(record.value);
    if (!isColumn(column)) return fail("input", `无法查询：不能按「${column}」过滤。可用列：${FILTER_COLUMNS.join("、")}。`);
    if (!isOperator(operator)) return fail("input", `无法查询：不支持运算符「${operator}」。`);
    if (!rawValue.trim()) return fail("input", "无法查询：过滤值不能为空。");
    const numeric = (NUMBER_COLUMNS as readonly string[]).includes(column);
    const textual = new Set<string>(numeric ? ["=", "!=", ">", "<", ">=", "<="] : ["=", "!=", "contains", "in", ">", "<", ">=", "<="]);
    if (column !== "日期" && numeric && !["=", "!=", ">", "<", ">=", "<="].includes(operator)) {
      return fail("input", `无法查询：${column} 只支持大小比较。`);
    }
    if (!numeric && column !== "日期" && !["=", "!=", "contains", "in"].includes(operator)) {
      return fail("input", `无法查询：${column} 只支持 =、!=、contains、in。`);
    }
    if (!textual.has(operator) && column !== "日期") return fail("input", `无法查询：${column} 不支持 ${operator}。`);
    if (numeric && operator !== "in" && operator !== "contains" && !Number.isFinite(Number(rawValue))) {
      return fail("input", `无法查询：${column} 的过滤值必须是数字，单位是元。`);
    }
    const catalog = CATALOG[column];
    if (catalog && (operator === "=" || operator === "in")) {
      const wanted = operator === "in" ? rawValue.split(",").map((part) => part.trim()).filter(Boolean) : [rawValue];
      const unknown = wanted.filter((part) => !catalog.includes(part));
      if (unknown.length) {
        return fail("input", `无法查询：${column}没有「${unknown.join("、")}」。可选：${catalog.join("、")}。不要编造。`);
      }
    }
    filters.push({ column, operator, value: rawValue.trim() });
  }
  return filters;
}

function listedRegions(filters: unknown): string[] {
  if (!Array.isArray(filters)) return [];
  const regions: string[] = [];
  for (const item of filters) {
    const record = asRecord(item);
    if (!record || record.column !== "地区") continue;
    const value = String(record.value ?? "");
    if (record.operator === "=" && value) regions.push(value);
    if (record.operator === "in") regions.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
  }
  return regions;
}

/** 权限只在补上或拿掉地区时算收紧。补默认 limit、排序不算。 */
export function scopeTightening(beforeFilters: unknown, afterFilters: Filter[]) {
  const before = listedRegions(beforeFilters);
  const after = [...new Set(listedRegions(afterFilters))];
  const added = after.filter((region) => !before.includes(region));
  const removed = before.filter((region) => !after.includes(region));
  if (added.length === 0 && removed.length === 0) return null;
  return `查询范围收窄为${after.join("、") || "空"}`;
}

function regionMentions(filters: Filter[]): { mode: "none" | "explicit" | "unsafe"; regions: string[] } {
  const regions: string[] = [];
  for (const filter of filters) {
    if (filter.column !== "地区") continue;
    if (filter.operator === "=") regions.push(filter.value);
    else if (filter.operator === "in") regions.push(...filter.value.split(",").map((part) => part.trim()).filter(Boolean));
    else return { mode: "unsafe", regions: [] };
  }
  if (regions.length === 0) return { mode: "none", regions: [] };
  return { mode: "explicit", regions };
}

export function applyGuard(body: unknown, user: User): GuardDecision {
  const record = asRecord(body);
  if (!record) return fail("input", "无法查询：请求体必须是 JSON 对象。");
  for (const key of ["sql", "query", "statement", "table"]) {
    if (key in record) return fail("input", "无法查询：只读接口不接受 SQL。");
  }

  const filters = parseFilters(record.filters);
  if (!Array.isArray(filters)) return filters;

  let dateFrom = record.dateFrom === undefined ? undefined : String(record.dateFrom);
  let dateTo = record.dateTo === undefined ? undefined : String(record.dateTo);
  if (dateFrom && !parseISODate(dateFrom)) return fail("input", `无法查询：dateFrom 不是合法日期 ${dateFrom}。格式 YYYY-MM-DD。`);
  if (dateTo && !parseISODate(dateTo)) return fail("input", `无法查询：dateTo 不是合法日期 ${dateTo}。2026 年 2 月最后一天是 2026-02-28。`);
  if (dateFrom && dateTo && dateFrom > dateTo) return fail("input", "无法查询：dateFrom 晚于 dateTo。");

  const groupBy: NormalizedQuery["groupBy"] = [];
  if (record.groupBy !== undefined) {
    const list = Array.isArray(record.groupBy) ? record.groupBy : [record.groupBy];
    for (const item of list) {
      const name = String(item);
      if (!isGroup(name)) return fail("input", `无法查询：不能按「${name}」分组。可用：${GROUP_COLUMNS.join("、")}。`);
      groupBy.push(name);
    }
  }

  let compare: NormalizedQuery["compare"];
  if (record.compare !== undefined && record.compare !== "none" && record.compare !== "") {
    const raw = String(record.compare);
    if (raw !== "yoy" && raw !== "mom") return fail("input", "无法查询：compare 只能是 yoy（同比）或 mom（环比）。");
    compare = raw;
  }
  if (compare && (!dateFrom || !dateTo)) return fail("input", "无法查询：同比和环比必须同时给出 dateFrom 和 dateTo。");

  let rank: NormalizedQuery["rank"];
  if (record.rank !== undefined && record.rank !== "none" && record.rank !== "") {
    const raw = String(record.rank);
    if (raw !== "min" && raw !== "max") return fail("input", "无法查询：rank 只能是 min 或 max。");
    rank = raw;
  }
  if (rank && groupBy.length === 0) return fail("input", "无法查询：问最高或最低时要带 groupBy，不要自己比较数字。");
  if (rank && compare) return fail("input", "无法查询：极值和同比环比请分两次查询。");
  if (compare && groupBy.length > 0) return fail("input", "无法查询：分组和同比环比请分两次查询。");

  let order: NormalizedQuery["order"] = record.order === "asc" ? "asc" : "desc";
  if (rank === "min") order = "asc";
  if (rank === "max") order = "desc";

  let limit = DEFAULT_LIMIT;
  if (record.limit !== undefined) {
    const parsed = typeof record.limit === "number" ? record.limit : Number(record.limit);
    if (!Number.isInteger(parsed) || parsed < 1) return fail("limit", "已拦截：limit 必须是正整数。");
    if (parsed > MAX_LIMIT) {
      return fail("limit", `已拦截：单次最多返回 ${MAX_LIMIT} 行，你请求了 ${parsed} 行。请把 limit 改为不超过 ${MAX_LIMIT} 后重试。合计统计不需要把明细一次取完。`);
    }
    limit = parsed;
  }

  const mentioned = regionMentions(filters);
  if (mentioned.mode === "unsafe") return fail("permission", "已拦截：地区条件只允许 = 或 in，避免用其他运算符绕过权限。");
  if (user.regions !== "*") {
    const outside = mentioned.regions.filter((region) => !allowsRegion(user, region));
    if (outside.length) {
      return fail(
        "permission",
        `已拦截：${user.name}只能查看${user.regions.join("、")}，不能查询${[...new Set(outside)].join("、")}。不要改写条件绕过。`,
      );
    }
    if (mentioned.mode === "none") {
      filters.push({ column: "地区", operator: "in", value: user.regions.join(",") });
    }
  }

  return {
    allow: true,
    query: { filters, dateFrom, dateTo, groupBy, compare, order, limit, rank },
  };
}

export function scopeViolation(question: string, user: User) {
  if (user.regions === "*") return null;
  const outside = REGIONS.filter((region) => !user.regions.includes(region) && question.includes(region));
  if (outside.length === 0) return null;
  return `已拦截：${user.name}只能查看${user.regions.join("、")}，问题里提到了权限外地区${outside.join("、")}。不要改写成不带地区的查询来绕过。`;
}

function whereOf(query: NormalizedQuery, window?: { from?: string; to?: string }) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const dateFrom = window ? window.from : query.dateFrom;
  const dateTo = window ? window.to : query.dateTo;
  if (dateFrom) {
    clauses.push("date >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("date <= ?");
    params.push(dateTo);
  }
  for (const filter of query.filters) {
    const column = COLUMN_SQL[filter.column];
    if (filter.operator === "contains") {
      const escaped = filter.value.replace(/[\\%_]/g, (char) => `\\${char}`);
      clauses.push(`${column} LIKE ? ESCAPE '\\'`);
      params.push(`%${escaped}%`);
      continue;
    }
    if (filter.operator === "in") {
      const parts = filter.value.split(",").map((part) => part.trim()).filter(Boolean);
      clauses.push(`${column} IN (${parts.map(() => "?").join(", ")})`);
      for (const part of parts) params.push((NUMBER_COLUMNS as readonly string[]).includes(filter.column) ? Number(part) : part);
      continue;
    }
    clauses.push(`${column} ${filter.operator} ?`);
    params.push((NUMBER_COLUMNS as readonly string[]).includes(filter.column) ? Number(filter.value) : filter.value);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function readTotals(query: NormalizedQuery, window?: { from?: string; to?: string }): Totals {
  const where = whereOf(query, window);
  const row = getSalesDatabase()
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(quantity), 0) AS quantity, COUNT(*) AS count FROM sales ${where.sql}`,
    )
    .get(...where.params) as { amount: unknown; quantity: unknown; count: unknown };
  return { amount: int(row.amount), quantity: int(row.quantity), count: int(row.count) };
}

function readDetails(query: NormalizedQuery): DetailRow[] {
  const where = whereOf(query);
  const rows = getSalesDatabase()
    .prepare(
      `SELECT date, product, region, amount, quantity, salesperson FROM sales ${where.sql} ORDER BY date ASC, id ASC LIMIT ?`,
    )
    .all(...where.params, query.limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    date: String(row.date),
    product: String(row.product),
    region: String(row.region),
    amount: int(row.amount),
    quantity: int(row.quantity),
    salesperson: String(row.salesperson),
  }));
}

function readGroups(query: NormalizedQuery): GroupRow[] {
  const where = whereOf(query);
  const exprs = query.groupBy.map((column) => GROUP_SQL[column]);
  const sql = `SELECT ${exprs.map((expr, index) => `${expr} AS g${index}`).join(", ")}, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(quantity), 0) AS quantity, COUNT(*) AS count FROM sales ${where.sql} GROUP BY ${exprs.join(", ")}`;
  const rows = getSalesDatabase().prepare(sql).all(...where.params) as Array<Record<string, unknown>>;
  const groups = rows.map((row) => ({
    key: query.groupBy.map((_, index) => String(row[`g${index}`])).join(" / "),
    amount: int(row.amount),
    quantity: int(row.quantity),
    count: int(row.count),
  }));
  groups.sort((a, b) => {
    const diff = query.order === "asc" ? a.amount - b.amount : b.amount - a.amount;
    if (diff !== 0) return diff;
    return a.key.localeCompare(b.key, "zh");
  });
  return groups;
}

export function money(amount: number) {
  return `${amount} 元（${(amount / 10000).toFixed(2)} 万元）`;
}

export function rateOf(current: number, base: number) {
  if (base === 0) return null;
  return (((current - base) / base) * 100).toFixed(2);
}

function describeConditions(query: NormalizedQuery) {
  const parts: string[] = [];
  if (query.dateFrom || query.dateTo) parts.push(`日期 ${query.dateFrom ?? "不限"} ~ ${query.dateTo ?? "不限"}（含首尾）`);
  for (const filter of query.filters) {
    const operator = filter.operator === "contains" ? "包含" : filter.operator === "in" ? "属于" : filter.operator;
    parts.push(`${filter.column} ${operator} ${filter.value}`);
  }
  if (query.groupBy.length) parts.push(`分组 ${query.groupBy.join("、")}`);
  if (query.compare) parts.push(query.compare === "yoy" ? "对比 同比" : "对比 环比");
  if (query.rank) parts.push(query.rank === "min" ? "取最低" : "取最高");
  parts.push(`明细上限 ${query.limit} 行`);
  return parts.join("；");
}

function describeScope(user: User) {
  if (user.regions === "*") return `${user.name}可查看全部地区`;
  return `${user.name}只能查看${user.regions.join("、")}`;
}

function runQuery(query: NormalizedQuery, user: User): OkResult {
  const db = getSalesDatabase();
  const range = db.prepare("SELECT MIN(date) AS dbFrom, MAX(date) AS dbTo, COUNT(*) AS count FROM sales").get() as {
    dbFrom: string;
    dbTo: string;
    count: unknown;
  };
  const totals = readTotals(query);
  const details = readDetails(query);
  const groups = query.groupBy.length ? readGroups(query) : undefined;
  const winner = query.rank && groups && groups.length ? { key: groups[0].key, amount: groups[0].amount, rank: query.rank } : undefined;

  let compare: OkResult["compare"];
  if (query.compare && query.dateFrom && query.dateTo) {
    const baseWindow = comparisonWindow(query.dateFrom, query.dateTo, query.compare);
    const base = readTotals(query, baseWindow);
    compare = {
      mode: query.compare,
      label: query.compare === "yoy" ? "同比" : "环比",
      currentFrom: query.dateFrom,
      currentTo: query.dateTo,
      baseFrom: baseWindow.from,
      baseTo: baseWindow.to,
      current: totals,
      base,
      deltaAmount: totals.amount - base.amount,
      rate: rateOf(totals.amount, base.amount),
    };
  }

  const basisParts = [
    `销售额合计 = SUM(销售额) = ${money(totals.amount)}`,
    `数量合计 = SUM(数量) = ${totals.quantity}`,
    `笔数 = COUNT(*) = ${totals.count}`,
    "求和在只读数据库内完成",
  ];
  if (compare) {
    const rateText = compare.rate === null ? "基期为 0，不能做除法" : `${compare.rate}%`;
    basisParts.push(
      `${compare.label}比率 = (本期 ${compare.current.amount} - 基期 ${compare.base.amount}) / 基期 ${compare.base.amount} = ${rateText}`,
      "两期合计都是 SQL SUM，比率在查询工具内计算",
    );
  }
  if (winner) {
    basisParts.push(`${winner.rank === "min" ? "最低" : "最高"}一名按 SUM(销售额) 排序，在数据库内完成`);
  }

  return {
    ok: true,
    source: `只读数据库 ${datasetName() === "shift" ? "sales-shift.sqlite" : "sales.sqlite"}，经 POST /api/sales/query`,
    conditions: describeConditions(query),
    dbFrom: range.dbFrom,
    dbTo: range.dbTo,
    dbRows: int(range.count),
    matchedRows: totals.count,
    detailLimit: query.limit,
    scope: describeScope(user),
    unit: user.unit,
    totals,
    basis: basisParts.join("；"),
    compare,
    groups: groups?.slice(0, query.limit),
    allGroups: groups,
    groupLabel: query.groupBy.join("、") || undefined,
    winner,
    details,
  };
}

export function answerSalesQuery(body: unknown, userId: string | undefined): QueryResult {
  const started = Date.now();
  const user = resolveUser(userId);
  if (!user) {
    return { ok: false, blocked: "permission", error: "已拦截：未知用户，拒绝查询。" };
  }
  const decision = applyGuard(body, user);
  if (!decision.allow) {
    appendAudit({
      layer: "api",
      userId: user.id,
      userName: user.name,
      decision: "blocked",
      kind: decision.kind,
      tool: "query_data",
      reason: decision.error,
      durationMs: Date.now() - started,
    });
    return { ok: false, blocked: decision.kind, error: decision.error };
  }
  const result = runQuery(decision.query, user);
  appendAudit({
    layer: "api",
    userId: user.id,
    userName: user.name,
    decision: "allow",
    tool: "query_data",
    limit: decision.query.limit,
    conditions: result.conditions,
    matchedRows: result.matchedRows,
    durationMs: Date.now() - started,
  });
  return result;
}

export function httpStatus(result: QueryResult) {
  if (result.ok) return 200;
  if (result.blocked === "permission" || result.blocked === "limit") return 403;
  return 400;
}

export function formatQueryResult(result: QueryResult) {
  if (!result.ok) return result.error;
  const lines = [
    `来源：${result.source}。模型不直接读表，也不在回答里重算。`,
    `查询条件：${result.conditions}`,
    `数据范围：库内 ${result.dbFrom} ~ ${result.dbTo}，共 ${result.dbRows} 行；本次命中 ${result.matchedRows} 行。合计使用全部命中行，不受明细上限截断。`,
    `权限范围：${result.scope}`,
    `展示单位：${result.unit}（工具已换算，1 万元 = 10000 元）`,
    `计算依据：${result.basis}`,
  ];
  if (result.compare) {
    const rateText = result.compare.rate === null ? "无（基期为 0）" : `${result.compare.rate}%`;
    lines.push(
      `对比：${result.compare.label}`,
      `本期：${result.compare.currentFrom} ~ ${result.compare.currentTo}，销售额 ${money(result.compare.current.amount)}`,
      `基期：${result.compare.baseFrom} ~ ${result.compare.baseTo}，销售额 ${money(result.compare.base.amount)}`,
      `差额：${money(result.compare.deltaAmount)}`,
      `比率：${rateText}`,
    );
  }
  lines.push(`结果：销售额 ${money(result.totals.amount)}，数量 ${result.totals.quantity}，笔数 ${result.totals.count}`);
  if (result.winner && result.groupLabel) {
    const word = result.winner.rank === "min" ? "最低" : "最高";
    lines.push(`极值：按${result.groupLabel}，销售额${word}的是${result.winner.key}，${money(result.winner.amount)}。这一名由数据库排序得到。`);
  }
  if (result.groups && result.groupLabel) {
    lines.push(`分组（按${result.groupLabel}）：`);
    if (result.groups.length === 0) lines.push("无");
    for (const group of result.groups) {
      lines.push(`${group.key}：${money(group.amount)}，数量 ${group.quantity}，笔数 ${group.count}`);
    }
  }
  lines.push(`明细（展示 ${result.details.length} 行，命中 ${result.matchedRows} 行）：`);
  if (result.details.length === 0) lines.push("无");
  for (const row of result.details) {
    lines.push(`${row.date} ${row.product} ${row.region} ${money(row.amount)} 数量 ${row.quantity} ${row.salesperson}`);
  }
  return lines.join("\n");
}

export function dataHealth() {
  const db = getSalesDatabase();
  const row = db.prepare("SELECT MIN(date) AS dbFrom, MAX(date) AS dbTo, COUNT(*) AS count FROM sales").get() as {
    dbFrom: string;
    dbTo: string;
    count: unknown;
  };
  let readOnly = false;
  try {
    db.exec("INSERT INTO sales (id, date, product, region, amount, quantity, salesperson) VALUES (999999, '2024-01-01', '笔记本', '华东', 1, 1, '王敏')");
  } catch {
    readOnly = true;
  }
  return {
    source: datasetName() === "shift" ? "sales-shift.sqlite" : "sales.sqlite",
    dataset: datasetName(),
    readOnly,
    rows: int(row.count),
    dbFrom: row.dbFrom,
    dbTo: row.dbTo,
  };
}
