import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
const model =
  available.find((item) => item.provider === "deepseek" && item.id === "deepseek-flash") ??
  available.find((item) => item.provider === "deepseek");

if (!model) {
  console.error("❌ 没找到可用的 DeepSeek 模型，请检查 ~/.pi/agent/models.json");
  process.exit(1);
}

const { session } = await createAgentSession({ model, modelRuntime });

// ===== 和第 4 步一样的订阅，但加了一堆计数，用来「看见」它 =====
const stats = {
  textDelta: 0,        // 收到几段文字增量
  chars: 0,            // 累计字符数
  totalEvents: 0,      // 收到的事件总数
  others: {} as Record<string, number>,
};
const gaps: number[] = [];   // 每两段之间隔了多久
let firstAt = 0;
let lastAt = 0;

session.subscribe((event) => {
  stats.totalEvents++;

  if (event.type === "message_update") {
    const sub = event.assistantMessageEvent;

    if (sub.type === "text_delta") {
      stats.textDelta++;
      stats.chars += sub.delta.length;

      const now = performance.now();
      if (firstAt === 0) firstAt = now;
      if (lastAt) gaps.push(now - lastAt);
      lastAt = now;

      process.stdout.write(sub.delta);
    } else {
      const k = `message_update/${sub.type}`;
      stats.others[k] = (stats.others[k] ?? 0) + 1;
    }
  } else {
    stats.others[event.type] = (stats.others[event.type] ?? 0) + 1;
  }
});

console.log(`🤖 模型：${model.provider}/${model.id}\n`);
const t0 = performance.now();
await session.prompt("用一句话介绍你自己。");
const t1 = performance.now();

console.log("\n\n===== 第 4 步验证报告 =====");
console.log(`text_delta 事件数 : ${stats.textDelta}   <- >1 说明真·流式；=1 说明一次性返回`);
console.log(`累计字符数        : ${stats.chars}`);
console.log(`事件总数          : ${stats.totalEvents}`);
console.log(`首字延迟(TTFT)    : ${(firstAt - t0).toFixed(0)} ms   <- 第一段到达用了多久`);
console.log(`流式持续时长      : ${(lastAt - firstAt).toFixed(0)} ms`);
console.log(`总耗时            : ${(t1 - t0).toFixed(0)} ms`);
if (gaps.length) {
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(`chunk 间隔        : 平均 ${avg.toFixed(0)} ms / 最大 ${Math.max(...gaps).toFixed(0)} ms`);
}
console.log(`其它事件类型      :`, stats.others);

session.dispose();
