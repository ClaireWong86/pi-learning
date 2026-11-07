import type { SuggestionAdapter, ThreadMessage, ThreadSuggestion } from "@assistant-ui/react";
import { getChatUser } from "./user-bridge.ts";

const REGIONS = ["华东", "华南", "华北", "西南", "西北", "东北"];
const PRODUCTS = ["笔记本", "显示器", "键盘", "鼠标"];

function assistantBundle(messages: readonly ThreadMessage[]) {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "";
  return last.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-call" && typeof part.result === "string") return part.result;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function mentions(text: string, words: readonly string[]) {
  return words.filter((word) => text.includes(word));
}

function push(list: ThreadSuggestion[], seen: Set<string>, title: string, prompt: string) {
  if (seen.has(prompt) || list.length >= 3) return;
  seen.add(prompt);
  list.push({ title, prompt });
}

export function suggestFollowUps(messages: readonly ThreadMessage[], userId: string): ThreadSuggestion[] {
  const bundle = assistantBundle(messages);
  if (!bundle.trim()) return [];
  const eastOnly = userId === "u001";
  const regions = mentions(bundle, REGIONS);
  const products = mentions(bundle, PRODUCTS);
  const groupedByProduct = /分组（按产品）|按产品/.test(bundle);
  const compared = bundle.includes("同比");
  const chained = bundle.includes("环比");
  const list: ThreadSuggestion[] = [];
  const seen = new Set<string>();

  if (!eastOnly) {
    const other = REGIONS.find((region) => !regions.includes(region));
    if (other && regions.length > 0) push(list, seen, `那${other}呢`, `那${other}呢？口径和上一问一样。`);
  }
  if (!groupedByProduct) push(list, seen, "按产品拆开", "按产品拆开，各卖了多少？");
  if (compared && !chained) push(list, seen, "改成环比", "改成和上一期比，环比是多少？");
  if (chained && !compared) push(list, seen, "改成同比", "改成和去年同期比，同比是多少？");
  if (!compared && !chained) push(list, seen, "看同比", "和去年同期比，同比是多少？");
  const product = products[0];
  if (product && !bundle.includes(`只看${product}`)) {
    push(list, seen, `只看${product}`, eastOnly ? `只看${product}，华东卖了多少？` : `只看${product}，各地区卖了多少？`);
  }
  if (list.length === 0) push(list, seen, "换成上个月", "换成上个月，再查一次。");
  return list.filter((item) => !eastOnly || !REGIONS.some((region) => region !== "华东" && item.prompt.includes(region)));
}

export const salesSuggestionAdapter: SuggestionAdapter = {
  key: "sales-followups",
  async generate({ messages }) {
    return suggestFollowUps(messages, getChatUser());
  },
};
