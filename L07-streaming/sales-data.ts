// 只读销售库的种子。标准答案不写在这里，由 eval/oracle.ts 按这些行独立汇总。
export type SalesRow = {
  id: number;
  date: string;
  product: string;
  region: string;
  amount: number;
  quantity: number;
  salesperson: string;
};

export const SALES_ROWS: SalesRow[] = [
  { id: 1, date: "2025-01-05", product: "笔记本", region: "华东", amount: 100000, quantity: 10, salesperson: "王敏" },
  { id: 2, date: "2025-01-18", product: "显示器", region: "华东", amount: 40000, quantity: 20, salesperson: "李强" },
  { id: 3, date: "2025-01-08", product: "键盘", region: "华北", amount: 10000, quantity: 40, salesperson: "赵磊" },
  { id: 4, date: "2025-01-22", product: "笔记本", region: "华南", amount: 80000, quantity: 8, salesperson: "陈静" },
  { id: 5, date: "2025-01-15", product: "鼠标", region: "西南", amount: 5000, quantity: 25, salesperson: "周宁" },
  { id: 6, date: "2025-02-03", product: "笔记本", region: "华东", amount: 120000, quantity: 12, salesperson: "王敏" },
  { id: 7, date: "2025-02-20", product: "显示器", region: "华东", amount: 50000, quantity: 25, salesperson: "李强" },
  { id: 8, date: "2025-02-11", product: "键盘", region: "华北", amount: 15000, quantity: 50, salesperson: "赵磊" },
  { id: 9, date: "2025-02-16", product: "笔记本", region: "华南", amount: 90000, quantity: 9, salesperson: "陈静" },
  { id: 10, date: "2025-02-27", product: "鼠标", region: "西南", amount: 6000, quantity: 30, salesperson: "周宁" },
  { id: 11, date: "2026-01-06", product: "笔记本", region: "华东", amount: 150000, quantity: 15, salesperson: "王敏" },
  { id: 12, date: "2026-01-21", product: "显示器", region: "华东", amount: 60000, quantity: 30, salesperson: "李强" },
  { id: 13, date: "2026-01-09", product: "键盘", region: "华北", amount: 20000, quantity: 60, salesperson: "赵磊" },
  { id: 14, date: "2026-01-28", product: "笔记本", region: "华南", amount: 110000, quantity: 11, salesperson: "陈静" },
  { id: 15, date: "2026-01-15", product: "鼠标", region: "西南", amount: 8000, quantity: 40, salesperson: "周宁" },
  { id: 16, date: "2026-01-21", product: "笔记本", region: "华北", amount: 70000, quantity: 7, salesperson: "孙悦" },
  { id: 17, date: "2026-02-04", product: "笔记本", region: "华东", amount: 180000, quantity: 18, salesperson: "王敏" },
  { id: 18, date: "2026-02-17", product: "显示器", region: "华东", amount: 45000, quantity: 22, salesperson: "李强" },
  { id: 19, date: "2026-02-08", product: "键盘", region: "华北", amount: 18000, quantity: 55, salesperson: "赵磊" },
  { id: 20, date: "2026-02-12", product: "笔记本", region: "华南", amount: 100000, quantity: 10, salesperson: "陈静" },
  { id: 21, date: "2026-02-25", product: "鼠标", region: "西南", amount: 7000, quantity: 35, salesperson: "周宁" },
  { id: 22, date: "2026-02-19", product: "键盘", region: "华南", amount: 12000, quantity: 30, salesperson: "陈静" },
  { id: 23, date: "2026-03-02", product: "笔记本", region: "华东", amount: 90000, quantity: 9, salesperson: "王敏" },
  { id: 24, date: "2026-03-19", product: "键盘", region: "华东", amount: 20000, quantity: 100, salesperson: "李强" },
  { id: 25, date: "2026-03-07", product: "显示器", region: "华北", amount: 30000, quantity: 15, salesperson: "赵磊" },
  { id: 26, date: "2026-03-11", product: "笔记本", region: "华南", amount: 130000, quantity: 13, salesperson: "陈静" },
  { id: 27, date: "2026-03-23", product: "笔记本", region: "西南", amount: 40000, quantity: 4, salesperson: "周宁" },
  { id: 28, date: "2026-03-16", product: "键盘", region: "华北", amount: 9000, quantity: 45, salesperson: "孙悦" },
];

// 换种子只改两行，用来确认多步过滤值来自工具极值，而不是记住「华东 / 华北」。
// 2026-01 最高地区变为华南；2026-03 最低地区变为西南。
export const SALES_ROWS_SHIFT: SalesRow[] = SALES_ROWS.map((row) => {
  if (row.id === 14) return { ...row, amount: 250000, quantity: 25 };
  if (row.id === 27) return { ...row, amount: 5000, quantity: 1 };
  return { ...row };
});

export function datasetName(): "base" | "shift" {
  return process.env.SALES_DATASET === "shift" ? "shift" : "base";
}

export function salesRows(): SalesRow[] {
  return datasetName() === "shift" ? SALES_ROWS_SHIFT : SALES_ROWS;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export const PRODUCTS = unique(SALES_ROWS.map((row) => row.product));
export const REGIONS = unique(SALES_ROWS.map((row) => row.region));
export const SALESPEOPLE = unique(SALES_ROWS.map((row) => row.salesperson));

export type User = {
  id: string;
  name: string;
  department: string;
  role: string;
  regions: "*" | string[];
  unit: "元" | "万元";
};

export const USERS: Record<string, User> = {
  u001: {
    id: "u001",
    name: "王小姐",
    department: "销售部",
    role: "华东销售经理",
    regions: ["华东"],
    unit: "万元",
  },
  u002: {
    id: "u002",
    name: "李先生",
    department: "财务部",
    role: "财务分析师",
    regions: "*",
    unit: "万元",
  },
};

export function resolveUser(id: string | undefined): User | null {
  if (!id) return null;
  return USERS[id] ?? null;
}

export function allowsRegion(user: User, region: string) {
  return user.regions === "*" || user.regions.includes(region);
}

export const SEED_VERSION = 1;
