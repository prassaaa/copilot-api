function resolveChatCompletionTimeoutMs(): number {
  const raw = process.env.CHAT_COMPLETION_TIMEOUT_MS
  if (!raw) return 60000
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 60000
  return parsed
}

export const CHAT_COMPLETION_TIMEOUT = resolveChatCompletionTimeoutMs()
