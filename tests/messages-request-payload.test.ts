import { describe, expect, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { normalizeAnthropicMessagesPayload } from "../src/routes/messages/request-payload"

async function expectInvalidPayload(
  payload: unknown,
  messagePart: string,
): Promise<void> {
  try {
    normalizeAnthropicMessagesPayload(payload)
    expect.unreachable("Expected payload normalization to throw")
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPError)
    const httpError = error as HTTPError
    expect(httpError.response.status).toBe(400)
    const body = (await httpError.response.json()) as {
      error?: { message?: string }
    }
    expect(body.error?.message).toContain(messagePart)
  }
}

describe("normalizeAnthropicMessagesPayload", () => {
  test("keeps valid anthropic payload", () => {
    const normalized = normalizeAnthropicMessagesPayload({
      max_tokens: 1200,
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-sonnet-4",
      stream: true,
    })

    expect(normalized.model).toBe("claude-sonnet-4")
    expect(normalized.max_tokens).toBe(1200)
    expect(normalized.stream).toBe(true)
    expect(normalized.messages).toEqual([{ role: "user", content: "Hello" }])
  })

  test("maps prompt into messages when messages are missing", () => {
    const normalized = normalizeAnthropicMessagesPayload({
      model: "claude-sonnet-4",
      prompt: "Summarize this document",
    })

    expect(normalized.messages).toEqual([
      { role: "user", content: "Summarize this document" },
    ])
    expect(normalized.max_tokens).toBe(4096)
  })

  test("treats null messages as missing and falls back to input", () => {
    const normalized = normalizeAnthropicMessagesPayload({
      input: "Fix this test",
      messages: null,
      model: "claude-sonnet-4",
    })

    expect(normalized.messages).toEqual([
      { role: "user", content: "Fix this test" },
    ])
  })

  test("converts system/developer messages to anthropic system prompt", () => {
    const normalized = normalizeAnthropicMessagesPayload({
      messages: [
        { role: "system", content: "You are strict." },
        { role: "developer", content: "Answer in JSON." },
        { role: "user", content: "Hello" },
      ],
      model: "claude-sonnet-4",
    })

    expect(normalized.system).toBe("You are strict.\n\nAnswer in JSON.")
    expect(normalized.messages).toEqual([{ role: "user", content: "Hello" }])
  })

  test("throws when messages is not an array", async () => {
    await expectInvalidPayload(
      {
        messages: { role: "user", content: "Hello" },
        model: "claude-sonnet-4",
      },
      "`messages` must be an array",
    )
  })
})
