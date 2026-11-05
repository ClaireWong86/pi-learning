import { readFile } from "fs/promises";
import { join } from "path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
const model =
  available.find((item) => item.provider === "deepseek" && item.id === "deepseek-flash") ??
  available.find((item) => item.provider === "deepseek");
if (!model) throw new Error("没有可用的 DeepSeek 模型，请检查 ~/.pi/agent/models.json");

// 静态部分：启动时一次性读到内存（改文件后要重新运行才生效）
const promptsDir = join(process.cwd(), "prompts", "analyst");
const [persona, rules, outputFormat] = await Promise.all([
  readFile(join(promptsDir, "persona.md"), "utf-8"),
  readFile(join(promptsDir, "rules.md"), "utf-8"),
  readFile(join(promptsDir, "output-format.md"), "utf-8"),
]);

// 动态部分：每次请求按 userId 取用户上下文。这里用内存里的假数据代替数据库。
async function getUserContext(userId: string) {
  const users: Record<string, { name: string; department: string; role: string; dataScope: string }> = {
    u001: { name: "王小姐", department: "销售部", role: "销售经理", dataScope: "本部门销售数据" },
    u002: { name: "李先生", department: "财务部", role: "财务分析师", dataScope: "全公司财务数据" },
  };
  return users[userId] ?? { name: "未知用户", department: "未知", role: "访客", dataScope: "无" };
}

const userId = "u001";
const userContext = await getUserContext(userId);

const fullPrompt = [
  persona,
  `## 当前用户上下文
姓名：${userContext.name}
部门：${userContext.department}
角色：${userContext.role}
数据权限范围：${userContext.dataScope}
（回答时只涉及该用户有权访问的数据范围）`,
  rules,
  outputFormat,
].join("\n\n");

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  systemPromptOverride: () => fullPrompt,
  appendSystemPromptOverride: () => [],
});
await loader.reload();

const { session } = await createAgentSession({
  model,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

try {
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log(`🤖 使用模型：${model.provider}/${model.id}\n`);
  console.log(`💬 用户 ${userContext.name}（${userContext.department}）问：上月销售额下降 15%，可能的原因有哪些？\n`);
  await session.prompt("上月销售额下降了 15%，可能的原因有哪些？");
  console.log("\n");
} finally {
  session.dispose();
}
