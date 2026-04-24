import { describe, expect, it } from "vitest";

import { sanitizeOpenAIResponsePayload } from "./proxy.js";

describe("sanitizeOpenAIResponsePayload", () => {
  it("removes reasoning_content from message and delta containers", () => {
    const payload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Final answer",
            reasoning_content: "private chain of thought",
          },
        },
        {
          delta: {
            content: "Hello",
            reasoning_content: "streamed private chain of thought",
          },
        },
      ],
    };

    const changed = sanitizeOpenAIResponsePayload(payload);

    expect(changed).toBe(true);
    expect(payload.choices[0].message?.content).toBe("Final answer");
    expect(payload.choices[0].message).not.toHaveProperty("reasoning_content");
    expect(payload.choices[1].delta?.content).toBe("Hello");
    expect(payload.choices[1].delta).not.toHaveProperty("reasoning_content");
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

  it("strips leaked K2.6 internal monologue prelude and keeps the final reply", () => {
    const payload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: `The user said "hey man". The bootstrap is still pending. I need to check what state we're in.

We have:

• IDENTITY.md updated
• USER.md updated

BOOTSTRAP.md says:

1. Figure out name
2. Update files

Let me delete BOOTSTRAP.md and then respond casually.

Hey. All dialed in now — name, vibe, the works. What's up?`,
          },
        },
      ],
    };

    const changed = sanitizeOpenAIResponsePayload(payload, "moonshot/kimi-k2.6");

    expect(changed).toBe(true);
    expect(payload.choices[0].message?.content).toBe(
      "Hey. All dialed in now — name, vibe, the works. What's up?",
    );
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
