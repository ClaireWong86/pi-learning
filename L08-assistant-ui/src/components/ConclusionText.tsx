import type { FC, ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { conditionLabel, focusQuery, linkFigures, type FigureCall } from "../runtime/figures.ts";

function queryCalls(parts: readonly { type: string; toolCallId?: string; result?: unknown }[]): FigureCall[] {
  const calls: FigureCall[] = [];
  for (const part of parts) {
    if (part.type !== "tool-call" || !part.toolCallId || typeof part.result !== "string" || !part.result.trim()) continue;
    calls.push({ id: part.toolCallId, text: part.result });
  }
  return calls;
}

const QueryLink: FC<{ href?: string; children?: ReactNode; className?: string }> = ({ href, children, className }) => {
  const id = href?.startsWith("#query-") ? href.slice("#query-".length) : "";
  if (!id) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        focusQuery(id);
      }}
    >
      {children}
    </a>
  );
};

export function ConclusionText() {
  const parts = useAuiState((state) => state.message.parts);
  const calls = queryCalls(parts);
  return (
    <div data-aui-quote-selectable="true">
      <MarkdownText
        preprocess={(text) => linkFigures(text, calls)}
        components={{ a: QueryLink }}
      />
      {calls.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {calls.map((call, index) => (
            <button
              key={call.id}
              type="button"
              className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-full border px-2.5 py-0.5 text-xs"
              onClick={() => focusQuery(call.id)}
            >
              {conditionLabel(call.text, index)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
