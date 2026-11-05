import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { SALES_ROWS, type SalesRow } from "../sales-data.ts";
import { mountDataApi } from "../sales-api.ts";
import {
  answerSalesQuery,
  applyGuard,
  comparisonWindow,
  dataHealth,
  formatQueryResult,
  rateOf,
  scopeTightening,
  scopeViolation,
  type NormalizedQuery,
} from "../sales-query.ts";
import { USERS } from "../sales-data.ts";
import { QUESTIONS, type Question } from "./questions.ts";
import { hasAmount, scoreAnswer } from "./score.ts";

function field(row: SalesRow, column: string) {
  if (column === "日期") return row.date;
  if (column === "产品") return row.product;
  if (column === "地区") return row.region;
  if (column === "销售额") return row.amount;
  if (column === "数量") return row.quantity;
  if (column === "销售人员") return row.salesperson;
  if (column === "月份") return row.date.slice(0, 7);
  throw new Error(`未知列 ${column}`);
}

function matches(row: SalesRow, filter: NonNullable<Question["filters"]>[number]) {
  const cell = field(row, filter.column);
  const text = String(cell);
  const left = Number(cell);
  const right = Number(filter.value);
  if (filter.operator === "=") return text === filter.value;
  if (filter.operator === "!=") return text !== filter.value;
  if (filter.operator === ">") return left > right;
  if (filter.operator === "<") return left < right;
  if (filter.operator === ">=") return left >= right;
  if (filter.operator === "<=") return left <= right;
  if (filter.operator === "contains") return text.includes(filter.value);
  if (filter.operator === "in") return filter.value.split(",").map((part) => part.trim()).includes(text);
  return false;
}

function select(question: Question, window?: { from?: string; to?: string }) {
  const from = window?.from ?? question.dateFrom;
  const to = window?.to ?? question.dateTo;
  return SALES_ROWS.filter((row) => {
    if (from && row.date < from) return false;
    if (to && row.date > to) return false;
    return (question.filters ?? []).every((filter) => matches(row, filter));
  });
}

function sum(rows: SalesRow[]) {
  return {
    amount: rows.reduce((total, row) => total + row.amount, 0),
    quantity: rows.reduce((total, row) => total + row.quantity, 0),
    count: rows.length,
  };
}

function group(rows: SalesRow[], column: string) {
  const buckets = new Map<string, SalesRow[]>();
  for (const row of rows) {
    const key = String(field(row, column));
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()].map(([key, grouped]) => ({ key, ...sum(grouped) }));
}

function bodyOf(question: Question) {
  return {
    dateFrom: question.dateFrom,
    dateTo: question.dateTo,
    filters: question.filters,
    groupBy: question.groupBy,
    compare: question.compare,
    rank: question.rank,
    limit: 100,
  };
}

const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok  ${name}`);
    return;
  }
  failures.push(`${name} ${detail}`.trim());
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

for (const question of QUESTIONS) {
  const rows = select(question);
  const byHand = sum(rows);
  const result = answerSalesQuery(bodyOf(question), question.userId);
  if (!result.ok) {
    check(question.id, false, result.error);
    continue;
  }
  check(`${question.id} 独立汇总=引擎`, byHand.amount === result.totals.amount && byHand.count === result.totals.count, `手算 ${byHand.amount}/${byHand.count} 引擎 ${result.totals.amount}/${result.totals.count}`);
  if (question.expect.quantity !== undefined && !question.rank) {
    check(`${question.id} 数量`, byHand.quantity === question.expect.quantity && result.totals.quantity === question.expect.quantity, `手算 ${byHand.quantity}`);
  }
  if (question.expect.count !== undefined && !question.rank) {
    check(`${question.id} 笔数`, byHand.count === question.expect.count, `手算 ${byHand.count}`);
  }
  if (question.rank) {
    const ranked = group(rows, question.groupBy?.[0] ?? "地区").sort((a, b) => a.amount - b.amount || a.key.localeCompare(b.key, "zh"));
    const winner = question.rank === "min" ? ranked[0] : ranked[ranked.length - 1];
    check(`${question.id} 极值`, result.winner?.key === winner?.key && result.winner?.amount === question.expect.amount && winner?.amount === question.expect.amount, `期望 ${question.expect.amount} 引擎 ${result.winner?.key} ${result.winner?.amount}`);
  } else if (!question.compare) {
    check(`${question.id} 标准答案`, byHand.amount === question.expect.amount && result.totals.amount === question.expect.amount, `标准 ${question.expect.amount} 手算 ${byHand.amount}`);
  }
  if (question.compare && question.baseFrom && question.baseTo) {
    const window = comparisonWindow(question.dateFrom!, question.dateTo!, question.compare);
    const baseRows = select(question, { from: question.baseFrom, to: question.baseTo });
    const base = sum(baseRows);
    const rate = rateOf(byHand.amount, base.amount);
    check(`${question.id} 基期窗口`, window.from === question.baseFrom && window.to === question.baseTo, `${window.from}~${window.to}`);
    check(`${question.id} 本期`, result.totals.amount === question.expect.amount && byHand.amount === question.expect.amount, String(byHand.amount));
    check(`${question.id} 基期`, result.compare?.base.amount === question.expect.baseAmount && base.amount === question.expect.baseAmount, String(base.amount));
    check(`${question.id} 差额`, result.compare?.deltaAmount === question.expect.delta && byHand.amount - base.amount === question.expect.delta, String(byHand.amount - base.amount));
    check(`${question.id} 比率`, result.compare?.rate === question.expect.rates?.[0] && rate === question.expect.rates?.[0], `引擎 ${result.compare?.rate} 公式 ${rate}`);
  }
  if (question.expect.pairs && question.groupBy) {
    const ranked = group(rows, question.groupBy[0]).sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key, "zh"));
    if (question.rank === "min") ranked.sort((a, b) => a.amount - b.amount || a.key.localeCompare(b.key, "zh"));
    for (const pair of question.expect.pairs) {
      const found = ranked.find((item) => item.key === pair.key);
      const engineGroup = result.groups?.find((item) => item.key === pair.key);
      check(`${question.id} ${pair.key}`, found?.amount === pair.amount && engineGroup?.amount === pair.amount, `手算 ${found?.amount} 引擎 ${engineGroup?.amount}`);
    }
    check(`${question.id} 分组顺序`, JSON.stringify(result.groups?.map((item) => item.key)) === JSON.stringify(ranked.map((item) => item.key)));
  }
  const text = formatQueryResult(result);
  check(`${question.id} 依据可见`, text.includes("查询条件：") && text.includes("数据范围：") && text.includes("计算依据：") && text.includes("明细"));
  check(`${question.id} 只读来源`, text.includes("POST /api/sales/query") && text.includes("只读"));
  if (question.id === "q02") check("明细金额已换算成万元", text.includes("15.00 万元") && text.includes("6.00 万元"));
}

const injected = applyGuard({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }, USERS.u001);
assert.equal(injected.allow, true);
if (injected.allow) {
  const again = applyGuard(injected.query satisfies NormalizedQuery, USERS.u001);
  assert.equal(again.allow, true);
  if (again.allow) {
    const regionFilters = again.query.filters.filter((filter) => filter.column === "地区");
    check("权限注入可重复执行", regionFilters.length === 1 && regionFilters[0]?.value === "华东");
check(
  "已写明地区不算收紧",
  scopeTightening([{ column: "地区", operator: "=", value: "华东" }], [{ column: "地区", operator: "=", value: "华东" }]) === null,
);
check(
  "补上权限地区才算收紧",
  scopeTightening([], [{ column: "地区", operator: "in", value: "华东" }]) === "查询范围收窄为华东",
);
  }
  const scoped = answerSalesQuery({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }, "u001");
  check("华东经理看不到全公司", scoped.ok && scoped.totals.amount === 210000 && scoped.totals.amount !== 418000, scoped.ok ? String(scoped.totals.amount) : scoped.error);
}

const denied = answerSalesQuery(
  { dateFrom: "2026-01-01", dateTo: "2026-01-31", filters: [{ column: "地区", operator: "=", value: "华南" }, { column: "产品", operator: "=", value: "笔记本" }] },
  "u001",
);
check("越权地区被拒绝", !denied.ok && denied.blocked === "permission" && !denied.error.includes("110000"), denied.ok ? "竟然放行" : denied.error);
check("问题里的越权地区也被拒绝", scopeViolation("2026年1月华南笔记本销售额是多少？", USERS.u001)?.includes("华南") === true);

const limited = answerSalesQuery({ limit: 9999 }, "u002");
check("limit 9999 被拒绝", !limited.ok && limited.blocked === "limit" && limited.error.includes("100"), limited.ok ? "竟然放行" : limited.error);
const allowed = applyGuard({ limit: 20 }, USERS.u002);
check("limit 20 放行", allowed.allow && allowed.query.limit === 20);

const sql = answerSalesQuery({ sql: "DELETE FROM sales", dateFrom: "2026-01-01", dateTo: "2026-01-31" }, "u002");
check("拒绝 SQL", !sql.ok && sql.error.includes("SQL"));

const health = dataHealth();
check("数据库只读", health.readOnly === true && health.rows === 28, JSON.stringify(health));

check("非自然月环比窗口", JSON.stringify(comparisonWindow("2026-01-06", "2026-01-20", "mom")) === JSON.stringify({ from: "2025-12-22", to: "2026-01-05" }));
check("自然月同比窗口", JSON.stringify(comparisonWindow("2026-02-01", "2026-02-28", "yoy")) === JSON.stringify({ from: "2025-02-01", to: "2025-02-28" }));
check("基期为 0 不做除法", rateOf(0, 0) === null);

const contains = answerSalesQuery({ dateFrom: "2026-01-01", dateTo: "2026-01-31", filters: [{ column: "产品", operator: "contains", value: "笔记" }] }, "u002");
check("contains 笔记本", contains.ok && contains.totals.amount === 330000, contains.ok ? String(contains.totals.amount) : contains.error);

const inside = answerSalesQuery(
  { dateFrom: "2026-01-01", dateTo: "2026-01-31", filters: [{ column: "地区", operator: "in", value: "华东,华北" }] },
  "u002",
);
check("in 多地区", inside.ok && inside.totals.amount === 300000, inside.ok ? String(inside.totals.amount) : inside.error);

const copied = scoreAnswer("查询条件：示例\n数据范围：库内\n计算依据：SUM\n结论：15.00 万元", ["结果：销售额 150000 元（15.00 万元），数量 15"], { amounts: [150000] }, "2026年1月");
check("评分认可万元", copied.accurate && copied.fabricated.length === 0 && copied.cited);
const invented = scoreAnswer("结论：大概 20 万元", ["结果：销售额 150000 元（15.00 万元）"], { amounts: [150000] }, "销售额是多少");
check("评分抓住编造", !invented.accurate && invented.fabricated.some((value) => value === 20));
const listed = scoreAnswer("1. 结论：150000 元", ["150000 元"], { amounts: [150000] }, "问");
check("列表序号不算编造", listed.accurate && listed.fabricated.length === 0);
const spacedYear = scoreAnswer(
  "查询条件：日期 2026-01-01 ~ 2026-01-31\n数据范围：库内 2025-01-05 ~ 2026-03-23\n计算依据：150000 元（15.00 万元）\n结论：2026 年 1 月华东笔记本销售额为 15.00 万元。",
  ["结果：销售额 150000 元（15.00 万元）\n数据范围：库内 2025-01-05 ~ 2026-03-23"],
  { amounts: [150000] },
  "2026年1月华东地区的笔记本销售额是多少？",
);
check("带空格的年份不算编造", spacedYear.accurate && spacedYear.fabricated.length === 0, JSON.stringify(spacedYear.fabricated));
const months = scoreAnswer("并非完整 12 个月。销售额 12.50 万元", ["125000 元（12.50 万元）"], { amounts: [125000] }, "李强2026年");
check("个月不算业务数字", months.accurate && months.fabricated.length === 0, JSON.stringify(months.businessNumbers));
check("金额判断不会把数量 15 当成 15 万", hasAmount("数量 15", 150000) === false && hasAmount("15.00 万元", 150000));
const dropped = scoreAnswer(
  "查询条件：x\n数据范围：x\n计算依据：环比比率 = (本期 110000 − 基期 225000) / 基期 225000 = −51.11%\n结论：减少 11.50 万元，环比下降 51.11%。",
  ["本期：110000 元\n基期：225000 元\n差额：-115000 元（-11.50 万元）\n比率：-51.11%"],
  { amounts: [110000, 225000, -115000], rates: ["-51.11"] },
  "那3月呢？",
);
check("下降表述与全角负号认负数", dropped.accurate && dropped.fabricated.length === 0, JSON.stringify(dropped));

const app = express();
app.use(express.json());
mountDataApi(app);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;
app.post("/relay", async (_req, res) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/sales/query`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": "u002" },
    body: JSON.stringify({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      filters: [
        { column: "地区", operator: "=", value: "华东" },
        { column: "产品", operator: "=", value: "笔记本" },
      ],
    }),
  });
  res.status(response.status).json(await response.json());
});
const relay = await fetch(`http://127.0.0.1:${port}/relay`, { method: "POST" });
const relayBody = (await relay.json()) as { ok?: boolean; totals?: { amount?: number } };
check("只读 API 自调用", relay.ok && relayBody.ok === true && relayBody.totals?.amount === 150000, JSON.stringify(relayBody));
server.close();

console.log(failures.length === 0 ? `\n标准答案 ${QUESTIONS.length}/${QUESTIONS.length} 与只读库一致` : `\n失败 ${failures.length} 项`);
if (failures.length) process.exit(1);
