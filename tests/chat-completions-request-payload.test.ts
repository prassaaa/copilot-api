import { describe, expect, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { normalizeChatCompletionsPayload } from "../src/routes/chat-completions/request-payload"

async function expectInvalidPayload(
  payload: unknown,
  messagePart: string,
): Promise<void> {
  try {
    normalizeChatCompletionsPayload(payload)
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

describe("normalizeChatCompletionsPayload", () => {
  test("keeps valid chat completion payload", () => {
    const normalized = normalizeChatCompletionsPayload({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.2,
    })

    expect(normalized.model).toBe("gpt-4.1")
    expect(normalized.messages).toEqual([{ role: "user", content: "Hello" }])
    expect(normalized.temperature).toBe(0.2)
  })

  test("maps prompt into messages when messages are missing", () => {
    const normalized = normalizeChatCompletionsPayload({
      model: "gpt-4.1",
      prompt: "Summarize this file",
    })

    expect(normalized.messages).toEqual([
      { role: "user", content: "Summarize this file" },
    ])

    const asRecord = normalized as unknown as Record<string, unknown>
    expect("prompt" in asRecord).toBe(false)
  })

  test("maps input string into messages when messages are missing", () => {
    const normalized = normalizeChatCompletionsPayload({
      model: "gpt-4.1",
      input: "Generate changelog",
    })

    expect(normalized.messages).toEqual([
      { role: "user", content: "Generate changelog" },
    ])

    const asRecord = normalized as unknown as Record<string, unknown>
    expect("input" in asRecord).toBe(false)
  })

  test("maps responses-style input array into chat messages", () => {
    const normalized = normalizeChatCompletionsPayload({
      model: "gpt-4.1",
      input: [
        {
          type: "message",
          message: { role: "system", content: "You are a code assistant." },
        },
        { type: "input_text", text: "Fix this bug" },
      ],
    })

    expect(normalized.messages).toEqual([
      { role: "system", content: "You are a code assistant." },
      { role: "user", content: "Fix this bug" },
    ])
  })

  test("throws when messages is not an array", async () => {
    await expectInvalidPayload(
      { model: "gpt-4.1", messages: { role: "user", content: "Hello" } },
      "`messages` must be an array",
    )
  })

  test("throws when no messages, prompt, or input is provided", async () => {
    await expectInvalidPayload({ model: "gpt-4.1" }, "`messages` is required")
  })
})
