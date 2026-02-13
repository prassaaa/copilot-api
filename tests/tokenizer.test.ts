import { expect, test } from "bun:test"

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
  } as const

  const model = {
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
  } as const

  const tokenCount = await getTokenCount(
    payload as Parameters<typeof getTokenCount>[0],
    model as Parameters<typeof getTokenCount>[1],
  )
  expect(tokenCount.input).toBeGreaterThan(0)
})
