import { describe, expect, test } from "bun:test"

import { resolvePromptTokenLimit } from "../src/routes/chat-completions/truncate-messages"

describe("resolvePromptTokenLimit", () => {
  test("reserves output headroom when max_prompt_tokens is present", () => {
    expect(
      resolvePromptTokenLimit({
        max_prompt_tokens: 128000,
      }),
    ).toBe(121600)
  })

  test("caps prompt reserve by max_output_tokens when smaller", () => {
    expect(
      resolvePromptTokenLimit({
        max_prompt_tokens: 128000,
        max_output_tokens: 2000,
      }),
    ).toBe(126000)
  })

  test("uses context window fallback when max_prompt_tokens is missing", () => {
    expect(
      resolvePromptTokenLimit({
        max_context_window_tokens: 128000,
        max_output_tokens: 8192,
      }),
    ).toBe(119808)
  })

  test("returns null when no limits are available", () => {
    expect(resolvePromptTokenLimit(undefined)).toBeNull()
  })

  test("applies safety multiplier for Gemini models", () => {
    // Gemini uses 50% safety multiplier
    expect(
      resolvePromptTokenLimit(
        { max_prompt_tokens: 128000 },
        "gemini-3-pro-preview",
      ),
    ).toBe(60800) // 121600 * 0.5
  })

  test("applies safety multiplier for non-OpenAI models", () => {
    // Non-OpenAI, non-Gemini models use 70% safety multiplier
    expect(
      resolvePromptTokenLimit({ max_prompt_tokens: 128000 }, "claude-sonnet-4"),
    ).toBe(85120) // 121600 * 0.7
  })

  test("no safety multiplier for OpenAI models", () => {
    expect(
      resolvePromptTokenLimit({ max_prompt_tokens: 128000 }, "gpt-4.1"),
    ).toBe(121600) // No multiplier
  })
})
