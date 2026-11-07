import { useMemo } from "react";
import { createAssistantStream } from "assistant-stream";
import {
  ExportedMessageRepository,
  useAui,
  type RemoteThreadListAdapter,
  type RuntimeAdapters,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { getChatUser } from "./user-bridge.ts";
import { hydrateThread } from "./trace-store.ts";

type ThreadRow = {
  threadId: string;
  title: string;
  updatedAt: string;
  archived?: boolean;
};

async function writeThread(threadId: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: path.endsWith(threadId) ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: getChatUser(), ...body }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? "会话没有保存");
  }
}

function lineTitle(messages: readonly { content?: readonly { type?: string; text?: string }[] }[]) {
  for (const message of messages) {
    const text = message.content?.find((part) => part.type === "text")?.text?.trim();
    if (text) return text.slice(0, 60);
  }
  return "";
}

async function loadThreads(userId: string): Promise<ThreadRow[]> {
  const response = await fetch(`/api/threads?userId=${encodeURIComponent(userId)}`);
  if (!response.ok) return [];
  const body = (await response.json()) as { threads?: ThreadRow[] };
  return body.threads ?? [];
}

export function createThreadListAdapter(userId: string): RemoteThreadListAdapter {
  return {
    async list() {
      const threads = await loadThreads(userId);
      return {
        threads: threads.map((thread) => ({
          status: thread.archived ? ("archived" as const) : ("regular" as const),
          remoteId: thread.threadId,
          title: thread.title || undefined,
          lastMessageAt: new Date(thread.updatedAt),
        })),
      };
    },
    async initialize(threadId) {
      const remoteId = threadId.startsWith("__LOCALID_") ? crypto.randomUUID() : threadId;
      return { remoteId };
    },
    async fetch(threadId) {
      const threads = await loadThreads(userId);
      const thread = threads.find((item) => item.threadId === threadId);
      return {
        status: thread?.archived ? "archived" : "regular",
        remoteId: threadId,
        title: thread?.title || undefined,
        lastMessageAt: thread ? new Date(thread.updatedAt) : undefined,
      };
    },
    async generateTitle(_remoteId, messages) {
      const title = lineTitle(messages);
      return createAssistantStream((controller) => {
        if (title) controller.appendText(title);
      });
    },
    async rename(remoteId, newTitle) {
      await writeThread(remoteId, `/api/threads/${encodeURIComponent(remoteId)}`, { title: newTitle });
    },
    async archive(remoteId) {
      await writeThread(remoteId, `/api/threads/${encodeURIComponent(remoteId)}/archive`, {});
    },
    async unarchive(remoteId) {
      await writeThread(remoteId, `/api/threads/${encodeURIComponent(remoteId)}/unarchive`, {});
    },
    async delete(remoteId) {
      const response = await fetch(`/api/threads/${encodeURIComponent(remoteId)}?userId=${encodeURIComponent(getChatUser())}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "会话没有删除");
      }
    },
    unstable_useAdapters: useSalesHistory,
  };
}

function useSalesHistory(): RuntimeAdapters {
  const aui = useAui();
  return useMemo(
    () => ({
      history: {
        async load() {
          const remoteId = aui.threadListItem.getState().remoteId;
          if (!remoteId) return { messages: [] };
          const response = await fetch(
            `/api/threads/${encodeURIComponent(remoteId)}/history?userId=${encodeURIComponent(getChatUser())}`,
          );
          if (!response.ok) return { messages: [] };
          const body = (await response.json()) as {
            messages?: { role?: string; text?: string; parts?: ThreadMessageLike["content"] }[];
            rounds?: unknown[];
          };
          if (remoteId) hydrateThread(remoteId, body.rounds ?? []);
          const messages: ThreadMessageLike[] = [];
          for (const item of body.messages ?? []) {
            if (item.role !== "user" && item.role !== "assistant") continue;
            if (Array.isArray(item.parts) && item.parts.length > 0) {
              messages.push({ role: item.role, content: item.parts });
              continue;
            }
            if (!item.text) continue;
            messages.push({ role: item.role, content: item.text });
          }
          return ExportedMessageRepository.fromArray(messages);
        },
        async append() {},
      },
    }),
    [aui],
  );
}
