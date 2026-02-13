import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"

const toolCallIdMap = new Map<string, string>()
const TOOL_CALL_ID_MAP_MAX_SIZE = 10000
const TOOL_CALL_ID_MAP_PRUNE_COUNT = 1000
const ENCODED_TOOL_CALL_ID_PREFIX = "call_x_"

function touchToolCallId(normalized: string, original: string): void {
  // Map#delete + Map#set moves the entry to the end (newest).
  // This turns the built-in insertion-order into LRU order.
  toolCallIdMap.delete(normalized)
  toolCallIdMap.set(normalized, original)
}

function pruneToolCallIdMap(): void {
  if (toolCallIdMap.size <= TOOL_CALL_ID_MAP_MAX_SIZE) return
  const excess =
    toolCallIdMap.size
    - TOOL_CALL_ID_MAP_MAX_SIZE
    + TOOL_CALL_ID_MAP_PRUNE_COUNT
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

  // Use a deterministic reversible encoding so round-trip does not depend
  // on in-memory state. This prevents stale/evicted map entries from breaking
  // older tool_call_id references during long Cursor sessions.
  const normalized = `${ENCODED_TOOL_CALL_ID_PREFIX}${Buffer.from(id, "utf8").toString("base64url")}`

  touchToolCallId(normalized, id)
  pruneToolCallIdMap()

  return normalized
}

function decodeToolCallId(id: string): string | null {
  if (!id.startsWith(ENCODED_TOOL_CALL_ID_PREFIX)) return null
  const encoded = id.slice(ENCODED_TOOL_CALL_ID_PREFIX.length)
  if (!encoded) return null
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8")
    return decoded || null
  } catch {
    return null
  }
}

function denormalizeToolCallId(id: string): string {
  if (!id.startsWith("call_")) {
    return id
  }

  const decoded = decodeToolCallId(id)
  if (decoded) {
    touchToolCallId(id, decoded)
    return decoded
  }

  const original = toolCallIdMap.get(id)
  if (original) {
    // Refresh LRU position — this mapping is still in active use.
    touchToolCallId(id, original)
    return original
  }

  // Keep OpenAI-native call_* IDs unchanged when we don't have a reverse map.
  // Stripping "call_" here can break tool_result pairing and cause agent loops.
  return id
}

function getContiguousToolIndexes(
  messages: Array<Message>,
  assistantIndex: number,
): Array<number> {
  const contiguousToolIndexes: Array<number> = []
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== "tool") {
      break
    }
    contiguousToolIndexes.push(i)
  }
  return contiguousToolIndexes
}

function countMatchingToolIds(params: {
  messages: Array<Message>
  indexes: Array<number>
  expectedIds: Array<string>
}): number {
  const { messages, indexes, expectedIds } = params
  let matchingCount = 0
  for (const index of indexes) {
    const message = messages[index]
    if (
      message.role === "tool"
      && message.tool_call_id
      && expectedIds.includes(message.tool_call_id)
    ) {
      matchingCount++
    }
  }
  return matchingCount
}

function relinkContiguousToolMessages(
  messages: Array<Message>,
): Array<Message> {
  let changed = false
  const relinkedMessages = [...messages]

  for (const [assistantIndex, message] of relinkedMessages.entries()) {
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      continue
    }

    const expectedIds = message.tool_calls.map((toolCall) => toolCall.id)
    if (expectedIds.length === 0) {
      continue
    }

    const contiguousToolIndexes = getContiguousToolIndexes(
      relinkedMessages,
      assistantIndex,
    )
    if (contiguousToolIndexes.length === 0) {
      continue
    }

    const matchingCount = countMatchingToolIds({
      messages: relinkedMessages,
      indexes: contiguousToolIndexes,
      expectedIds,
    })
    const canRelinkByOrder =
      contiguousToolIndexes.length === expectedIds.length && matchingCount === 0

    if (!canRelinkByOrder) {
      continue
    }

    for (const [offset, messageIndex] of contiguousToolIndexes.entries()) {
      const toolMessage = relinkedMessages[messageIndex]
      if (toolMessage.role !== "tool") {
        continue
      }
      const expectedId = expectedIds[offset]
      if (!expectedId || toolMessage.tool_call_id === expectedId) {
        continue
      }
      relinkedMessages[messageIndex] = {
        ...toolMessage,
        tool_call_id: expectedId,
      }
      changed = true
    }
  }

  return changed ? relinkedMessages : messages
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

  return {
    ...payload,
    messages: relinkContiguousToolMessages(messages),
  }
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
  responseId: string | null
} {
  try {
    const parsed = JSON.parse(data) as ChatCompletionChunk
    let hasToolCalls = false
    let finishReason: string | null = null
    for (const choice of parsed.choices) {
      if (choice.delta.tool_calls) hasToolCalls = true
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
    return { hasToolCalls, finishReason, responseId: parsed.id || null }
  } catch {
    return { hasToolCalls: false, finishReason: null, responseId: null }
  }
}
