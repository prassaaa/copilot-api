import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"

import {
  denormalizeRequestToolCallIds,
  normalizeToolCallId,
  normalizeResponseToolCallIds,
} from "../src/routes/chat-completions/tool-call-ids"

describe("tool_call_id normalization roundtrip", () => {
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

  test("restores original IDs from deterministic encoded id", () => {
    const originalId = "tool.id/legacy-123"
    const encodedId = normalizeToolCallId(originalId)

    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: encodedId,
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
          tool_call_id: encodedId,
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

describe("tool_call_id normalization relinking", () => {
  test("relinks contiguous tool results when legacy ids no longer match", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool_use_new_1",
              type: "function",
              function: {
                name: "run_tool_1",
                arguments: "{}",
              },
            },
            {
              id: "tool_use_new_2",
              type: "function",
              function: {
                name: "run_tool_2",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_legacy_a",
          content: '{"ok":true}',
        },
        {
          role: "tool",
          tool_call_id: "call_legacy_b",
          content: '{"ok":true}',
        },
      ],
    }

    const denormalized = denormalizeRequestToolCallIds(payload)

    expect(denormalized.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "tool_use_new_1",
    })
    expect(denormalized.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "tool_use_new_2",
    })
  })

  test("relinks partial mismatch while preserving already matching tool id", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool_use_new_1",
              type: "function",
              function: {
                name: "run_tool_1",
                arguments: "{}",
              },
            },
            {
              id: "tool_use_new_2",
              type: "function",
              function: {
                name: "run_tool_2",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_legacy_a",
          content: '{"ok":true}',
        },
        {
          role: "tool",
          tool_call_id: "tool_use_new_2",
          content: '{"ok":true}',
        },
      ],
    }

    const denormalized = denormalizeRequestToolCallIds(payload)

    expect(denormalized.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "tool_use_new_1",
    })
    expect(denormalized.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "tool_use_new_2",
    })
  })

  test("drops extra contiguous tool results without matching tool_call", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool_use_new_1",
              type: "function",
              function: {
                name: "run_tool_1",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_legacy_a",
          content: '{"ok":true}',
        },
        {
          role: "tool",
          tool_call_id: "call_legacy_b",
          content: '{"ok":true}',
        },
      ],
    }

    const denormalized = denormalizeRequestToolCallIds(payload)

    expect(denormalized.messages).toHaveLength(2)
    expect(denormalized.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "tool_use_new_1",
    })
  })

  test("trims assistant tool_calls when fewer tool results are available", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool_use_new_1",
              type: "function",
              function: {
                name: "run_tool_1",
                arguments: "{}",
              },
            },
            {
              id: "tool_use_new_2",
              type: "function",
              function: {
                name: "run_tool_2",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_legacy_a",
          content: '{"ok":true}',
        },
      ],
    }

    const denormalized = denormalizeRequestToolCallIds(payload)
    const assistantMessage = denormalized.messages[0]

    if (assistantMessage.role !== "assistant" || !assistantMessage.tool_calls) {
      throw new Error("Expected assistant message with tool_calls")
    }

    expect(assistantMessage.role).toBe("assistant")
    expect(assistantMessage.tool_calls).toHaveLength(1)
    expect(assistantMessage.tool_calls[0]).toMatchObject({
      id: "tool_use_new_1",
    })
    expect(denormalized.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "tool_use_new_1",
    })
  })
})
