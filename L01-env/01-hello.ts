import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
//     ↑ 从 SDK 里「导入」要用的两个工具，就像 JS 里 require

// 1. 加载 ~/.pi/agent/ 下的配置（models.json、auth.json）
//    await 是因为「读文件」是异步操作，得等它读完才能往下走
const modelRuntime = await ModelRuntime.create();

// 2. 拿到「配了 Key、真正能用」的模型列表
const available = await modelRuntime.getAvailable();
// 这个环境里可能还有别的 Provider 凭证。当前只用 DeepSeek。
const model =
  available.find((item) => item.provider === "deepseek" && item.id === "deepseek-flash") ??
  available.find((item) => item.provider === "deepseek");

if (!model) {
  console.error("❌ 没找到可用的 DeepSeek 模型，请检查 ~/.pi/agent/models.json");
  process.exit(1);
}

// 3. 创建 Agent 会话
//    createAgentSession() 会返回一个对象，里面有好几个字段；
//    这里用 { session } 这种「解构赋值」写法，只把 session 字段挑出来用
const { session } = await createAgentSession({ model, modelRuntime });

try {
  // 4. 订阅事件：文字增量照旧拼成一句话；其余事件只打印类型，用来看 ReAct 循环
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
      return;
    }
    const toolName = "toolName" in event ? event.toolName : undefined;
    console.log(toolName ? `📋 [${event.type}] 工具：${toolName}` : `📋 [${event.type}]`);
  });

  console.log(`🤖 使用模型：${model.provider}/${model.id}\n`);
  await session.prompt("当前目录有哪些文件？");
  console.log("\n");
} finally {
  session.dispose();   // 释放资源（关监听、断连接）。用 try/finally 包起来，保证出错也能清理
}
