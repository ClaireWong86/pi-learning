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

// subscribe 听得到的事件记在这里，用来和 pi.on 对照。
const subscribeTypes = new Set<string>();
let textDeltas = 0;

// 扩展：框架启动时调用，把遥控器 pi 传进来。决策点只有这里听得见。
function seeAllEvents(pi: ExtensionAPI) {
  const line = (type: string, extra = "") => {
    console.log(`🪝 [on] ${type}${extra}`);
  };

  pi.on("input", (event) => line(event.type, `  text=${JSON.stringify(event.text)}`));
  pi.on("before_agent_start", (event) => line(event.type));
  pi.on("agent_start", (event) => line(event.type));
  pi.on("turn_start", (event) => line(event.type, `  #${event.turnIndex}`));
  pi.on("context", (event) => line(event.type, `  messages=${event.messages.length}`));
  pi.on("before_provider_request", (event) => line(event.type));
  pi.on("after_provider_response", (event) => line(event.type, `  status=${event.status}`));
  pi.on("message_start", (event) => line(event.type, `  role=${event.message.role}`));
  pi.on("message_update", () => {
    textDeltas++;
    if (textDeltas === 1) line("message_update", "  （后续文字增量折叠，不逐条打印）");
  });
  pi.on("message_end", (event) => line(event.type, `  role=${event.message.role}`));
  pi.on("tool_call", (event) => line(event.type, `  tool=${event.toolName}`));
  pi.on("tool_execution_start", (event) => line(event.type, `  tool=${event.toolName}`));
  pi.on("tool_execution_end", (event) => line(event.type, `  tool=${event.toolName}  error=${event.isError}`));
  pi.on("tool_result", (event) => line(event.type, `  tool=${event.toolName}`));
  pi.on("turn_end", (event) => line(event.type, `  #${event.turnIndex}`));
  pi.on("agent_end", (event) => line(event.type));
  pi.on("agent_settled", (event) => line(event.type));
}

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  extensionFactories: [seeAllEvents],
  systemPromptOverride: () =>
    "你是文件助手。用户问目录内容时，调用 ls 看一眼，然后用一句话回答。不要修改任何文件。",
  appendSystemPromptOverride: () => [],
});
await loader.reload();

const { session } = await createAgentSession({
  model,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  tools: ["ls"],
});

try {
  // 外部宿主只能 subscribe：能看流式文字，听不到 tool_call / context 这些决策点。
  session.subscribe((event) => {
    subscribeTypes.add(event.type);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log(`🤖 使用模型：${model.provider}/${model.id}\n`);
  console.log("💬 问：当前目录有哪些文件？\n");
  await session.prompt("当前目录有哪些文件？用一句话回答。");
  console.log("\n");

  const decisionOnly = [
    "input",
    "before_agent_start",
    "context",
    "before_provider_request",
    "after_provider_response",
    "tool_call",
    "tool_result",
  ];
  console.log("===== subscribe 漏听了哪些决策点 =====");
  for (const name of decisionOnly) {
    const heard = subscribeTypes.has(name);
    console.log(`${heard ? "听到了" : "没听到"}  ${name}`);
  }
  console.log(`\nsubscribe 实际收到的类型：${[...subscribeTypes].join(", ") || "（无）"}`);
  console.log(`message_update 文字增量：${textDeltas} 次`);
} finally {
  session.dispose();
}
