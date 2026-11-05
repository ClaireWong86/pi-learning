export type Expectation = {
  amounts?: number[];
  numbers?: number[];
  rates?: string[];
  pairs?: Array<{ key: string; amount: number }>;
  text?: string[];
  forbidAmounts?: number[];
};

export type Score = {
  accurate: boolean;
  missing: string[];
  businessNumbers: number[];
  fabricated: number[];
  cited: boolean;
};

function stripCalendar(text: string) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g, " ")
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, " ")
    .replace(/\d{4}\s*年/g, " ")
    .replace(/\d{1,2}\s*月/g, " ")
    .replace(/\d{1,2}\s*日/g, " ");
}

export function allNumbers(text: string) {
  // 工具原文用全角减号 − 表示负数，先归一成 ASCII 负号再抽数字。
  return [...stripCalendar(text.replace(/−/g, "-")).matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

export function businessNumbers(text: string) {
  const stripped = stripCalendar(text);
  const found: number[] = [];
  for (const match of stripped.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const raw = match[0];
    const value = Number(raw);
    const index = match.index ?? 0;
    const after = stripped.slice(index + raw.length, index + raw.length + 8);
    if (/^个月/.test(after.trimStart()) || /^\s*个月/.test(after)) continue;
    const money = /元|万|%|％/.test(after);
    const unit = /笔|台|件|个/.test(after);
    const bareYear = raw.length === 4 && value >= 1990 && value <= 2100 && !money;
    if (bareYear) continue;
    if (money || unit || Math.abs(value) >= 1000 || raw.includes(".")) found.push(value);
  }
  return found;
}

export function hasAmount(text: string, amount: number) {
  const numbers = allNumbers(text);
  if (numbers.some((value) => value === amount)) return true;
  const wan = (amount / 10000).toFixed(2);
  if (text.includes(wan)) return true;
  if (!text.includes("万")) return false;
  return numbers.some((value) => Math.abs(value - Number(wan)) < 1e-9);
}

function hasExact(text: string, value: number) {
  return allNumbers(text).some((item) => item === value);
}

function hasRate(text: string, rate: string) {
  const normalized = text.replace(/−/g, "-");
  if (normalized.includes(rate)) return true;
  const target = Number(rate);
  if (allNumbers(normalized).some((value) => Math.abs(value - target) < 1e-9)) return true;
  // 「下降 51.11%」就是 -51.11%，方向词已经把符号说出来了。
  return target < 0 && /下降|减少|降低/.test(normalized) && allNumbers(normalized).some((value) => Math.abs(value - Math.abs(target)) < 1e-9);
}

function hasSignedAmount(text: string, amount: number) {
  if (hasAmount(text, amount)) return true;
  // 「减少 11.50 万元」就是 -115000 元。
  return amount < 0 && /下降|减少|降低/.test(text) && hasAmount(text, Math.abs(amount));
}

function hasPair(text: string, key: string, amount: number) {
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(key, from);
    if (index < 0) return false;
    const window = text.slice(Math.max(0, index - 24), index + key.length + 48);
    if (hasAmount(window, amount)) return true;
    from = index + key.length;
  }
  return false;
}

function grounded(value: number, pool: number[]) {
  return pool.some((item) => {
    if (Math.abs(item - value) < 1e-6) return true;
    // 「下降 9.09%」复述的是工具给出的 -9.09%。
    return Math.abs(value) < 100 && !Number.isInteger(value) && Math.abs(item + value) < 1e-6;
  });
}

export function scoreAnswer(answer: string, toolTexts: string[], expect: Expectation, question: string): Score {
  const missing: string[] = [];
  for (const amount of expect.amounts ?? []) {
    if (!hasSignedAmount(answer, amount)) missing.push(`金额 ${amount}`);
  }
  for (const value of expect.numbers ?? []) {
    if (!hasExact(answer, value)) missing.push(`数字 ${value}`);
  }
  for (const rate of expect.rates ?? []) {
    if (!hasRate(answer, rate)) missing.push(`比率 ${rate}`);
  }
  for (const pair of expect.pairs ?? []) {
    if (!hasPair(answer, pair.key, pair.amount)) missing.push(`${pair.key} ${pair.amount}`);
  }
  for (const text of expect.text ?? []) {
    if (!answer.includes(text)) missing.push(`原文 ${text}`);
  }
  for (const amount of expect.forbidAmounts ?? []) {
    if (hasAmount(answer, amount)) missing.push(`不该出现 ${amount}`);
  }
  const pool = [...allNumbers(toolTexts.join("\n")), ...allNumbers(question)];
  const found = businessNumbers(answer);
  const fabricated = found.filter((value) => !grounded(value, pool));
  return {
    accurate: missing.length === 0,
    missing,
    businessNumbers: found,
    fabricated,
    cited: answer.includes("查询条件") && answer.includes("数据范围") && answer.includes("计算依据"),
  };
}
