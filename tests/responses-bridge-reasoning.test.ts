import { describe, expect, test } from "bun:test"

import { convertToResponsesPayload } from "../src/routes/chat-completions/responses-bridge"

describe("convertToResponsesPayload reasoning effort", () => {
  test("gpt-5.3-codex gets xhigh reasoning effort by default", () => {
    const payload = {
      model: "gpt-5.3-codex",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.reasoning).toEqual({
      effort: "xhigh",
      summary: "detailed",
    })
  })

  test("gpt-5.4 gets xhigh reasoning effort by default", () => {
    const payload = {
      model: "gpt-5.4",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.reasoning).toEqual({
      effort: "xhigh",
      summary: "detailed",
    })
  })

  test("gpt-5-mini gets low reasoning effort by default", () => {
    const payload = {
      model: "gpt-5-mini",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.reasoning).toEqual({
      effort: "low",
      summary: "detailed",
    })
  })

  test("unconfigured model defaults to high reasoning effort", () => {
    const payload = {
      model: "gpt-4.1",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.reasoning).toEqual({
      effort: "high",
      summary: "detailed",
    })
  })

  test("includes reasoning.encrypted_content in include array", () => {
    const payload = {
      model: "gpt-5.3-codex",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.include).toEqual(["reasoning.encrypted_content"])
  })

  test("sets temperature to 1 for reasoning models", () => {
    const payload = {
      model: "gpt-5.3-codex",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.temperature).toBe(1)
  })

  test("sets max_output_tokens to at least 12800", () => {
    const payload = {
      model: "gpt-5.3-codex",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
      max_tokens: 100,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.max_output_tokens).toBe(12800)
  })

  test("preserves max_output_tokens when larger than 12800", () => {
    const payload = {
      model: "gpt-5.3-codex",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
      max_tokens: 25000,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.max_output_tokens).toBe(25000)
  })

  test("sets store to false", () => {
    const payload = {
      model: "gpt-5.3-codex",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.store).toBe(false)
  })

  test("sets parallel_tool_calls to true", () => {
    const payload = {
      model: "gpt-5.3-codex",
      messages: [{ role: "user" as const, content: "Hello" }],
      stream: false,
    }

    const result = convertToResponsesPayload(payload)

    expect(result.parallel_tool_calls).toBe(true)
  })
})
