import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function mockProvider(pi) {
  pi.registerProvider("router-smoke", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "local-test-only",
    api: "router-smoke-api",
    models: ["classifier", "simple", "medium", "complex", "reasoning"].map((id) => ({
      id, name: id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], contextWindow: 128000,
      maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = context.messages.filter((message) => message.role === "user").at(-1);
        const text = typeof last.content === "string" ? last.content : last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        let output;
        if (model.id === "classifier") {
          const input = JSON.parse(text);
          if (!context.messages.some((message) => message.role === "system")) throw new Error("Classifier system prompt missing");
          output = JSON.stringify({ category: input.currentPrompt });
        } else {
          output = `${model.provider}/${model.id}:${options?.reasoning ?? "off"}`;
        }
        const message = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: output }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  });
}
