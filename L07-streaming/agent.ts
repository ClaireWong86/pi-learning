import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { auditExtension, limitGuardExtension, permissionGuardExtension, stepGuardExtension, userMemoryExtension } from "./extensions.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { queryDataTool } from "./query-data.ts";

function registerQueryTool(pi: ExtensionAPI) {
  pi.registerTool(queryDataTool);
}

export async function bootSalesAgent() {
  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable();
  const model =
    available.find((item) => item.provider === "deepseek" && item.id === "deepseek-flash") ??
    available.find((item) => item.provider === "deepseek");
  if (!model) throw new Error("没有可用的 DeepSeek 模型，请检查 ~/.pi/agent/models.json");

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      { name: "query-data", factory: registerQueryTool },
      { name: "step-guard", factory: stepGuardExtension },
      { name: "limit-guard", factory: limitGuardExtension },
      { name: "permission-guard", factory: permissionGuardExtension },
      { name: "audit-log", factory: auditExtension },
      { name: "user-memory", factory: userMemoryExtension },
    ],
  });
  await loader.reload();
  return { model, modelRuntime, loader };
}

export async function openSalesSession(
  boot: Awaited<ReturnType<typeof bootSalesAgent>>,
  sessionManager: SessionManager = SessionManager.inMemory(),
) {
  const { session } = await createAgentSession({
    model: boot.model,
    modelRuntime: boot.modelRuntime,
    resourceLoader: boot.loader,
    sessionManager,
    tools: ["query_data"],
  });
  return session;
}
