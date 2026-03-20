/**
 * Initiator Inference for Anthropic Messages API
 *
 * Determines whether the last message in a conversation was sent by an "agent" or "user"
 * based on the content structure. This is used to set the X-Initiator header for the
 * Copilot Responses API.
 *
 * Key Logic:
 * - If last message is not a user role: return "user" (default)
 * - If content is a string: return "user"
 * - If content has tool_result blocks: check if ONLY tool_result + text blocks present
 *   - If only tool_result + text: return "agent" (agent submitting tool results)
 *   - If has other block types (image, etc): return "user" (user with mixed content)
 */

import type {
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
} from "./anthropic-types"

/**
 * Infer the initiator (agent or user) from the last message in the conversation.
 *
 * This improved logic handles the case where a user message contains only tool results
 * and optional text, which should be treated as agent-initiated (agent submitting tool
 * results back to the model).
 *
 * @param payload - The Anthropic messages payload
 * @returns "agent" if the last message is agent-initiated, "user" otherwise
 */
export function inferAnthropicInitiatorFromLastMessage(
  payload: AnthropicMessagesPayload,
): "agent" | "user" {
  const lastMessage = payload.messages.at(-1)

  // If no messages or last message is not user role, default to "user"
  if (!lastMessage || lastMessage.role !== "user") {
    return "user"
  }

  // If content is a string, it's always user-initiated
  if (typeof lastMessage.content === "string") {
    return "user"
  }

  // If content is not an array, default to "user"
  if (!Array.isArray(lastMessage.content)) {
    return "user"
  }

  // Check for tool_result blocks
  const hasToolResult = lastMessage.content.some(
    (block) => block.type === "tool_result",
  )

  // If no tool results, it's user-initiated
  if (!hasToolResult) {
    return "user"
  }

  // If has tool results, check if ONLY tool_result and text blocks are present
  const hasOnlyToolResultAndText = lastMessage.content.every(
    (block: AnthropicUserContentBlock) =>
      block.type === "tool_result" || block.type === "text",
  )

  // If only tool_result + text blocks, it's agent-initiated (agent submitting tool results)
  // If has other block types (image, etc), it's user-initiated (user with mixed content)
  return hasOnlyToolResultAndText ? "agent" : "user"
}
