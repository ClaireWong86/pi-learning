import assert from "node:assert/strict";
import { DIALOGUES, MULTI_QUESTIONS, SHIFT_MULTI } from "./questions.ts";
import { SALES_ROWS_SHIFT, type SalesRow } from "../sales-data.ts";
import {
  linkDependencies,
  scoreCallBudget,
  scoreRepair,
  scoreTrajectory,
  scoreTurnLinks,
  traceOk,
  type TraceCall,
  type TrajectorySpec,
} from "../trace-model.ts";

let passed = 0;

function check(name: string, condition: boolean, detail = "") {
  assert.equal(condition, true, `${name} ${detail}`);
  passed += 1;
  console.log(`✓ ${name}`);
}

function call(partial: Partial<TraceCall> & Pick<TraceCall, "id" | "turnIndex" | "outcome">): TraceCall {
  return { name: "query_data", args: {}, ...partial };
}

function envelope(calls: TraceCall[], turns = 4) {
  return {
    model: "deepseek/deepseek-flash",
    input: "问题",
    durationMs: 10,
    tools: ["query_data"],
    turns: Array.from({ length: turns }, (_, index) => ({ index: index + 1 })),
    calls,
  };
}

const m01 = MULTI_QUESTIONS.find((question) => question.id === "m01");
const m04 = MULTI_QUESTIONS.find((question) => question.id === "m04");
assert.ok(m01 && m04);

const causal: TrajectorySpec = m01.trajectory;

check(
  "m01 规格不写死地区",
  causal.steps.every((step) => !step.filters?.some((filter) => filter.column === "地区")),
);

const south = call({
  id: "a",
  turnIndex: 1,
  outcome: "ok",
  args: { dateFrom: "2026-01-01", dateTo: "2026-01-31", groupBy: ["地区"], rank: "max" },
  group: "地区",
  extremum: { group: "地区", rank: "max", key: "华南" },
});
const drill = call({
  id: "b",
  turnIndex: 2,
  outcome: "ok",
  args: { dateFrom: "2026-01-01", dateTo: "2026-01-31", groupBy: ["产品"], filters: [{ column: "地区", operator: "=", value: "华南" }] },
});
check("过滤值等于上一步极值", scoreTrajectory(envelope([south, drill]), causal).pass);

const guessed = call({
  ...drill,
  id: "b2",
  args: { dateFrom: "2026-01-01", dateTo: "2026-01-31", groupBy: ["产品"], filters: [{ column: "地区", operator: "=", value: "华东" }] },
});
const guessedScore = scoreTrajectory(envelope([south, guessed]), causal);
check("记住华东不算通过", !guessedScore.pass && guessedScore.detail.includes("过滤值不是上一步工具结果"), guessedScore.detail);

const sameTurn = call({ ...drill, turnIndex: 1 });
const sameTurnScore = scoreTrajectory(envelope([south, sameTurn], 2), causal);
check("同轮依赖不通过", !sameTurnScore.pass && sameTurnScore.detail.includes("同一轮"), sameTurnScore.detail);

const failed = call({
  id: "bad",
  turnIndex: 1,
  outcome: "error",
  args: { dateFrom: "2026-01-01", dateTo: "2026-01-31", groupBy: ["地区"], rank: "max", compare: "yoy" },
});
const recovered = scoreTrajectory(envelope([failed, { ...south, turnIndex: 2 }, { ...drill, turnIndex: 3 }]), causal);
check("失败调用不占步骤", recovered.pass, recovered.detail);

check("单步两次成功不通过", !scoreCallBudget(envelope([south, drill]), 1).pass);
check("拦住后再成功一次算单步", scoreCallBudget(envelope([call({ id: "x", turnIndex: 1, outcome: "blocked", blockKind: "limit", args: { limit: 9999 } }), south]), 1).pass);

const repair = scoreRepair(
  envelope([
    call({ id: "lim", turnIndex: 1, outcome: "blocked", blockKind: "limit", args: { limit: 9999 } }),
    call({ id: "ok", turnIndex: 2, outcome: "ok", args: { limit: 100 } }),
  ]),
);
check("限额重试通过", repair.pass, repair.detail);
check("没有降限不算重试", !scoreRepair(envelope([call({ id: "lim", turnIndex: 1, outcome: "blocked", blockKind: "limit", args: { limit: 9999 } })])).pass);

const d04 = DIALOGUES.find((dialogue) => dialogue.id === "d04");
assert.ok(d04);
const regionCall = call({
  id: "r",
  turnIndex: 1,
  outcome: "ok",
  args: { groupBy: ["地区"], rank: "min" },
  group: "地区",
  extremum: { group: "地区", rank: "min", key: "华北" },
});
const peopleCall = call({
  id: "p",
  turnIndex: 1,
  outcome: "ok",
  args: { groupBy: ["销售人员"], filters: [{ column: "地区", value: "华北" }] },
  group: "销售人员",
  groups: [
    { key: "赵磊", amount: 30000 },
    { key: "孙悦", amount: 9000 },
  ],
});
const personCall = call({
  id: "who",
  turnIndex: 1,
  outcome: "ok",
  args: { filters: [{ column: "销售人员", value: "赵磊" }] },
});
const links = scoreTurnLinks(d04.turns, [envelope([regionCall]), envelope([peopleCall]), envelope([personCall])]);
check("d04 跨轮对齐", links?.pass === true, links?.detail);
const wrongPerson = scoreTurnLinks(d04.turns, [
  envelope([regionCall]),
  envelope([peopleCall]),
  envelope([call({ id: "who", turnIndex: 1, outcome: "ok", args: { filters: [{ column: "销售人员", value: "孙悦" }] } })]),
]);
check("d04 拿错人不过", wrongPerson?.pass === false);

const linked = linkDependencies([south, drill]);
check("依赖链接指向极值调用", linked[1]?.dependsOn?.[0]?.callId === "a" && linked[1]?.dependsOn?.[0]?.value === "华南");
check("信封要求轮次和结果", traceOk(envelope([south])) && !traceOk({ model: "m", input: "q", durationMs: 1, tools: [], turns: [], calls: [{ args: {} }] }));

const parallel = scoreTrajectory(
  envelope(
    [
      call({ id: "g", turnIndex: 1, outcome: "ok", args: { dateFrom: "2026-01-01", dateTo: "2026-01-31", groupBy: ["地区"] } }),
      call({
        id: "e",
        turnIndex: 1,
        outcome: "ok",
        args: { dateFrom: "2026-01-01", dateTo: "2026-01-31", compare: "yoy", filters: [{ column: "地区", value: "华东" }] },
      }),
      call({
        id: "s",
        turnIndex: 1,
        outcome: "ok",
        args: { dateFrom: "2026-01-01", dateTo: "2026-01-31", compare: "yoy", filters: [{ column: "地区", value: "华南" }] },
      }),
    ],
    2,
  ),
  m04.trajectory,
);
check("无依赖的步骤可以同轮", parallel.pass, parallel.detail);

function inMonth(row: SalesRow, month: string) {
  return row.date >= `${month}-01` && row.date <= `${month}-31`;
}

function by(rows: SalesRow[], column: "region" | "product" | "salesperson") {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row[column], (totals.get(row[column]) ?? 0) + row.amount);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

const jan = SALES_ROWS_SHIFT.filter((row) => inMonth(row, "2026-01"));
const janRegions = by(jan, "region");
const janMax = janRegions[0];
assert.ok(janMax);
const janProducts = by(
  jan.filter((row) => row.region === janMax[0]),
  "product",
);
const base = SALES_ROWS_SHIFT.filter((row) => inMonth(row, "2025-01") && row.region === janMax[0] && row.product === janProducts[0]?.[0]).reduce((sum, row) => sum + row.amount, 0);
const rate = (((janProducts[0]?.[1] ?? 0) - base) / base * 100).toFixed(2);
const march = SALES_ROWS_SHIFT.filter((row) => inMonth(row, "2026-03"));
const marchRegions = by(march, "region");
const marchMin = marchRegions[marchRegions.length - 1];
assert.ok(marchMin);
const marchPeople = by(
  march.filter((row) => row.region === marchMin[0]),
  "salesperson",
);

check("换种子后 1 月最高不是华东", janMax[0] === "华南" && janMax[1] === 250000, `${janMax[0]} ${janMax[1]}`);
check("换种子后 3 月最低不是华北", marchMin[0] === "西南" && marchMin[1] === 5000, `${marchMin[0]} ${marchMin[1]}`);
check("华南笔记本同比 212.50", rate === "212.50" && base === 80000, rate);

const shift01 = SHIFT_MULTI.find((question) => question.id === "m01");
const shift02 = SHIFT_MULTI.find((question) => question.id === "m02");
const shift03 = SHIFT_MULTI.find((question) => question.id === "m03");
assert.ok(shift01 && shift02 && shift03);
check("shift 题面与默认相同", shift01.question === m01.question && shift01.trajectory === m01.trajectory);
check("shift m01 期望是华南", shift01.expect.text?.includes("华南") === true && shift01.expect.amounts?.includes(250000) === true);
check("shift m02 期望是西南和周宁", shift02.expect.text?.includes("西南") === true && shift02.expect.text?.includes(marchPeople[0]?.[0] ?? "") === true);
check("shift m03 期望含 212.50", shift03.expect.rates?.includes("212.50") === true && shift03.expect.amounts?.includes(170000) === true);

console.log(`\n轨迹检查 ${passed} 项通过`);
