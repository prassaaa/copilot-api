import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { Model } from "../src/services/copilot/get-models"

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

function createModel(id: string): Model {
  return {
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
  }
}

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

test("falls back to lower claude-opus tier before other families", async () => {
  const previousFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch
  const calledModels: Array<string> = []
  let requestCount = 0

  const fallbackFetchMock = mock(
    (
      _url: string,
      opts: {
        body?: string
      },
    ) => {
      const requestBody = JSON.parse(opts.body ?? "{}") as { model?: string }
      calledModels.push(requestBody.model ?? "")

      if (requestCount === 0) {
        requestCount++
        return new Response(
          JSON.stringify({
            error: {
              code: "unsupported_api_for_model",
              message:
                "The /chat/completions endpoint is not supported for this model",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response(
        JSON.stringify({
          choices: [],
          id: "fallback-opus",
          model: requestBody.model,
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
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fallbackFetchMock
  state.models = {
    data: [
      createModel("claude-opus-4.6"),
      createModel("claude-opus-4.5"),
      createModel("claude-sonnet-4.5"),
    ],
    object: "list",
  }

  try {
    const result = await createChatCompletions({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-opus-4.6",
    })

    expect(calledModels).toEqual(["claude-opus-4.6", "claude-opus-4.5"])
    expect((result as { model?: string }).model).toBe("claude-opus-4.5")
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = previousFetch
  }
})

test("falls back to lower claude-sonnet tier before other families", async () => {
  const previousFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch
  const calledModels: Array<string> = []
  let requestCount = 0

  const fallbackFetchMock = mock(
    (
      _url: string,
      opts: {
        body?: string
      },
    ) => {
      const requestBody = JSON.parse(opts.body ?? "{}") as { model?: string }
      calledModels.push(requestBody.model ?? "")

      if (requestCount === 0) {
        requestCount++
        return new Response(
          JSON.stringify({
            error: {
              code: "unsupported_api_for_model",
              message:
                "The /chat/completions endpoint is not supported for this model",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response(
        JSON.stringify({
          choices: [],
          id: "fallback-sonnet",
          model: requestBody.model,
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
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fallbackFetchMock
  state.models = {
    data: [
      createModel("claude-sonnet-4.5"),
      createModel("claude-sonnet-4"),
      createModel("claude-opus-4.5"),
    ],
    object: "list",
  }

  try {
    const result = await createChatCompletions({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4.5",
    })

    expect(calledModels).toEqual(["claude-sonnet-4.5", "claude-sonnet-4"])
    expect((result as { model?: string }).model).toBe("claude-sonnet-4")
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = previousFetch
  }
})

test("sets X-Initiator to user when latest turn is user", async () => {
  const previousFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch

  const initiatorFetchMock = mock(
    (
      _url: string,
      _opts: {
        headers: Record<string, string>
      },
    ) =>
      new Response(
        JSON.stringify({
          choices: [],
          id: "initiator-check",
          object: "chat.completion",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  )

  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = initiatorFetchMock

  try {
    await createChatCompletions({
      messages: [
        { role: "assistant", content: "Previous assistant output" },
        {
          role: "tool",
          tool_call_id: "tool_1",
          content: "Previous tool output",
        },
        { role: "user", content: "Please continue from this state." },
      ],
      model: "gpt-test",
    })

    const headers = (
      initiatorFetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers["X-Initiator"]).toBe("user")
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = previousFetch
  }
})

test("normalizes tool message content to string", async () => {
  const fetchHost = globalThis as unknown as { fetch: typeof fetch }
  const previousFetch = fetchHost.fetch
  let capturedBody = ""

  const toolContentFetchMock = mock(
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
          id: "tool-content-check",
          object: "chat.completion",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    },
  )

  fetchHost.fetch = toolContentFetchMock as unknown as typeof fetch

  try {
    await createChatCompletions({
      messages: [
        { role: "user", content: "Run tool." },
        {
          role: "tool",
          tool_call_id: "tool_2",
          content: [
            { type: "text", text: "line-one" },
            { type: "text", text: "line-two" },
          ],
        },
      ],
      model: "gpt-test",
    })

    const parsed = JSON.parse(capturedBody) as ChatCompletionsPayload
    const toolMessage = parsed.messages.find(
      (message) => message.role === "tool",
    )
    expect(typeof toolMessage?.content).toBe("string")
    expect(toolMessage?.content).toBe("line-one\n\nline-two")
  } finally {
    fetchHost.fetch = previousFetch
  }
})

test("normalizes object tool message content to JSON string", async () => {
  const fetchHost = globalThis as unknown as { fetch: typeof fetch }
  const previousFetch = fetchHost.fetch
  let capturedBody = ""

  const toolObjectFetchMock = mock(
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
          id: "tool-object-check",
          object: "chat.completion",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    },
  )

  fetchHost.fetch = toolObjectFetchMock as unknown as typeof fetch

  try {
    await createChatCompletions({
      messages: [
        { role: "user", content: "Run tool." },
        {
          role: "tool",
          tool_call_id: "tool_3",
          content: {
            status: "ok",
            updated_lines: 3,
          } as unknown as ChatCompletionsPayload["messages"][number]["content"],
        },
      ],
      model: "gpt-test",
    })

    const parsed = JSON.parse(capturedBody) as ChatCompletionsPayload
    const toolMessage = parsed.messages.find(
      (message) => message.role === "tool",
    )
    expect(toolMessage?.content).toBe('{"status":"ok","updated_lines":3}')
  } finally {
    fetchHost.fetch = previousFetch
  }
})

test("uses stable copilot integration header for tool calls", async () => {
  const fetchHost = globalThis as unknown as { fetch: typeof fetch }
  const previousFetch = fetchHost.fetch
  let capturedHeaders: Record<string, string> = {}

  const headerFetchMock = mock(
    (
      _url: string,
      opts: {
        headers: Record<string, string>
      },
    ) => {
      capturedHeaders = opts.headers
      return new Response(
        JSON.stringify({
          choices: [],
          id: "header-check",
          object: "chat.completion",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    },
  )

  fetchHost.fetch = headerFetchMock as unknown as typeof fetch

  try {
    await createChatCompletions({
      messages: [{ role: "user", content: "Run tool." }],
      model: "gpt-test",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        },
      ],
    })

    expect(capturedHeaders["copilot-integration-id"]).toBe("vscode-chat")
    expect(capturedHeaders["openai-intent"]).toBe("conversation-agent")
  } finally {
    fetchHost.fetch = previousFetch
  }
})

test("retries transient upstream status before succeeding", async () => {
  const fetchHost = globalThis as unknown as { fetch: typeof fetch }
  const previousFetch = fetchHost.fetch
  let callCount = 0

  const transientFetchMock = mock(() => {
    callCount++
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          error: { message: "temporarily overloaded" },
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
          },
        },
      )
    }

    return new Response(
      JSON.stringify({
        choices: [],
        id: "retry-success",
        object: "chat.completion",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  })

  fetchHost.fetch = transientFetchMock as unknown as typeof fetch

  try {
    const result = (await createChatCompletions({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
    })) as { id?: string }

    expect(callCount).toBe(2)
    expect(result.id).toBe("retry-success")
  } finally {
    fetchHost.fetch = previousFetch
  }
})
