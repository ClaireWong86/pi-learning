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

type ThreadRow = {
  threadId: string;
  title: string;
  updatedAt: string;
};

const unsupported = () => Promise.reject(new Error("当前服务端不支持改标题、归档或删除"));

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
          status: "regular" as const,
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
        status: "regular",
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
    rename: unsupported,
    archive: unsupported,
    delete: unsupported,
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
          const body = (await response.json()) as { messages?: { role?: string; text?: string }[] };
          const messages: ThreadMessageLike[] = [];
          for (const item of body.messages ?? []) {
            if ((item.role !== "user" && item.role !== "assistant") || !item.text) continue;
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
