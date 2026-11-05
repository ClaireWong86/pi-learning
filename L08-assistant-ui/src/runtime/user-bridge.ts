const listeners = new Set<(userId: string) => void>();
let currentUserId = "u002";

const userByPrompt: Record<string, string> = {
  "2026年3月销售额最低的地区是哪里？这个地区相比去年3月，同比是多少？先找出地区，再查同比。": "u002",
  "2026年1月哪个产品销售额最高？只看这个产品，华东和华南各卖了多少？": "u002",
  "2026年1月华东笔记本的销售额是多少？": "u002",
  "2026年1月华南笔记本销售额是多少？": "u001",
};

export function bindChatUser(listener: (userId: string) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getChatUser() {
  return currentUserId;
}

export function chooseChatUser(userId: string) {
  currentUserId = userId;
  for (const listener of listeners) listener(userId);
}

export function userForPrompt(prompt: string, fallback: string) {
  const userId = userByPrompt[prompt];
  if (!userId) return fallback;
  chooseChatUser(userId);
  return userId;
}
