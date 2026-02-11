import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (
    _url: string,
    opts: {
      headers: Record<string, string>
      body?: string
    },
  ) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
      body: opts.body,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("normalizes non-standard content part types", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "https://example.com/image.png" },
          { type: "thinking", thinking: "internal thought" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AAAA",
            },
          },
        ] as unknown as ChatCompletionsPayload["messages"][number]["content"],
      },
    ],
    model: "gpt-test",
  }

  await createChatCompletions(payload)

  const body = (fetchMock.mock.calls[2][1] as { body?: string }).body
  const parsed = JSON.parse(body as string) as ChatCompletionsPayload

  expect(parsed.messages[0]?.content).toEqual([
    { type: "text", text: "hello" },
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
    { type: "text", text: "internal thought" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ])
})

test("falls back to string content for fully unsupported parts", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_123",
            content: "result",
          },
        ] as unknown as ChatCompletionsPayload["messages"][number]["content"],
      },
    ],
    model: "gpt-test",
  }

  await createChatCompletions(payload)

  const body = (fetchMock.mock.calls[3][1] as { body?: string }).body
  const parsed = JSON.parse(body as string) as ChatCompletionsPayload

  expect(parsed.messages[0]?.content).toBe(
    JSON.stringify([
      {
        type: "tool_result",
        tool_use_id: "tool_123",
        content: "result",
      },
    ]),
  )
})
