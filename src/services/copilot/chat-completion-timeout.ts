import { getConfig } from "~/lib/config"

function resolveChatCompletionTimeoutMs(): number {
  // First check env var for backward compatibility
  const raw = process.env.CHAT_COMPLETION_TIMEOUT_MS
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  // Fall back to config
  return getConfig().requestTimeoutMs
}

export function getChatCompletionTimeout(): number {
  return resolveChatCompletionTimeoutMs()
}
