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
})
