/**
 * Quota Optimizer Module
 * Optimizes GitHub Copilot quota usage by:
 * 1. Detecting warmup/compact requests and routing to small model
 * 2. Merging tool_result + text blocks to avoid multiple premium requests
 * 3. Detecting subagent traffic for proper classification
 */

import consola from "consola"

import type {
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "./anthropic-types"

const COMPACT_SYSTEM_PROMPT_START =
  "You are a helpful AI assistant tasked with summarizing conversations"

/**
 * Check if request is a compact/summarization request (Claude Code/OpenCode)
 */
export function isCompactRequest(payload: AnthropicMessagesPayload): boolean {
  const system = payload.system
  if (typeof system === "string") {
    return system.startsWith(COMPACT_SYSTEM_PROMPT_START)
  }
  if (!Array.isArray(system)) return false

  return system.some((block) =>
    block.text.startsWith(COMPACT_SYSTEM_PROMPT_START),
  )
}

/**
 * Check if request is a warmup/probe request (no tools defined)
 */
export function isWarmupRequest(payload: AnthropicMessagesPayload): boolean {
  return !payload.tools || payload.tools.length === 0
}

/**
 * Check if the latest message has tool_result blocks mixed with text
 * This typically happens with skill invocations, edit hooks, plan reminders, etc.
 */
export function hasToolResultWithText(
  payload: AnthropicMessagesPayload,
): boolean {
  const lastUserMessage = [...payload.messages]
    .reverse()
    .find((msg) => msg.role === "user")

  if (!lastUserMessage || typeof lastUserMessage.content === "string") {
    return false
  }

  const content = lastUserMessage.content
  const hasToolResult = content.some((block) => block.type === "tool_result")
  const hasText = content.some((block) => block.type === "text")

  return hasToolResult && hasText
}

/**
 * Merge tool_result and text blocks to avoid consuming extra premium requests
 * This prevents skill invocations, edit hooks, and reminders from being counted
 * as separate user turns
 */
export function mergeToolResultWithText(
  payload: AnthropicMessagesPayload,
): void {
  for (const msg of payload.messages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue

    const content = msg.content
    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let hasOtherTypes = false

    for (const block of content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        hasOtherTypes = true
        break
      }
    }

    // Only merge if we have both tool_results and text, and no other types
    if (hasOtherTypes || toolResults.length === 0 || textBlocks.length === 0) {
      continue
    }

    // Merge text into tool_result content
    msg.content = mergeToolResultContent(toolResults, textBlocks)
  }
}

/**
 * Merge text blocks into tool_result content
 */
function mergeToolResultContent(
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> {
  // Helper to stringify tool result content
  const stringifyContent = (
    content: string | Array<{ type: string; text?: string }>,
  ): string => {
    if (typeof content === "string") {
      return content
    }
    return content
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text ?? "")
      .join("\n")
  }

  // Equal lengths -> pairwise merge
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => ({
      ...tr,
      content: `${stringifyContent(tr.content)}\n\n${textBlocks[i].text}`,
    }))
  }

  // Different lengths -> append all text to last tool_result
  const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
  return toolResults.map((tr, i) =>
    i === toolResults.length - 1 ?
      {
        ...tr,
        content: `${stringifyContent(tr.content)}\n\n${appendedTexts}`,
      }
    : tr,
  )
}

export interface QuotaOptimizationResult {
  originalModel: string
  optimizedModel: string
  reason: "none" | "warmup" | "compact" | "subagent" | "tool_result_merged"
  isSubagent: boolean
  sessionId?: string
  mergedToolResults: boolean
}

/**
 * Apply quota optimization to the payload
 * Returns the optimization result with new model if applicable
 */
export function optimizeForQuota(
  payload: AnthropicMessagesPayload,
  options: {
    smallModel: string
    compactUseSmallModel: boolean
    warmupUseSmallModel: boolean
    isSubagent: boolean
    sessionId?: string
  },
): QuotaOptimizationResult {
  const result: QuotaOptimizationResult = {
    originalModel: payload.model,
    optimizedModel: payload.model,
    reason: "none",
    isSubagent: options.isSubagent,
    sessionId: options.sessionId,
    mergedToolResults: false,
  }

  // Check for compact request
  const isCompact = isCompactRequest(payload)
  if (isCompact && options.compactUseSmallModel) {
    result.optimizedModel = options.smallModel
    result.reason = "compact"
    consola.debug(
      `Quota optimization: compact request detected, using ${options.smallModel}`,
    )
    return result
  }

  // Check for warmup request (no tools)
  const isWarmup = isWarmupRequest(payload)
  if (isWarmup && options.warmupUseSmallModel && !isCompact) {
    result.optimizedModel = options.smallModel
    result.reason = "warmup"
    consola.debug(
      `Quota optimization: warmup request detected (no tools), using ${options.smallModel}`,
    )
    return result
  }

  // Check for subagent traffic
  if (options.isSubagent) {
    result.reason = "subagent"
    consola.debug(
      `Quota optimization: subagent request detected, marking as agent traffic`,
    )
    // Subagent requests don't change model but are marked for header modification
  }

  // Check for tool_result + text mix (not for compact requests)
  if (!isCompact && hasToolResultWithText(payload)) {
    mergeToolResultWithText(payload)
    result.mergedToolResults = true
    if (result.reason === "none") {
      result.reason = "tool_result_merged"
    }
    consola.debug(
      `Quota optimization: merged tool_result with text blocks to avoid extra premium request`,
    )
  }

  return result
}
