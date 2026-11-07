import { useEffect } from "react";
import { tickDuration, useTrace, type AuditView, type TraceCallView } from "../runtime/trace-store.ts";

function decisionLabel(decision: string) {
  if (decision === "allow") return "通过";
  if (decision === "blocked") return "拦住";
  if (decision === "error") return "失败";
  return decision;
}

function guardLabel(call: TraceCallView) {
  if (call.outcome === "blocked" || call.blockKind) {
    const kind = call.blockKind === "permission" ? "权限" : call.blockKind === "limit" ? "限额" : call.blockKind === "duplicate" ? "重复" : call.blockKind === "step" ? "步数" : "";
    return kind ? `${kind}拦住` : "拦住";
  }
  if (call.tightened) return "收紧后放行";
  if (call.outcome === "ok") return "放行";
  if (call.outcome === "running") return "检查中";
  return "未执行";
}

function AuditLine({ audit }: { audit: AuditView }) {
  const rows = audit.matchedRows == null ? "" : `命中 ${audit.matchedRows} 行`;
  const cost = audit.durationMs == null ? "" : `${audit.durationMs} ms`;
  return (
    <li className="leading-5">
      <span>{audit.userName}</span>
      <span className="text-muted-foreground"> · {decisionLabel(audit.decision)}</span>
      {rows ? <span className="text-muted-foreground"> · {rows}</span> : null}
      {cost ? <span className="text-muted-foreground"> · {cost}</span> : null}
      {audit.reason ? <p className="text-muted-foreground text-xs">{audit.reason}</p> : null}
    </li>
  );
}

export function TraceRail() {
  const trace = useTrace();

  useEffect(() => {
    if (!trace.startedAt) return;
    const timer = setInterval(tickDuration, 200);
    return () => clearInterval(timer);
  }, [trace.startedAt]);

  return (
    <aside className="bg-background h-full w-96 shrink-0 overflow-y-auto overscroll-y-contain border-l p-4 text-sm">
      <h2 className="mb-1 text-sm font-medium">这一问的记录</h2>
      <p className="text-muted-foreground mb-4 text-xs leading-5">权限、护栏、审计和轨迹都留在这里。结果卡上能看到同一次调用的摘要。</p>
      {trace.empty ? (
        <dl className="grid gap-3">
          <div>
            <dt className="font-medium">权限</dt>
            <dd className="text-muted-foreground text-xs leading-5">当前用户能看哪些地区。换人后，上一名用户的记录会清掉。</dd>
          </div>
          <div>
            <dt className="font-medium">护栏</dt>
            <dd className="text-muted-foreground text-xs leading-5">越权、超额、重复和步数上限会拦住。权限内的查询放行，范围不够时会收紧条件。</dd>
          </div>
          <div>
            <dt className="font-medium">审计</dt>
            <dd className="text-muted-foreground text-xs leading-5">谁、决定、命中行数、耗时。</dd>
          </div>
          <div>
            <dt className="font-medium">轨迹</dt>
            <dd className="text-muted-foreground text-xs leading-5">每次调用的轮次、参数，以及后一步是否用了上一步的极值。</dd>
          </div>
        </dl>
      ) : (
        trace.rounds.map((round, roundIndex) => (
          <section className="mb-6 border-t pt-3 first:border-t-0 first:pt-0" key={`${round.input}-${roundIndex}`}>
            <p className="text-muted-foreground text-xs">第 {roundIndex + 1} 问 · {round.turns} 轮 · {round.duration}</p>
            <p className="mt-1 leading-5">{round.input}</p>

            <h3 className="mt-3 text-xs font-medium">权限</h3>
            <p className="mt-1">
              {round.user} · {round.scope}
            </p>

            <h3 className="mt-3 text-xs font-medium">护栏</h3>
            {round.calls.length === 0 ? (
              <p className="text-muted-foreground mt-1 text-xs">这一问还没有调用。</p>
            ) : (
              <ul className="mt-1 grid gap-1">
                {round.calls.map((call, index) => (
                  <li key={`${call.id}-guard-${index}`}>
                    第 {index + 1} 次 · {guardLabel(call)}
                    {call.blockReason ? <p className="text-muted-foreground text-xs">{call.blockReason}</p> : null}
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mt-3 text-xs font-medium">审计</h3>
            {round.audits.length === 0 ? (
              <p className="text-muted-foreground mt-1 text-xs">还没有审计记录。</p>
            ) : (
              <ul className="mt-1 grid gap-1">
                {round.audits.map((audit, index) => (
                  <AuditLine audit={audit} key={`${audit.id ?? "audit"}-${index}`} />
                ))}
              </ul>
            )}

            <h3 className="mt-3 text-xs font-medium">轨迹</h3>
            {round.calls.map((call, index) => (
              <article className="mt-2 border-t pt-2" key={`${call.id}-trace-${index}`}>
                <div className="flex justify-between gap-2">
                  <span>第 {call.turnIndex || "?"} 轮 · {call.name}</span>
                  <span className="text-muted-foreground">{guardLabel(call)}</span>
                </div>
                {call.dependsOn?.map((link) => {
                  const at = round.calls.findIndex((item) => item.id === link.callId);
                  const kind = link.take === "max" ? "最大组" : "极值";
                  return (
                    <p className="text-muted-foreground mt-1 text-xs" key={`${link.callId}-${link.value}`}>
                      依赖第 {at + 1} 次调用的{kind}「{link.value}」
                    </p>
                  );
                })}
                {call.extremum?.key ? <p className="mt-1 text-xs">极值：{call.extremum.key}</p> : null}
                <details className="mt-1">
                  <summary className="text-muted-foreground cursor-pointer text-xs">参数</summary>
                  <p className="text-muted-foreground mt-1 text-xs">提交</p>
                  <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(call.args, null, 2)}</pre>
                  {call.effective ? (
                    <>
                      <p className="text-muted-foreground mt-1 text-xs">放行后</p>
                      <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(call.effective, null, 2)}</pre>
                    </>
                  ) : null}
                </details>
              </article>
            ))}
          </section>
        ))
      )}
    </aside>
  );
}
