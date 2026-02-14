import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import {
  applyToolLoopGuard,
  countTrailingToolCallTurns,
} from "../src/routes/chat-completions/tool-loop-guard"

function makePayload(messages: ChatCompletionsPayload["messages"]) {
  return {
    model: "claude-opus-4.6",
    messages,
    tools: [
      {
        type: "function" as const,
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    ],
    tool_choice: "auto" as const,
  } satisfies ChatCompletionsPayload
}

describe("tool-loop guard", () => {
  test("counts trailing assistant tool-call turns after the last user", () => {
    const payload = makePayload([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "{}" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_2", content: "{}" },
    ])

    expect(countTrailingToolCallTurns(payload.messages)).toBe(2)
  })

  test("applies guard when trailing turns reach threshold", () => {
    const previous = process.env.TOOL_LOOP_GUARD_MAX_TURNS
    process.env.TOOL_LOOP_GUARD_MAX_TURNS = "2"

    try {
      const payload = makePayload([
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "{}" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
      ])

      const result = applyToolLoopGuard(payload)

      expect(result.applied).toBe(true)
      expect(result.payload.tool_choice).toBe("none")
      expect(result.payload.tools).toBeNull()
      const lastMessage = result.payload.messages.at(-1)
      expect(lastMessage).toMatchObject({ role: "developer" })
    } finally {
      process.env.TOOL_LOOP_GUARD_MAX_TURNS = previous
    }
  })

  test("does not apply guard under threshold", () => {
    const previous = process.env.TOOL_LOOP_GUARD_MAX_TURNS
    process.env.TOOL_LOOP_GUARD_MAX_TURNS = "3"

    try {
      const payload = makePayload([
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "{}" },
      ])

      const result = applyToolLoopGuard(payload)

      expect(result.applied).toBe(false)
      expect(result.payload).toBe(payload)
    } finally {
      process.env.TOOL_LOOP_GUARD_MAX_TURNS = previous
    }
  })
})
