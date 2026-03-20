/**
 * Subagent Marker Detection
 * Detects subagent markers from Claude Code to properly classify traffic
 * and avoid consuming premium quota for subagent requests
 */

import type { Context } from "hono"

import { getUUID } from "~/lib/utils"

import type { AnthropicMessagesPayload } from "./anthropic-types"

const SUBAGENT_MARKER_PREFIX = "__SUBAGENT_MARKER__"

export interface SubagentMarker {
  session_id: string
  agent_id: string
  agent_type: string
}

/**
 * Parse subagent marker from the first user message in payload
 */
export function parseSubagentMarkerFromFirstUser(
  payload: AnthropicMessagesPayload,
): SubagentMarker | null {
  const firstUserMessage = payload.messages.find((msg) => msg.role === "user")
  if (!firstUserMessage) {
    return null
  }

  const content = firstUserMessage.content
  if (typeof content === "string") {
    return parseSubagentMarkerFromSystemReminder(content)
  }

  if (!Array.isArray(content)) {
    return null
  }

  for (const block of content) {
    if (block.type === "text" && "text" in block) {
      const marker = parseSubagentMarkerFromSystemReminder(block.text)
      if (marker) {
        return marker
      }
    }
  }

  return null
}

/**
 * Parse subagent marker from system reminder tags
 */
function parseSubagentMarkerFromSystemReminder(
  text: string,
): SubagentMarker | null {
  const startTag = "<system-reminder>"
  const endTag = "</system-reminder>"
  let searchFrom = 0

  while (true) {
    const reminderStart = text.indexOf(startTag, searchFrom)
    if (reminderStart === -1) {
      break
    }

    const contentStart = reminderStart + startTag.length
    const reminderEnd = text.indexOf(endTag, contentStart)
    if (reminderEnd === -1) {
      break
    }

    const reminderContent = text.slice(contentStart, reminderEnd)
    const markerIndex = reminderContent.indexOf(SUBAGENT_MARKER_PREFIX)
    if (markerIndex === -1) {
      searchFrom = reminderEnd + endTag.length
      continue
    }

    const markerJson = reminderContent
      .slice(markerIndex + SUBAGENT_MARKER_PREFIX.length)
      .trim()

    try {
      const parsed = JSON.parse(markerJson) as SubagentMarker
      if (!parsed.session_id || !parsed.agent_id || !parsed.agent_type) {
        searchFrom = reminderEnd + endTag.length
        continue
      }

      return parsed
    } catch {
      searchFrom = reminderEnd + endTag.length
      continue
    }
  }

  return null
}

/**
 * Get root session ID from payload metadata or header
 * Returns hashed UUID for consistency
 */
export function getRootSessionId(
  payload: AnthropicMessagesPayload,
  c: Context,
): string | undefined {
  let sessionId: string | undefined

  // Try to get from metadata.user_id
  if (payload.metadata?.user_id) {
    const sessionMatch = /_session_(.+)$/.exec(payload.metadata.user_id)
    sessionId = sessionMatch ? sessionMatch[1] : undefined
  }

  // Fallback to x-session-id header
  if (!sessionId) {
    sessionId = c.req.header("x-session-id")
  }

  // Hash session ID for consistency
  if (sessionId) {
    return getUUID(sessionId)
  }

  return undefined
}
