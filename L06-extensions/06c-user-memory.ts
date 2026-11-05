import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
const model =
  available.find((item) => item.provider === "deepseek" && item.id === "deepseek-flash") ??
  available.find((item) => item.provider === "deepseek");
if (!model) throw new Error("没有可用的 DeepSeek 模型，请检查 ~/.pi/agent/models.json");

// 5.3 每次发给 LLM 之前，把用户偏好插进消息列表。
// 人设用第 4 章的 systemPromptOverride（启动时算一次）；
// 会变的偏好用 context（每一轮 LLM 调用都触发）。
function userMemoryExtension(pi: ExtensionAPI) {
  const userPrefs = { unit: "万元", language: "zh-CN" };

  pi.on("context", async (event) => {
    const memoryText = `[系统注入的用户偏好，非用户输入]
- 数据单位统一用 ${userPrefs.unit}
- 回答语言：${userPrefs.language}
回答时请遵循以上偏好。`;

    console.log(`🧠 [context] 发请求前有 ${event.messages.length} 条消息，头部插入偏好`);
    return {
      messages: [{ role: "user", content: memoryText, timestamp: Date.now() }, ...event.messages],
    };
  });
}

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  extensionFactories: [userMemoryExtension],
  // 人设里故意不提「万元」，这样回答里出现万元，就只能来自 context 注入。
  systemPromptOverride: () => "你是销售数据助手。按收到的偏好回答，用一句话。",
  appendSystemPromptOverride: () => [],
});
await loader.reload();

const { session } = await createAgentSession({
  model,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  tools: [],
});

try {
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log(`🤖 使用模型：${model.provider}/${model.id}\n`);
  console.log("💬 问：上月销售额 150000 元，用一句话汇报。\n");
  await session.prompt("上月销售额 150000 元，用一句话向销售经理汇报这个数字。");
  console.log("\n");
} finally {
  session.dispose();
}
