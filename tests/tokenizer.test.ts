import { expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { Model } from "../src/services/copilot/get-models"

import { getTokenCount } from "../src/lib/tokenizer"

test("getTokenCount tolerates message with undefined tool_calls property", async () => {
  const payload = {
    model: "gpt-test",
    messages: [
      {
        role: "assistant",
        content: "ok",
        tool_calls: undefined,
      },
    ],
  } as unknown as ChatCompletionsPayload

  const model: Model = {
    capabilities: {
      family: "gpt-test",
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      type: "chat",
    },
    id: "gpt-test",
    model_picker_enabled: true,
    name: "gpt-test",
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
  }

  const tokenCount = await getTokenCount(payload, model)
  expect(tokenCount.input).toBeGreaterThan(0)
})
