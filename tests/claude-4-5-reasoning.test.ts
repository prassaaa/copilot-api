import { describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { state } from "../src/lib/state"
import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

async function captureUpstreamPayload(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionsPayload> {
  const previousFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch
  let capturedBody = ""

  const fetchMock = mock(
    (
      _url: string,
      opts: {
        body?: string
      },
    ) => {
      capturedBody = opts.body ?? ""

      return new Response(
        JSON.stringify({
          choices: [],
          id: "claude-4-5-reasoning",
          object: "chat.completion",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    },
  )

  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

  try {
    await createChatCompletions(payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    return JSON.parse(capturedBody) as ChatCompletionsPayload
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = previousFetch
  }
}

describe("Claude 4.5 reasoning defaults", () => {
  test("auto-applies high reasoning to claude-sonnet-4.5", async () => {
    const upstreamPayload = await captureUpstreamPayload({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4.5",
      max_tokens: 4096,
    })

    expect(upstreamPayload.model).toBe("claude-sonnet-4.5")
    expect(upstreamPayload.reasoning_effort).toBe("high")
    expect(upstreamPayload.thinking).toEqual({
      type: "enabled",
      effort: "high",
    })
  })

  test("auto-applies high reasoning to claude-opus-4.5", async () => {
    const upstreamPayload = await captureUpstreamPayload({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-opus-4.5",
      max_tokens: 4096,
    })

    expect(upstreamPayload.model).toBe("claude-opus-4.5")
    expect(upstreamPayload.reasoning_effort).toBe("high")
    expect(upstreamPayload.thinking).toEqual({
      type: "enabled",
      effort: "high",
    })
  })

  test("leaves plain claude-sonnet-4.6 unchanged", async () => {
    const upstreamPayload = await captureUpstreamPayload({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4.6",
      max_tokens: 4096,
    })

    expect(upstreamPayload.model).toBe("claude-sonnet-4.6")
    expect(upstreamPayload.reasoning_effort).toBeUndefined()
    expect(upstreamPayload.thinking).toBeUndefined()
  })

  test("maps claude-sonnet-4.5(xhigh) to supported high thinking", async () => {
    const upstreamPayload = await captureUpstreamPayload({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4.5(xhigh)",
      max_tokens: 4096,
    })

    expect(upstreamPayload.model).toBe("claude-sonnet-4.5")
    expect(upstreamPayload.reasoning_effort).toBe("high")
    expect(upstreamPayload.thinking).toEqual({
      type: "enabled",
      effort: "high",
    })
  })

  test("messages translation keeps dated claude-sonnet-4.5 on the 4.5 path", async () => {
    const translatedPayload = translateToOpenAI({
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    } as AnthropicMessagesPayload)

    expect(translatedPayload.model).toBe("claude-sonnet-4.5")

    const upstreamPayload = await captureUpstreamPayload(translatedPayload)
    expect(upstreamPayload.model).toBe("claude-sonnet-4.5")
    expect(upstreamPayload.reasoning_effort).toBe("high")
    expect(upstreamPayload.thinking).toEqual({
      type: "enabled",
      effort: "high",
    })
  })
})
