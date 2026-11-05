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

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  // 换基础人设：返回什么，人设就是什么（忽略 base，彻底替换）
  systemPromptOverride: () => `你是一个企业数据分析助手，帮业务方分析销售数据、定位问题、给出建议。
回答前先确认已知信息和未知信息，不要编造数据。`,
  // 清空追加规则，不带入 APPEND_SYSTEM.md
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
  console.log("💬 问：上月销售额下降了 15%，可能的原因有哪些？\n");
  await session.prompt("上月销售额下降了 15%，可能的原因有哪些？");
  console.log("\n");
} finally {
  session.dispose();
}
