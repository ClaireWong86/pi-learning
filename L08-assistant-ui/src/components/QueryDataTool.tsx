import type { ToolCallMessagePartProps } from "@assistant-ui/react";

export function QueryDataTool({ toolName, args, result, isError, status }: ToolCallMessagePartProps) {
  const running = status.type === "running";
  const label = running
    ? `正在调用 ${toolName}`
    : isError
      ? `${toolName} 未执行`
      : `${toolName} 完成`;

  return (
    <div className="tool">
      <small>{label}</small>
      <pre>{JSON.stringify(args, null, 2)}</pre>
      {result != null && result !== "" ? <pre>{String(result)}</pre> : null}
    </div>
  );
}
