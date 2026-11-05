import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { QueryDataTool } from "./QueryDataTool.tsx";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="bubble user">
      <MessagePrimitive.Parts
        components={{
          Text: ({ text }) => <>{text}</>,
        }}
      />
    </MessagePrimitive.Root>
  );
}

function AssistantError() {
  const error = useAuiState((state) =>
    state.message.status.type === "incomplete" ? state.message.status.error : null,
  );
  if (error == null) return null;
  return <div className="error">{String(error)}</div>;
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="assistant-block">
      <MessagePrimitive.Parts
        components={{
          Text: ({ text }) => <div className="bubble">{text}</div>,
          Reasoning: ({ text }) => (
            <details className="thinking">
              <summary>思考</summary>
              <pre>{text}</pre>
            </details>
          ),
          tools: {
            by_name: { query_data: QueryDataTool },
            Fallback: QueryDataTool,
          },
        }}
      />
      <MessagePrimitive.Error>
        <AssistantError />
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

function Composer() {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input placeholder="问销售数据…" disabled={isRunning} />
      <ComposerPrimitive.Send disabled={isRunning}>发送</ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  );
}

export function Thread() {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="log">
        <ThreadPrimitive.Empty>
          <p className="kicker">选一个用户，点芯片或自己提问。右侧会留下这一轮轨迹。</p>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
  );
}
