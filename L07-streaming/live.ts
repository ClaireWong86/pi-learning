import type { User } from "./sales-data.ts";

export type LiveEvent = Record<string, unknown> & { type: string };

export type Live = {
  user: User;
  input: string;
  blockedIds: Set<string>;
  // 单次提问内的工具调用计数与参数签名，由 step-guard 扩展维护（步数上限 / 重复调用拦截）。
  toolCallCount: number;
  seenToolCalls: Set<string>;
  emit: (event: LiveEvent) => void;
};

let current: Live | null = null;

export function setLive(live: Live | null) {
  current = live;
}

export function getLive() {
  return current;
}
