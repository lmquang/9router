import { afterEach, describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function drain(input, targetFormat = FORMATS.OPENAI) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      targetFormat,
      FORMATS.OPENAI,
      targetFormat === FORMATS.ANTIGRAVITY ? "antigravity" : "openai",
      null,
      null,
      "test-model",
    ),
  );
  const reader = output.getReader();
  while (!(await reader.read()).done) { /* drain */ }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("privacy-safe stream shape logging", () => {
  it("summarizes client-visible OpenAI chunks without logging their text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "private translated text";
    const chunks = [
      { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: "hidden thought" }, finish_reason: null }] },
      { choices: [{ delta: { content: secret }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    await drain(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`);

    const summary = log.mock.calls.map(([message]) => String(message)).find((message) => message.startsWith("[STREAM_SHAPE]"));
    expect(summary).toContain("contentChunks=1");
    expect(summary).toContain(`contentChars=${secret.length}`);
    expect(summary).toContain("reasoningChunks=1");
    expect(summary).toContain("roleOnly=1");
    expect(summary).toContain("emptyDelta=1");
    expect(summary).toContain("finish=stop");
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain("hidden thought");
  });

  it("separates Antigravity provider thinking from visible output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const chunk = {
      response: {
        candidates: [{
          content: {
            parts: [
              { text: "reason", thought: true },
              { text: "answer" },
            ],
          },
          finishReason: "STOP",
        }],
      },
    };

    await drain(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, FORMATS.ANTIGRAVITY);

    const summary = log.mock.calls.map(([message]) => String(message)).find((message) => message.startsWith("[STREAM_SHAPE]"));
    expect(summary).toContain("providerContentChars=6");
    expect(summary).toContain("providerThinkingChars=6");
    expect(summary).toContain("contentChars=6");
    expect(summary).toContain("reasoningChars=6");
    expect(summary).toContain("finish=stop");
    expect(summary).not.toContain("reason");
    expect(summary).not.toContain("answer");
  });
});
