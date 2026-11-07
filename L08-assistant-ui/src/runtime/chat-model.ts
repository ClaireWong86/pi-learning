import type {
  ChatModelAdapter,
  ChatModelRunResult,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import { readSse } from "./sse.ts";
import { beginRound, dispatchTrace, noteUser } from "./trace-store.ts";
import { userForPrompt } from "./user-bridge.ts";

const IDLE_TIMEOUT_MS = 45_000;

const leafByAssistant = new Map<string, string>();
const forkByUser = new Map<string, string | null>();

function lastUserMessage(messages: readonly ThreadMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return undefined;
}

function previousAssistant(messages: readonly ThreadMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function quoteOf(message: ThreadMessage | undefined) {
  const quote = message?.metadata?.custom?.quote;
  if (!quote || typeof quote !== "object" || !("text" in quote)) return "";
  return typeof quote.text === "string" ? quote.text.trim() : "";
}

function messageText(message: ThreadMessage | undefined) {
  if (!message) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function outgoingText(text: string, quote: string) {
  if (quote && text) return `${text}\n（引用结论：${quote}）`;
  if (quote) return `这段「${quote}」是怎么算出来的？请对照查询结果说明。`;
  return text;
}

function snapshot(reasoning: string, tools: Map<string, ToolCallMessagePart>, text: string): ThreadAssistantMessagePart[] {
  const parts: ThreadAssistantMessagePart[] = [];
  if (reasoning) parts.push({ type: "reasoning", text: reasoning });
  parts.push(...tools.values());
  if (text) parts.push({ type: "text", text });
  return parts;
}

export function createSalesChatModel(
  getUserId: () => string,
  getThreadId: () => string,
  onThreadId: (threadId: string) => void,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, unstable_threadId, unstable_assistantMessageId }): AsyncGenerator<ChatModelRunResult, void> {
      const userMessage = lastUserMessage(messages);
      const quote = quoteOf(userMessage);
      const message = outgoingText(messageText(userMessage), quote);
      const threadFromRun = unstable_threadId && !unstable_threadId.startsWith("__LOCALID_") ? unstable_threadId : "";
      const threadId = threadFromRun || getThreadId() || crypto.randomUUID();
      if (threadId !== getThreadId()) onThreadId(threadId);
      const assistantId = unstable_assistantMessageId ?? "";
      const prior = previousAssistant(messages);
      beginRound(assistantId, prior?.id ?? null);
      const continueFrom = prior ? leafByAssistant.get(`${threadId}:${prior.id}`) : undefined;
      const regenerate = !continueFrom && userMessage ? forkByUser.has(`${threadId}:${userMessage.id}`) : false;
      const forkFrom = regenerate && userMessage ? forkByUser.get(`${threadId}:${userMessage.id}`) : undefined;
      if (!message) {
        yield { status: { type: "incomplete", reason: "error", error: "message 不能为空" } };
        return;
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      abortSignal.addEventListener("abort", onAbort);

      let timedOut = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, IDLE_TIMEOUT_MS);
      };
      armIdle();

      let text = "";
      let reasoning = "";
      const tools = new Map<string, ToolCallMessagePart>();
      const current = () => snapshot(reasoning, tools, text);

      try {
        const userId = userForPrompt(message, getUserId());
        noteUser(userId);
        const response = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            userId,
            threadId,
            ...(continueFrom ? { continueFrom } : {}),
            ...(regenerate ? { regenerate: true, forkFrom: forkFrom ?? null } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
          yield {
            content: current(),
            status: { type: "incomplete", reason: "error", error: body.error ?? `HTTP ${response.status}` },
          };
          return;
        }

        for await (const event of readSse(response)) {
          armIdle();
          if (event.type === "text") {
            text += String(event.delta ?? "");
            yield { content: current() };
          } else if (event.type === "thinking") {
            reasoning += String(event.delta ?? "");
            yield { content: current() };
          } else if (event.type === "tool_start") {
            const id = String(event.id ?? `call-${tools.size + 1}`);
            const args = (event.args ?? {}) as Record<string, unknown>;
            tools.set(id, {
              type: "tool-call",
              toolCallId: id,
              toolName: String(event.name ?? "query_data"),
              args,
              argsText: JSON.stringify(args),
            });
            dispatchTrace(event);
            yield { content: current() };
          } else if (event.type === "tool_end") {
            const id = String(event.id ?? "");
            const prev = tools.get(id);
            if (prev) {
              tools.set(id, {
                ...prev,
                result: event.result,
                isError: event.isError === true,
              });
            }
            dispatchTrace(event);
            yield { content: current() };
          } else if (event.type === "error") {
            dispatchTrace(event);
            yield {
              content: current(),
              status: { type: "incomplete", reason: "error", error: String(event.message ?? "出错了") },
            };
            return;
          } else if (
            event.type === "trace_start" ||
            event.type === "turn" ||
            event.type === "guard" ||
            event.type === "audit" ||
            event.type === "trace_end"
          ) {
            if (event.type === "trace_start" && typeof event.threadId === "string") onThreadId(event.threadId);
            if (event.type === "trace_end") {
              const leafId = typeof event.leafId === "string" ? event.leafId : "";
              if (assistantId && leafId) leafByAssistant.set(`${threadId}:${assistantId}`, leafId);
              if (userMessage && "forkPoint" in event) {
                forkByUser.set(`${threadId}:${userMessage.id}`, typeof event.forkPoint === "string" ? event.forkPoint : null);
              }
            }
            dispatchTrace(event);
          } else if (event.type === "done") {
            return;
          }
        }
      } catch (error) {
        if (timedOut) {
          yield {
            content: current(),
            status: { type: "incomplete", reason: "error", error: "等待超时，已中止" },
          };
          return;
        }
        if (controller.signal.aborted || abortSignal.aborted) {
          yield { content: current(), status: { type: "incomplete", reason: "cancelled" } };
          return;
        }
        const textError = error instanceof Error ? error.message : String(error);
        yield { content: current(), status: { type: "incomplete", reason: "error", error: textError } };
      } finally {
        clearTimeout(idleTimer);
        abortSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}
