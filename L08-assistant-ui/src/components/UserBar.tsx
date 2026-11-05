import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";

export const CHIPS = [
  { userId: "u002", q: "2026年1月笔记本销售额同比2025年1月，本期、基期和比率分别是多少？", label: "同比" },
  { userId: "u002", q: "2026年3月销售额最低的地区是哪里？金额是多少？", label: "最低地区" },
  { userId: "u002", q: "销售额大于10万元的订单有多少笔？这些订单的销售额合计是多少？", label: "大于10万" },
  { userId: "u001", q: "2026年1月华南笔记本销售额是多少？", label: "越权查询" },
] as const;

type Health = {
  model?: string;
  source?: string;
  rows?: number;
  dbFrom?: string;
  dbTo?: string;
};

export function UserBar({
  userId,
  threadId,
  onUserId,
  onNewThread,
  onChip,
}: {
  userId: string;
  threadId: string;
  onUserId: (id: string) => void;
  onNewThread: () => void;
  onChip: (userId: string, question: string) => void;
}) {
  const [health, setHealth] = useState("正在连接只读销售库…");
  const isRunning = useAuiState((state) => state.thread.isRunning);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((body: Health) => {
        setHealth(`${body.model} · 只读 ${body.source} · ${body.rows} 行 · ${body.dbFrom} ~ ${body.dbTo}`);
      })
      .catch(() => setHealth("只读库还没连上"));
  }, []);

  return (
    <>
      <h1>DataAgent <small>assistant-ui</small></h1>
      <p className="kicker">{health}</p>
      <ul className="roles">
        <li>模型理解问题</li>
        <li>工具取数和计算</li>
        <li>扩展管权限、限额和审计</li>
        <li>SSE 摊开执行过程</li>
      </ul>
      <label className="user-field">
        <span>当前用户</span>
        <select value={userId} disabled={isRunning} onChange={(event) => onUserId(event.target.value)}>
          <option value="u002">李先生 · 全部地区</option>
          <option value="u001">王小姐 · 仅华东</option>
        </select>
      </label>
      <p className="kicker">线程 {threadId.slice(0, 8)} · 上下文保存在服务端，重启不丢</p>
      <div className="chips">
        <button className="chip" type="button" disabled={isRunning} onClick={onNewThread}>
          开启新对话
        </button>
      </div>
      <div className="chips">
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            className="chip"
            type="button"
            disabled={isRunning}
            onClick={() => onChip(chip.userId, chip.q)}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </>
  );
}
