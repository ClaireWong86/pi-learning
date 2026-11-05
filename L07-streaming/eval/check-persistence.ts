import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 持久化冒烟：问第 1 轮 → 杀进程 → 同会话目录重启 → 同 threadId 追问。
// 第 2 轮是省略式追问（只换地区），只有从磁盘恢复了第 1 轮上下文才能答对。
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.CHECK_PORT ?? 4319);
const sessionDir = mkdtempSync(join(tmpdir(), "sales-sessions-"));
const threadId = randomUUID();

function startServer(): ChildProcess {
  const tsx = join(root, "node_modules", ".bin", "tsx");
  const child = spawn(tsx, ["L07-streaming/07a-sse-server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SALES_SESSION_DIR: sessionDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitHealth(up: boolean) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok === up) return;
    } catch {
      if (!up) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(up ? "服务没有起来" : "服务没有停掉");
}

async function stopServer(child: ChildProcess) {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await waitHealth(false);
}

async function ask(message: string, userId = "u002") {
  const response = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, userId, threadId }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`chat ${response.status}: ${await response.text()}`);
  const raw = await response.text();
  const events: Array<Record<string, unknown>> = [];
  for (const part of raw.split("\n\n")) {
    const line = part.split("\n").find((item) => item.startsWith("data: "));
    if (line) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
  }
  const answer = events.filter((event) => event.type === "text").map((event) => String(event.delta ?? "")).join("");
  const trace = events.find((event) => event.type === "trace_end") ?? {};
  return { answer, trace };
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

let server = startServer();
try {
  await waitHealth(true);
  const first = await ask("2026年1月华东地区的总销售额是多少？");
  check("第 1 轮答对华东 210000", first.answer.includes("210000") || first.answer.includes("21.00"), first.answer.slice(0, 120));
  check("第 1 轮新建线程（未恢复）", first.trace.threadId === threadId && first.trace.resumed === false, JSON.stringify(first.trace.threadId));

  await stopServer(server);
  console.log(`\n--- 服务已杀，重启（会话目录 ${sessionDir}）---\n`);
  server = startServer();
  await waitHealth(true);

  const second = await ask("那华南呢？");
  check("重启后追问答对华南 110000", second.answer.includes("110000") || second.answer.includes("11.00"), second.answer.slice(0, 120));
  check("第 2 轮从磁盘恢复", second.trace.threadId === threadId && second.trace.resumed === true, `resumed=${String(second.trace.resumed)}`);

  const threads = await (await fetch(`http://127.0.0.1:${port}/api/threads?userId=u002`)).json() as { threads: Array<{ threadId: string; turns: number }> };
  check("线程列表能看到本线程且记了 2 轮", threads.threads.some((item) => item.threadId === threadId && item.turns === 2), JSON.stringify(threads.threads));

  const history = await fetch(`http://127.0.0.1:${port}/api/threads/${threadId}/history?userId=u002`);
  const historyBody = (await history.json()) as { messages: Array<{ role: string; text: string }> };
  check("历史接口能读回两轮问答", history.ok && historyBody.messages.some((item) => item.text.includes("华南")), `${historyBody.messages?.length ?? 0} 条`);

  const stolen = await fetch(`http://127.0.0.1:${port}/api/threads/${threadId}/history?userId=u001`);
  check("其他用户读不到本线程历史", stolen.status === 403, `HTTP ${stolen.status}`);
} finally {
  await stopServer(server).catch(() => {});
  rmSync(sessionDir, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\n持久化冒烟全部通过" : `\n失败 ${failures.length} 项`);
if (failures.length) process.exit(1);
