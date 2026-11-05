import { useEffect } from "react";
import { tickDuration, useTrace, type TraceCallView } from "../runtime/trace-store.ts";

function statusOf(outcome: TraceCallView["outcome"]) {
  if (outcome === "ok") return "返回";
  if (outcome === "blocked") return "拦住";
  if (outcome === "error") return "未执行";
  return "进行中";
}

function statusClass(outcome: TraceCallView["outcome"]) {
  if (outcome === "ok") return "text-emerald-300";
  if (outcome === "blocked") return "text-amber-300";
  return "text-red-300";
}

export function TraceRail() {
  const trace = useTrace();

  useEffect(() => {
    if (!trace.startedAt) return;
    const timer = setInterval(tickDuration, 200);
    return () => clearInterval(timer);
  }, [trace.startedAt]);

  return (
    <aside className="w-96 shrink-0 overflow-auto border-l bg-zinc-950 p-4 text-sm text-zinc-100">
      <h2 className="mb-3 text-sm font-medium">轨迹</h2>
      {trace.empty ? (
        <p className="text-zinc-400">发送问题后，这里按调用留下轮次、提交参数、放行后的条件、结果和依赖。</p>
      ) : (
        trace.rounds.map((round, roundIndex) => (
          <section className="mb-6" key={`${round.input}-${roundIndex}`}>
            <p className="text-xs text-zinc-500">第 {roundIndex + 1} 问</p>
            <p className="mt-1 leading-5">{round.input}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div className="text-zinc-400">模型</div>
              <div>{round.model}</div>
              <div className="text-zinc-400">用户</div>
              <div>{round.user}</div>
              <div className="text-zinc-400">时长</div>
              <div>{round.duration}</div>
              <div className="text-zinc-400">轮次</div>
              <div>{round.turns}</div>
            </dl>
            {round.calls.map((call, index) => (
              <article className="mt-3 border-t border-white/10 pt-2" key={`${call.id}-${index}`}>
                <div className="flex justify-between gap-2">
                  <span>第 {call.turnIndex || "?"} 轮 · {call.name}</span>
                  <span className={statusClass(call.outcome)}>{statusOf(call.outcome)}</span>
                </div>
                <p className="mt-2 text-xs text-zinc-400">提交参数</p>
                <pre className="mt-1 whitespace-pre-wrap text-xs text-emerald-100">{JSON.stringify(call.args, null, 2)}</pre>
                {call.effective ? (
                  <>
                    <p className="mt-2 text-xs text-zinc-400">放行后</p>
                    <pre className="mt-1 whitespace-pre-wrap text-xs text-emerald-100">{JSON.stringify(call.effective, null, 2)}</pre>
                  </>
                ) : null}
                {call.dependsOn?.map((link) => {
                  const at = round.calls.findIndex((item) => item.id === link.callId);
                  const kind = link.take === "max" ? "最大组" : "极值";
                  return (
                    <p className="mt-2 text-xs text-zinc-300" key={`${link.callId}-${link.value}`}>
                      依赖第 {at + 1} 次调用的{kind}「{link.value}」
                    </p>
                  );
                })}
                {call.extremum?.key ? <p className="mt-2 text-xs">极值：{call.extremum.key}</p> : null}
                {call.resultPreview ? <pre className="mt-1 whitespace-pre-wrap text-xs text-zinc-300">{call.resultPreview}</pre> : null}
              </article>
            ))}
          </section>
        ))
      )}
    </aside>
  );
}
