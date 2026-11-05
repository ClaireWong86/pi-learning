import type { ToolCallMessagePartProps } from "@assistant-ui/react";

function field(text: string, prefix: string) {
  return text.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
}

export function QueryDataCard({ result, isError, status }: ToolCallMessagePartProps) {
  const text = typeof result === "string" ? result : "";
  const running = status.type === "running" && !text;
  const blocked = isError === true || text.startsWith("已拦截") || text.startsWith("无法查询");
  const matched = text.match(/本次命中 (\d+) 行/)?.[1] ?? "";
  const rows = [
    ["查询条件", field(text, "查询条件：")],
    ["命中", matched ? `${matched} 行` : ""],
    ["本期", field(text, "本期：")],
    ["基期", field(text, "基期：")],
    ["比率", field(text, "比率：")],
    ["结果", blocked ? text.split("\n")[0] ?? "" : field(text, "结果：")],
  ].filter((row) => row[1]);

  return (
    <div className="my-2 rounded-xl border px-3 py-2 text-sm">
      <div className="text-muted-foreground text-xs">{running ? "正在调用 query_data" : blocked ? "query_data 未执行" : "query_data 完成"}</div>
      {rows.length > 0 ? (
        <dl className="mt-2 grid gap-1">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[4.5rem_1fr] gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={blocked && label === "结果" ? "text-destructive" : ""}>{value}</dd>
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
