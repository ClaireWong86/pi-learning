import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useTrace, type TraceCallView } from "../runtime/trace-store.ts";

function field(text: string, prefix: string) {
  return text.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function guardLine(call: TraceCallView | undefined, blocked: boolean) {
  if (!call && blocked) return "拦住";
  if (!call) return "";
  if (call.outcome === "blocked" || call.blockKind) {
    const kind = call.blockKind === "permission" ? "权限" : call.blockKind === "limit" ? "限额" : call.blockKind === "duplicate" ? "重复" : call.blockKind === "step" ? "步数" : "拦住";
    return `${kind}拦住`;
  }
  if (call.tightened) return "收紧后放行";
  if (call.outcome === "ok") return "放行";
  if (call.outcome === "running") return "检查中";
  return "未执行";
}

function auditLine(call: TraceCallView | undefined) {
  const audit = call?.audit;
  if (!audit) return "";
  const decision = audit.decision === "allow" ? "通过" : audit.decision === "blocked" ? "拦住" : audit.decision === "error" ? "失败" : audit.decision;
  const rows = audit.matchedRows == null ? "" : ` · 命中 ${audit.matchedRows} 行`;
  const cost = audit.durationMs == null ? "" : ` · ${audit.durationMs} ms`;
  return `${audit.userName} · ${decision}${rows}${cost}`;
}

export function QueryDataCard({ result, isError, status, toolCallId }: ToolCallMessagePartProps) {
  const trace = useTrace();
  const text = typeof result === "string" ? result : "";
  const call = trace.rounds.flatMap((round) => round.calls).find((item) => item.id === toolCallId);
  const running = status.type === "running" && !text;
  const blocked = isError === true || text.startsWith("已拦截") || text.startsWith("无法查询") || call?.outcome === "blocked";
  const matched = text.match(/本次命中 (\d+) 行/)?.[1] ?? "";
  const rows = [
    ["权限", field(text, "权限范围：")],
    ["护栏", guardLine(call, blocked)],
    ["审计", auditLine(call)],
    ["查询条件", field(text, "查询条件：")],
    ["命中", matched ? `${matched} 行` : ""],
    ["本期", field(text, "本期：")],
    ["基期", field(text, "基期：")],
    ["比率", field(text, "比率：")],
    ["结果", blocked ? (call?.blockReason || text.split("\n")[0] || "") : field(text, "结果：")],
  ].filter((row) => row[1]);

  return (
    <div id={toolCallId ? `query-${toolCallId}` : undefined} className="my-2 scroll-mt-4 rounded-xl border px-3 py-2 text-sm transition-shadow">
      <div className="text-muted-foreground text-xs">{running ? "正在调用 query_data" : blocked ? "query_data 未执行" : "query_data 完成"}</div>
      {rows.length > 0 ? (
        <dl className="mt-2 grid gap-1">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[4.5rem_1fr] gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={blocked && (label === "结果" || label === "护栏") ? "text-destructive" : ""}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {text ? (
        <details className="mt-2">
          <summary className="text-muted-foreground cursor-pointer text-xs">全文</summary>
          <pre className="mt-1 whitespace-pre-wrap text-xs">{text}</pre>
        </details>
      ) : null}
    </div>
  );
}
