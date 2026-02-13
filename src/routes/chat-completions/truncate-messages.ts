import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { logEmitter } from "~/lib/logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"

function isSystemOrDeveloper(msg: Message): boolean {
  return msg.role === "system" || msg.role === "developer"
}

/**
 * Remove the oldest non-system message from the list, along with any
 * orphaned tool response messages if the removed message was an assistant
 * message with tool_calls.
 */
function removeOldestWithToolCleanup(messages: Array<Message>): Array<Message> {
  const [removed, ...rest] = messages
  if (removed.role !== "assistant" || !removed.tool_calls?.length) {
    return rest
  }

  const toolCallIds = new Set(removed.tool_calls.map((tc) => tc.id))
  const firstNonTool = rest.findIndex(
    (msg) =>
      msg.role !== "tool"
      || !msg.tool_call_id
      || !toolCallIds.has(msg.tool_call_id),
  )
  return firstNonTool === -1 ? [] : rest.slice(firstNonTool)
}

/**
 * Remove orphaned messages after truncation:
 * 1. Tool messages whose tool_call_id has no matching assistant tool_calls
 * 2. Assistant messages with tool_calls whose tool results are missing
 *
 * After cleanup, strips any leading tool/assistant-only messages so the
 * non-system portion always starts with a user message.
 */
function removeOrphanedToolMessages(messages: Array<Message>): Array<Message> {
  const assistantToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        assistantToolCallIds.add(tc.id)
      }
    }
  }

  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id)
    }
  }

  const cleaned = messages
    .map((msg) => {
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        const hasAllResults = msg.tool_calls.every((tc) =>
          toolResultIds.has(tc.id),
        )
        if (!hasAllResults) {
          if (msg.content) {
            const { tool_calls: _, ...rest } = msg
            return rest as Message
          }
          return null
        }
      }

      if (msg.role === "tool" && msg.tool_call_id) {
        return assistantToolCallIds.has(msg.tool_call_id) ? msg : null
      }

      return msg
    })
    .filter((msg): msg is Message => msg !== null)

  const firstUserIdx = cleaned.findIndex((m) => m.role === "user")
  if (firstUserIdx > 0) {
    return cleaned.slice(firstUserIdx)
  }
  return cleaned
}

async function computeInputTokens(
  payload: ChatCompletionsPayload,
  model: Model,
): Promise<number | null> {
  try {
    const count = await getTokenCount(payload, model)
    return count.input
  } catch {
    return null
  }
}

function resolvePromptTokenLimit(
  limits:
    | {
        max_prompt_tokens?: number
        max_context_window_tokens?: number
        max_output_tokens?: number
      }
    | undefined,
): number | null {
  if (limits?.max_prompt_tokens) return limits.max_prompt_tokens

  if (limits?.max_context_window_tokens) {
    const contextWindow = limits.max_context_window_tokens
    const outputReserve =
      limits.max_output_tokens ?
        Math.min(limits.max_output_tokens, Math.floor(contextWindow * 0.1))
      : Math.max(4096, Math.floor(contextWindow * 0.1))
    return contextWindow - outputReserve
  }

  return null
}

function countTrailingToolTurnMessages(messages: Array<Message>): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "tool") {
      count++
    } else if (msg.role === "assistant" && msg.tool_calls?.length) {
      count++
      break
    } else {
      break
    }
  }
  return count
}

export async function truncateMessages(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionsPayload> {
  const selectedModel = state.models?.data.find((m) => m.id === payload.model)
  if (!selectedModel) return payload

  const maxPromptTokens = resolvePromptTokenLimit(
    selectedModel.capabilities.limits,
  )
  if (!maxPromptTokens) return payload

  const initialInput = await computeInputTokens(payload, selectedModel)
  if (initialInput === null || initialInput <= maxPromptTokens) return payload

  const systemMessages = payload.messages.filter((m) => isSystemOrDeveloper(m))
  let nonSystemMessages = payload.messages.filter(
    (m) => !isSystemOrDeveloper(m),
  )

  const trailingProtected = countTrailingToolTurnMessages(nonSystemMessages)
  const minKeep = Math.max(2, trailingProtected)

  const originalCount = nonSystemMessages.length
  let currentInput = initialInput

  while (currentInput > maxPromptTokens && nonSystemMessages.length > minKeep) {
    nonSystemMessages = removeOldestWithToolCleanup(nonSystemMessages)

    const truncatedPayload = {
      ...payload,
      messages: [...systemMessages, ...nonSystemMessages],
    }
    const newInput = await computeInputTokens(truncatedPayload, selectedModel)
    if (newInput === null) break
    currentInput = newInput
  }

  const removedCount = originalCount - nonSystemMessages.length
  if (removedCount > 0) {
    nonSystemMessages = removeOrphanedToolMessages(nonSystemMessages)

    if (nonSystemMessages.length === 0) {
      const lastUser = payload.messages.findLast((m) => m.role === "user")
      if (lastUser) {
        nonSystemMessages = [lastUser]
      }
    }

    consola.warn(
      `Truncated ${removedCount} messages to fit within ${maxPromptTokens} prompt token limit (${initialInput} → ${currentInput} tokens)`,
    )
    logEmitter.log(
      "warn",
      `Truncated ${removedCount} messages: ${initialInput} → ${currentInput} tokens (limit: ${maxPromptTokens})`,
    )
    return { ...payload, messages: [...systemMessages, ...nonSystemMessages] }
  }

  return payload
}
