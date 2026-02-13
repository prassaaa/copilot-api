import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

/**
 * Map of normalized tool call IDs to originals for lossless round-trip.
 */
const toolCallIdMap = new Map<string, string>()
const TOOL_CALL_ID_MAP_MAX_SIZE = 10000

function pruneToolCallIdMap(): void {
  if (toolCallIdMap.size <= TOOL_CALL_ID_MAP_MAX_SIZE) return
  const excess = toolCallIdMap.size - TOOL_CALL_ID_MAP_MAX_SIZE + 1000
  const iterator = toolCallIdMap.keys()
  for (let i = 0; i < excess; i++) {
    const key = iterator.next().value
    if (key !== undefined) toolCallIdMap.delete(key)
  }
}

export function normalizeToolCallId(id: string): string {
  if (id.startsWith("call_")) {
    return id
  }

  const safe = id.replaceAll(/[^\w-]/g, "_")
  const normalized = `call_${safe}`

  toolCallIdMap.set(normalized, id)
  pruneToolCallIdMap()

  return normalized
}

function denormalizeToolCallId(id: string): string {
  if (!id.startsWith("call_")) {
    return id
  }

  const original = toolCallIdMap.get(id)
  if (original) {
    return original
  }

  return id.slice(5)
}

export function denormalizeRequestToolCallIds(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages.map((msg) => {
    if (msg.role === "tool" && msg.tool_call_id) {
      const denormalized = denormalizeToolCallId(msg.tool_call_id)
      if (denormalized !== msg.tool_call_id) {
        return { ...msg, tool_call_id: denormalized }
      }
    }

    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const denormalizedCalls = msg.tool_calls.map((tc) => {
        const denormalized = denormalizeToolCallId(tc.id)
        return denormalized !== tc.id ? { ...tc, id: denormalized } : tc
      })
      const originalCalls = msg.tool_calls
      const hasChanges = denormalizedCalls.some(
        (tc, i) => tc !== originalCalls[i],
      )
      if (hasChanges) {
        return { ...msg, tool_calls: denormalizedCalls }
      }
    }

    return msg
  })

  return { ...payload, messages }
}

export function normalizeResponseToolCallIds(
  response: ChatCompletionResponse,
): ChatCompletionResponse {
  const normalizedChoices = response.choices.map((choice) => {
    const toolCalls = choice.message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      return choice
    }

    return {
      ...choice,
      message: {
        ...choice.message,
        tool_calls: toolCalls.map((toolCall) => ({
          ...toolCall,
          id: normalizeToolCallId(toolCall.id),
        })),
      },
    }
  })

  return {
    ...response,
    choices: normalizedChoices,
  }
}

interface NormalizedStreamChunk {
  completionTokens: number | null
  data: string
}

interface StreamUsageChunk {
  usage?: {
    completion_tokens?: number
  }
}

function tryParseStreamUsage(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as StreamUsageChunk
    return parsed.usage?.completion_tokens ?? null
  } catch {
    return null
  }
}

export function normalizeStreamChunkData(data: string): NormalizedStreamChunk {
  if (!data || data === "[DONE]") {
    return { completionTokens: null, data }
  }

  try {
    const parsed = JSON.parse(data) as ChatCompletionChunk
    for (const choice of parsed.choices) {
      if (!choice.delta.tool_calls) {
        continue
      }

      for (const toolCall of choice.delta.tool_calls) {
        if (!toolCall.id) {
          continue
        }

        const normalizedId = normalizeToolCallId(toolCall.id)
        toolCall.id = normalizedId
      }
    }

    return {
      completionTokens: parsed.usage?.completion_tokens ?? null,
      data: JSON.stringify(parsed),
    }
  } catch {
    return {
      completionTokens: tryParseStreamUsage(data),
      data,
    }
  }
}

export function extractChunkInfo(data: string): {
  hasToolCalls: boolean
  finishReason: string | null
} {
  try {
    const parsed = JSON.parse(data) as ChatCompletionChunk
    let hasToolCalls = false
    let finishReason: string | null = null
    for (const choice of parsed.choices) {
      if (choice.delta.tool_calls) hasToolCalls = true
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
    return { hasToolCalls, finishReason }
  } catch {
    return { hasToolCalls: false, finishReason: null }
  }
}
