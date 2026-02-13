import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"

import {
  denormalizeRequestToolCallIds,
  normalizeResponseToolCallIds,
} from "../src/routes/chat-completions/tool-call-ids"

describe("tool_call_id normalization", () => {
  test("preserves native call_* IDs without reverse mapping", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_native_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Jakarta"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_native_123",
          content: '{"ok":true}',
        },
      ],
    }

    const denormalized = denormalizeRequestToolCallIds(payload)
    const assistantToolId = denormalized.messages[0]?.tool_calls?.[0]?.id
    const toolMessageId =
      denormalized.messages[1]?.role === "tool" ?
        denormalized.messages[1].tool_call_id
      : undefined

    expect(assistantToolId).toBe("call_native_123")
    expect(toolMessageId).toBe("call_native_123")
  })

  test("restores original IDs when normalized mapping exists", () => {
    const originalId = "tool.id/with-special@chars"
    const response: ChatCompletionResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: originalId,
                type: "function",
                function: {
                  name: "run_tool",
                  arguments: "{}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    }

    const normalizedResponse = normalizeResponseToolCallIds(response)
    const normalizedId =
      normalizedResponse.choices[0]?.message.tool_calls?.[0]?.id
    expect(normalizedId).toBeDefined()
    expect(normalizedId).not.toBe(originalId)

    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: normalizedId as string,
              type: "function",
              function: {
                name: "run_tool",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: normalizedId as string,
          content: '{"ok":true}',
        },
      ],
    }

    const denormalized = denormalizeRequestToolCallIds(payload)
    const assistantToolId = denormalized.messages[0]?.tool_calls?.[0]?.id
    const toolMessageId =
      denormalized.messages[1]?.role === "tool" ?
        denormalized.messages[1].tool_call_id
      : undefined

    expect(assistantToolId).toBe(originalId)
    expect(toolMessageId).toBe(originalId)
  })
})
