import type {
  ResponseContextManagementCompactionItem,
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { isResponsesApiContextManagementModel } from "~/lib/config"

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  return { vision, initiator }
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  // Check only the last message in the history to determine initiator type.
  // This prevents valid user messages from being incorrectly flagged as agent
  // calls due to previous assistant history.
  const lastItem = getPayloadItems(payload).at(-1)
  if (!lastItem) {
    return false
  }
  if (!("role" in lastItem) || !lastItem.role) {
    return true
  }
  const role =
    typeof lastItem.role === "string" ? lastItem.role.toLowerCase() : ""
  return role === "assistant"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}

// ============================================================================
// COMPACTION UTILITIES
// ============================================================================

/**
 * Resolve compact threshold based on max prompt tokens
 * Default: 50000, or 90% of maxPromptTokens if provided
 */
export const resolveResponsesCompactThreshold = (
  maxPromptTokens?: number,
): number => {
  if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
    return Math.floor(maxPromptTokens * 0.9)
  }
  return 50000
}

/**
 * Create compaction context management config
 */
const createCompactionContextManagement = (
  compactThreshold: number,
): Array<ResponseContextManagementCompactionItem> => [
  {
    type: "compaction",
    compact_threshold: compactThreshold,
  },
]

/**
 * Apply context management to payload if model supports it
 */
export const applyResponsesApiContextManagement = (
  payload: ResponsesPayload,
  maxPromptTokens?: number,
): void => {
  // Don't override if already set
  if (payload.context_management !== undefined) {
    return
  }

  // Only apply for supported models
  if (!isResponsesApiContextManagementModel(payload.model)) {
    return
  }

  payload.context_management = createCompactionContextManagement(
    resolveResponsesCompactThreshold(maxPromptTokens),
  )
}

/**
 * Compact input by keeping only messages from latest compaction point
 */
export const compactInputByLatestCompaction = (
  payload: ResponsesPayload,
): void => {
  if (!Array.isArray(payload.input) || payload.input.length === 0) {
    return
  }

  const latestCompactionMessageIndex = getLatestCompactionMessageIndex(
    payload.input,
  )

  if (latestCompactionMessageIndex === undefined) {
    return
  }

  payload.input = payload.input.slice(latestCompactionMessageIndex)
}

/**
 * Find index of latest compaction message in input array
 */
const getLatestCompactionMessageIndex = (
  input: Array<ResponseInputItem>,
): number | undefined => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isCompactionInputItem(input[index])) {
      return index
    }
  }
  return undefined
}

/**
 * Check if an input item is a compaction item
 */
const isCompactionInputItem = (value: ResponseInputItem): boolean => {
  return (
    "type" in value
    && typeof value.type === "string"
    && value.type === "compaction"
  )
}
