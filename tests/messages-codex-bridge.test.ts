import { expect, mock, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { server } from "../src/server"

function createModel(id: string, supportedEndpoints?: Array<string>): Model {
  return {
    capabilities: {
      family: "gpt",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    supported_endpoints: supportedEndpoints,
    vendor: "openai",
    version: "1",
  }
}

test("routes /v1/messages codex requests through responses API", async () => {
  const previousFetch = (globalThis as { fetch: typeof fetch }).fetch
  const previousModels = state.models
  const previousToken = state.copilotToken
  const previousVersion = state.vsCodeVersion
  const previousAccountType = state.accountType
  const previousManualApprove = state.manualApprove

  const calledPaths: Array<string> = []
  const capturedPayloads: Array<Record<string, unknown>> = []
  const fetchMock = mock((url: string, options?: { body?: string }) => {
    const path = new URL(url).pathname
    calledPaths.push(path)

    if (path === "/responses") {
      const payload = JSON.parse(options?.body ?? "{}") as {
        model?: string
        reasoning?: { effort?: string; summary?: string }
        include?: Array<string>
        temperature?: number
        store?: boolean
        parallel_tool_calls?: boolean
      }
      capturedPayloads.push(payload)
      expect(payload.model).toBe("gpt-5.3-codex")
      expect(payload.reasoning).toEqual({
        effort: "xhigh",
        summary: "detailed",
      })
      expect(payload.include).toEqual(["reasoning.encrypted_content"])
      expect(payload.temperature).toBe(1)
      expect(payload.store).toBe(false)
      expect(payload.parallel_tool_calls).toBe(true)

      return new Response(
        JSON.stringify({
          id: "resp_123",
          object: "response",
          created_at: 1_770_000_000,
          model: "gpt-5.3-codex",
          output: [
            {
              id: "msg_123",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Halo dari bridge",
                  annotations: [],
                },
              ],
            },
          ],
          output_text: "Halo dari bridge",
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          parallel_tool_calls: false,
          temperature: null,
          tool_choice: "auto",
          tools: [],
          top_p: null,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }

    // Handle /chat/completions for quota optimizer small model requests
    if (path === "/chat/completions") {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1_770_000_000,
          model: "gpt-5-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }

    return new Response(
      JSON.stringify({
        error: {
          code: "unexpected_endpoint",
          message: `Unexpected endpoint: ${path}`,
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    )
  })

  // @ts-expect-error - test fetch mock doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

  state.copilotToken = "test-copilot-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      createModel("gpt-5.3-codex", ["/responses"]),
      createModel("gpt-5.1", ["/chat/completions"]),
      createModel("gpt-5-mini", ["/chat/completions"]),
    ],
  }

  try {
    const response = await server.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hai" }],
        // Add tools to prevent quota optimizer from switching to small model
        tools: [
          {
            name: "test_tool",
            description: "test",
            input_schema: { type: "object" },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      model?: string
      content?: Array<{ type: string; text?: string }>
    }
    expect(body.model).toBe("gpt-5.3-codex")
    expect(body.content?.[0]).toEqual({
      type: "text",
      text: "Halo dari bridge",
    })
    expect(calledPaths).toEqual(["/responses"])
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = previousFetch
    Object.assign(state, {
      models: previousModels,
      copilotToken: previousToken,
      vsCodeVersion: previousVersion,
      accountType: previousAccountType,
      manualApprove: previousManualApprove,
    })
  }
})

test("routes /v1/messages codex requests through responses API when model metadata lacks endpoint", async () => {
  const previousFetch = (globalThis as { fetch: typeof fetch }).fetch
  const previousModels = state.models
  const previousToken = state.copilotToken
  const previousVersion = state.vsCodeVersion
  const previousAccountType = state.accountType
  const previousManualApprove = state.manualApprove

  const calledPaths: Array<string> = []
  const fetchMock = mock((url: string) => {
    const path = new URL(url).pathname
    calledPaths.push(path)

    // Handle /chat/completions for quota optimizer small model requests
    if (path === "/chat/completions") {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1_770_000_000,
          model: "gpt-5-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }

    if (path !== "/responses") {
      return new Response(
        JSON.stringify({
          error: {
            code: "unexpected_endpoint",
            message: `Unexpected endpoint: ${path}`,
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
        id: "resp_456",
        object: "response",
        created_at: 1_770_000_111,
        model: "gpt-5.3-codex",
        output: [
          {
            id: "msg_456",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Bridge fallback metadata",
                annotations: [],
              },
            ],
          },
        ],
        output_text: "Bridge fallback metadata",
        status: "completed",
        usage: {
          input_tokens: 8,
          output_tokens: 6,
          total_tokens: 14,
        },
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  })

  // @ts-expect-error - test fetch mock doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

  state.copilotToken = "test-copilot-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      createModel("gpt-5.3-codex", ["/chat/completions"]),
      createModel("gpt-5-mini", ["/chat/completions"]),
    ],
  }

  try {
    const response = await server.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hai lagi" }],
        // Add tools to prevent quota optimizer from switching to small model
        tools: [
          {
            name: "test_tool",
            description: "test",
            input_schema: { type: "object" },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      model?: string
    }
    expect(body.model).toBe("gpt-5.3-codex")
    expect(calledPaths).toEqual(["/responses"])
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = previousFetch
    Object.assign(state, {
      models: previousModels,
      copilotToken: previousToken,
      vsCodeVersion: previousVersion,
      accountType: previousAccountType,
      manualApprove: previousManualApprove,
    })
  }
})
