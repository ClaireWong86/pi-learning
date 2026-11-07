import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Suggestions,
  Tools,
  defineToolkit,
  useAuiState,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryDataCard } from "./components/QueryDataCard.tsx";
import { TraceRail } from "./components/TraceRail.tsx";
import { createSalesChatModel } from "./runtime/chat-model.ts";
import { salesSuggestionAdapter } from "./runtime/follow-ups.ts";
import { createThreadListAdapter } from "./runtime/thread-list.ts";
import { noteUser, showThread, useTrace } from "./runtime/trace-store.ts";
import { bindChatUser, chooseChatUser } from "./runtime/user-bridge.ts";

const suggestions = Suggestions([
  { title: "单次查询", label: "", prompt: "2026年1月华东笔记本的销售额是多少？" },
  { title: "多轮同比", label: "", prompt: "2026年3月销售额最低的地区是哪里？这个地区相比去年3月，同比是多少？先找出地区，再查同比。" },
  { title: "先排名再拆分", label: "", prompt: "2026年1月哪个产品销售额最高？只看这个产品，华东和华南各卖了多少？" },
  { title: "越权查询", label: "", prompt: "2026年1月华南笔记本销售额是多少？" },
]);

const toolkit = defineToolkit({
  query_data: {
    type: "backend",
    render: QueryDataCard,
  },
});

const config = AuiConfig({
  suggestions,
  tools: Tools({ toolkit }),
});

function ModelChip() {
  const [label, setLabel] = useState("deepseek-flash");
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((body: { model?: string }) => {
        const name = body.model?.split("/").at(-1);
        if (name) setLabel(name);
      })
      .catch(() => undefined);
  }, []);
  return <span className="text-muted-foreground px-1 text-xs">{label}</span>;
}

function Shell({
  userId,
  onUserId,
}: {
  userId: string;
  onUserId: (id: string) => void;
}) {
  const [health, setHealth] = useState("正在连接只读销售库…");
  const [traceOpen, setTraceOpen] = useState(true);
  const trace = useTrace();
  const isRunning = useAuiState((state) => state.thread.isRunning);

  useEffect(() => {
    if (trace.reveal > 0) setTraceOpen(true);
  }, [trace.reveal]);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((body: { model?: string; source?: string; rows?: number }) => {
        setHealth(`${body.model} · 只读 ${body.source} · ${body.rows} 行`);
      })
      .catch(() => setHealth("只读库还没连上"));
  }, []);

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-dvh overflow-hidden">
        <aside className="bg-muted/40 flex h-full w-64 shrink-0 flex-col border-r">
          <div className="flex h-12 items-center px-4 text-sm font-medium">assistant-ui</div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-3">
            <ThreadList />
            <label className="text-muted-foreground flex flex-col gap-1 px-1 text-xs">
              当前用户
              <select
                className="bg-background text-foreground h-9 rounded-lg border px-2 text-sm"
                value={userId}
                disabled={isRunning}
                onChange={(event) => {
                  chooseChatUser(event.target.value);
                  noteUser(event.target.value);
                  onUserId(event.target.value);
                }}
              >
                <option value="u002">李先生 · 全部地区</option>
                <option value="u001">王小姐 · 仅华东</option>
              </select>
            </label>
          </div>
          <p className="text-muted-foreground px-4 py-3 text-xs leading-5">{health}</p>
        </aside>
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4 text-sm">
            <span className="shrink-0">{userId === "u001" ? "王小姐 · 仅华东" : "李先生 · 全部地区"}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs"
              onClick={() => setTraceOpen((open) => !open)}
            >
              {traceOpen ? "收起记录" : "权限 · 护栏 · 审计 · 轨迹"}
            </button>
          </header>
          <div className="min-h-0 flex-1">
            <Thread components={{ ComposerExtra: ModelChip }} />
          </div>
        </div>
        {traceOpen ? <TraceRail /> : null}
      </div>
    </TooltipProvider>
  );
}

export function App() {
  const [userId, setUserId] = useState("u002");
  const userIdRef = useRef(userId);
  const threadIdRef = useRef(crypto.randomUUID());
  userIdRef.current = userId;

  useEffect(() => bindChatUser(setUserId), []);

  const listAdapter = useMemo(() => createThreadListAdapter(userId), [userId]);
  const chatModel = useMemo(
    () =>
      createSalesChatModel(
        () => userIdRef.current,
        () => threadIdRef.current,
        (threadId) => {
          threadIdRef.current = threadId;
        },
      ),
    [],
  );
  const runtime = useRemoteThreadListRuntime({
    adapter: listAdapter,
    runtimeHook: function useSalesModel() {
      return useLocalRuntime(chatModel, { adapters: { suggestion: salesSuggestionAdapter } });
    },
    onThreadIdChange: (threadId) => {
      if (!threadId) return;
      threadIdRef.current = threadId;
      showThread(threadId);
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <Shell userId={userId} onUserId={setUserId} />
    </AssistantRuntimeProvider>
  );
}
