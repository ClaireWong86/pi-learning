export type FigureCall = {
  id: string;
  text: string;
};

const NUMBER = /\d+\.\d{2}|\d{5,}/g;
const HEADLINE = /^(结果|本期|基期|差额|比率|极值)：/;

export function focusQuery(toolCallId: string) {
  const node = document.getElementById(`query-${toolCallId}`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "nearest" });
  node.classList.add("ring-2", "ring-foreground/40");
  window.setTimeout(() => node.classList.remove("ring-2", "ring-foreground/40"), 1400);
}

function numbersIn(text: string) {
  return [...text.matchAll(NUMBER)].map((match) => match[0]);
}

function headlineHas(text: string, number: string) {
  return text.split("\n").some((line) => HEADLINE.test(line) && line.includes(number));
}

export function ownerOf(number: string, calls: readonly FigureCall[]) {
  const owners = calls.filter((call) => call.id && call.text.includes(number));
  if (owners.length === 0) return "";
  if (owners.length === 1) return owners[0]?.id ?? "";
  const headline = owners.filter((call) => headlineHas(call.text, number));
  const pool = headline.length > 0 ? headline : owners;
  return pool[pool.length - 1]?.id ?? "";
}

export function linkFigures(text: string, calls: readonly FigureCall[]) {
  const seen = new Set<string>();
  for (const call of calls) {
    for (const number of numbersIn(call.text)) seen.add(number);
  }
  const ordered = [...seen].filter((number) => !/^20\d{2}$/.test(number)).sort((a, b) => b.length - a.length);
  let result = text;
  for (const number of ordered) {
    const owner = ownerOf(number, calls);
    if (!owner || !result.includes(number)) continue;
    result = result.replaceAll(number, (value, offset, whole) => {
      const before = whole[offset - 1] ?? "";
      const after = whole[offset + value.length] ?? "";
      if (before === "[" || before === "#" || before === "-" || after === "年" || after === "-" || after === "/") return value;
      return `[${value}](#query-${owner})`;
    });
  }
  return result;
}

export function conditionLabel(text: string, index: number) {
  const blocked = text.startsWith("已拦截") || text.startsWith("无法查询");
  if (blocked) return text.split("\n")[0]?.slice(0, 28) || "未执行";
  const condition = text
    .split("\n")
    .find((line) => line.startsWith("查询条件："))
    ?.slice("查询条件：".length)
    .trim();
  if (condition) return condition.slice(0, 36);
  return `第 ${index + 1} 次查询`;
}
