import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
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

// 第 5 章那种业务工具。这里用假数据，重点不在查询，而在执行前能不能被拦住。
const queryDataTool = defineTool({
  name: "query_data",
  label: "查询销售数据",
  description: "查询销售数据。用户指定 limit 时必须原样传入，不要自行改小。导出全部时 limit 传 9999。",
  parameters: Type.Object({
    limit: Type.Number({ description: "最多返回行数" }),
    region: Type.Optional(Type.String({ description: "地区，可省略" })),
  }),
  async execute(_id, params) {
    console.log(`⚙️  query_data 真的执行了，limit=${params.limit}`);
    const shown = Math.min(params.limit, 3);
    const rows = Array.from({ length: shown }, (_, i) => `第 ${i + 1} 行：华东，销售额 ${12000 + i * 100}`);
    return {
      content: [{ type: "text", text: `演示数据 ${shown} 行（请求 ${params.limit} 行）\n${rows.join("\n")}` }],
      details: { limit: params.limit },
    };
  },
});

// 5.1 安全门：工具执行前。return { block: true } 会让框架停掉这次调用。
function limitGuardExtension(pi: ExtensionAPI) {
  const MAX_LIMIT = 100;
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "query_data") return;
    const limit = typeof event.input.limit === "number" ? event.input.limit : undefined;
    console.log(`🚧 [tool_call] query_data limit=${limit ?? "未传"}`);
    if (limit !== undefined && limit > MAX_LIMIT) {
      console.log("🚧 拦住了：工具函数不会被调用");
      return {
        block: true,
        reason: `单次最多返回 ${MAX_LIMIT} 行，你请求了 ${limit} 行。请把 limit 改成不超过 ${MAX_LIMIT} 后重试。`,
      };
    }
  });
}

// 5.2 审计：tool_execution_start / end 包住整个调用。
// 在 v0.83 里，start 发在 tool_call 之前；拦住之后 execute 不会跑，
// 但 end 仍会到，并且 isError 为 true。所以审计要看成功还是失败，不能只看 start 有没有出现。
function auditExtension(pi: ExtensionAPI) {
  const startTimes = new Map<string, number>();
  pi.on("tool_execution_start", (event) => {
    startTimes.set(event.toolCallId, Date.now());
    console.log(`📝 [审计] 开始 ${event.toolName}，参数：${JSON.stringify(event.args)}`);
  });
  pi.on("tool_execution_end", (event) => {
    const start = startTimes.get(event.toolCallId) ?? Date.now();
    startTimes.delete(event.toolCallId);
    const cost = Date.now() - start;
    console.log(`📝 [审计] ${event.toolName} 完成，耗时 ${cost}ms，${event.isError ? "失败" : "成功"}`);
  });
}

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  extensionFactories: [limitGuardExtension, auditExtension],
  systemPromptOverride: () =>
    "你是销售数据助手。查数据只能调用 query_data。limit 按用户给的数字原样传入，不要自行改小。",
  appendSystemPromptOverride: () => [],
});
await loader.reload();

const { session } = await createAgentSession({
  model,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  customTools: [queryDataTool],
  tools: ["query_data"],
});

try {
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log(`🤖 使用模型：${model.provider}/${model.id}\n`);

  console.log("--- 第 1 问：limit=9999，期望拦住 execute；审计仍会记一笔失败 ---\n");
  await session.prompt("调用 query_data 导出全部销售记录，limit 必须传 9999，不要改小。");
  console.log("\n");

  console.log("--- 第 2 问：limit=20，期望放行，审计记下耗时 ---\n");
  await session.prompt("再查一次，limit 传 20。");
  console.log("\n");
} finally {
  session.dispose();
}
