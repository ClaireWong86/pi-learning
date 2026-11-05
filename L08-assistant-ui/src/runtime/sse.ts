export type SseEvent = Record<string, unknown> & { type: string };

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) throw new Error("响应没有正文");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        yield JSON.parse(line.slice(6)) as SseEvent;
      }
    }
  }
}
