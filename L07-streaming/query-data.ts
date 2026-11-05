import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getLive } from "./live.ts";
import { PRODUCTS, REGIONS, SALESPEOPLE } from "./sales-data.ts";
import { formatQueryResult, MAX_LIMIT, type QueryResult } from "./sales-query.ts";

const filterSchema = Type.Object({
  column: Type.Union(
    [Type.Literal("日期"), Type.Literal("产品"), Type.Literal("地区"), Type.Literal("销售额"), Type.Literal("数量"), Type.Literal("销售人员")],
    { description: "列名" },
  ),
  operator: Type.Union(
    [
      Type.Literal("="),
      Type.Literal("!="),
      Type.Literal(">"),
      Type.Literal("<"),
      Type.Literal(">="),
      Type.Literal("<="),
      Type.Literal("contains"),
      Type.Literal("in"),
    ],
    { description: "运算符。地区只允许 = 或 in。销售额用元做比较。" },
  ),
  value: Type.String({ description: "过滤值。in 用英文逗号分隔。金额单位是元。" }),
});

function asRecord(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return { ...(args as Record<string, unknown>) };
}

export const queryDataTool = defineTool({
  name: "query_data",
  label: "查询销售数据",
  description: `查询只读销售库并在库内完成求和、分组、同比、环比。不要自己算数字。
金额单位是元。可选产品：${PRODUCTS.join("、")}。可选地区：${REGIONS.join("、")}。可选销售人员：${SALESPEOPLE.join("、")}。
多个 filters 是并且关系。日期范围用 dateFrom/dateTo，含首尾。自然月从 1 日到最后一天，2026-02 的最后一天是 2026-02-28。第一季度是 01-01 到 03-31，全年是 01-01 到 12-31。
compare=yoy 是同比，compare=mom 是环比。自然月的环比是上一个自然月。rank=min 或 max 必须配 groupBy，用来取最低或最高，不要自己比较。
分组和同比不要放在同一次调用里。limit 默认 20，最大 ${MAX_LIMIT}，只截断明细，不截断合计。
例：2026年1月华东笔记本 → {"dateFrom":"2026-01-01","dateTo":"2026-01-31","filters":[{"column":"地区","operator":"=","value":"华东"},{"column":"产品","operator":"=","value":"笔记本"}]}
例：大于10万元 → {"filters":[{"column":"销售额","operator":">","value":"100000"}]}
例：2026年1月笔记本同比 → {"dateFrom":"2026-01-01","dateTo":"2026-01-31","compare":"yoy","filters":[{"column":"产品","operator":"=","value":"笔记本"}]}
例：2026年3月销售额最低的地区 → {"dateFrom":"2026-03-01","dateTo":"2026-03-31","groupBy":["地区"],"rank":"min"}`,
  parameters: Type.Object({
    filters: Type.Optional(Type.Array(filterSchema, { description: "并且关系的过滤条件，可省略" })),
    dateFrom: Type.Optional(Type.String({ description: "起始日期，含当天，YYYY-MM-DD" })),
    dateTo: Type.Optional(Type.String({ description: "结束日期，含当天，YYYY-MM-DD" })),
    groupBy: Type.Optional(
      Type.Array(Type.Union([Type.Literal("产品"), Type.Literal("地区"), Type.Literal("销售人员"), Type.Literal("月份")]), {
        description: "分组列",
      }),
    ),
    compare: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("yoy"), Type.Literal("mom")], { description: "yoy 同比，mom 环比" })),
    order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "分组排序，默认 desc" })),
    rank: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("min"), Type.Literal("max")], { description: "取分组后的最低或最高" })),
    limit: Type.Optional(Type.Number({ description: `明细或分组最多返回行数，默认 20，最大 ${MAX_LIMIT}` })),
  }),
  prepareArguments(args: unknown) {
    const raw = asRecord(args);
    if (typeof raw.filters === "string") {
      try {
        raw.filters = JSON.parse(raw.filters);
      } catch {
        // 交给 schema 校验报错。
      }
    }
    if (typeof raw.groupBy === "string" && raw.groupBy) raw.groupBy = [raw.groupBy];
    if (typeof raw.limit === "string" && raw.limit.trim()) raw.limit = Number(raw.limit);
    if (raw.compare === "同比") raw.compare = "yoy";
    if (raw.compare === "环比") raw.compare = "mom";
    if (raw.compare === "无" || raw.compare === "") delete raw.compare;
    if (raw.rank === "最低") raw.rank = "min";
    if (raw.rank === "最高") raw.rank = "max";
    if (raw.order === "升序") raw.order = "asc";
    if (raw.order === "降序") raw.order = "desc";
    return raw;
  },
  async execute(_id, params) {
    const live = getLive();
    if (!live) {
      return { content: [{ type: "text", text: "无法查询：没有用户上下文。" }], details: { ok: false } };
    }
    const base = process.env.SALES_API_BASE;
    if (!base) {
      return { content: [{ type: "text", text: "无法查询：只读查询服务未配置。" }], details: { ok: false } };
    }
    const body = {
      filters: params.filters,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      groupBy: params.groupBy,
      compare: params.compare,
      order: params.order,
      rank: params.rank,
      limit: params.limit,
    };
    try {
      const response = await fetch(`${base}/api/sales/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": live.user.id,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await response.json()) as QueryResult;
      return {
        content: [{ type: "text", text: formatQueryResult(json) }],
        details: {
          ok: json.ok,
          matchedRows: json.ok ? json.matchedRows : 0,
          amount: json.ok ? json.totals.amount : null,
          group: json.ok ? (json.groupLabel ?? null) : null,
          winner: json.ok && json.winner ? { key: json.winner.key, rank: json.winner.rank } : null,
          groups: json.ok ? (json.allGroups ?? json.groups ?? []).map((group) => ({ key: group.key, amount: group.amount })) : null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `无法查询：只读接口没有响应。${message}` }], details: { ok: false } };
    }
  },
});
