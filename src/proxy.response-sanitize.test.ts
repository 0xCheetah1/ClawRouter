import { describe, expect, it } from "vitest";

import { sanitizeOpenAIResponsePayload } from "./proxy.js";

describe("sanitizeOpenAIResponsePayload", () => {
  it("removes structured reasoning fields from message and delta containers", () => {
    const payload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Final answer",
            reasoning_content: "private chain of thought",
            thinking: "private thinking",
          },
        },
        {
          delta: {
            content: "Hello",
            reasoning: "streamed private reasoning",
            reasoning_details: [{ text: "detail" }],
          },
        },
      ],
    };

    const changed = sanitizeOpenAIResponsePayload(payload);

    expect(changed).toBe(true);
    expect(payload.choices[0].message?.content).toBe("Final answer");
    expect(payload.choices[0].message).not.toHaveProperty("reasoning_content");
    expect(payload.choices[0].message).not.toHaveProperty("thinking");
    expect(payload.choices[1].delta?.content).toBe("Hello");
    expect(payload.choices[1].delta).not.toHaveProperty("reasoning");
    expect(payload.choices[1].delta).not.toHaveProperty("reasoning_details");
  });

  it("removes structured reasoning content parts", () => {
    const payload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "private chain of thought" },
              { type: "text", text: "Final answer" },
              { type: "thinking", thinking: "private thinking" },
            ],
          },
        },
      ],
    };

    const changed = sanitizeOpenAIResponsePayload(payload);

    expect(changed).toBe(true);
    expect(payload.choices[0].message?.content).toEqual([{ type: "text", text: "Final answer" }]);
  });

  it("strips tagged thinking blocks from content", () => {
    const payload = {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "<｜begin▁of▁thinking｜>Let me think...<｜end▁of▁thinking｜>The answer is 42.",
          },
        },
        {
          delta: {
            content: "Hello <think>internal reasoning</think> world",
          },
        },
      ],
    };

    const changed = sanitizeOpenAIResponsePayload(payload);

    expect(changed).toBe(true);
    expect(payload.choices[0].message?.content).toBe("The answer is 42.");
    expect(payload.choices[1].delta?.content).toBe("Hello  world");
  });

  it("returns false when nothing needs sanitizing", () => {
    const payload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Clean answer",
          },
        },
      ],
    };

    expect(sanitizeOpenAIResponsePayload(payload)).toBe(false);
  });
});
