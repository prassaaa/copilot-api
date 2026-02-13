import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"

import { applyFallback } from "~/lib/fallback"
import { logEmitter } from "~/lib/logger"

/**
 * Remove fields from tool parameter schemas that the Copilot API may not support.
 * These extra fields (additionalProperties, $schema, title) can cause the API
 * to ignore tool definitions entirely, making the model fall back to plain text.
 */
function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...schema }
  delete cleaned.additionalProperties
  delete cleaned.$schema
  delete cleaned.title

  if (cleaned.properties && typeof cleaned.properties === "object") {
    const props = cleaned.properties as Record<string, Record<string, unknown>>
    const cleanedProps: Record<string, Record<string, unknown>> = {}
    for (const [key, value] of Object.entries(props)) {
      cleanedProps[key] = typeof value === "object" ? cleanSchema(value) : value
    }
    cleaned.properties = cleanedProps
  }

  if (cleaned.items && typeof cleaned.items === "object") {
    cleaned.items = cleanSchema(cleaned.items as Record<string, unknown>)
  }

  return cleaned
}

/**
 * Normalize tools and tool_choice to OpenAI standard format.
 * Some clients (e.g. Cursor) send tools without the `type: "function"` wrapper
 * or use Anthropic's `input_schema` instead of `parameters`.
 * Also cleans tool parameter schemas to remove unsupported fields.
 */
export function normalizeTools(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  let tools = payload.tools
  let toolChoice = payload.tool_choice

  if (tools && tools.length > 0) {
    tools = tools.map((tool) => {
      const raw = tool as unknown as Record<string, unknown>

      // Already in correct format
      if (raw.type === "function" && raw.function) {
        const fn = tool.function
        return {
          ...tool,
          function: {
            ...fn,
            parameters: cleanSchema(fn.parameters),
          },
        }
      }

      // Tool sent without wrapper — has name/parameters/input_schema at top level
      if (raw.name || raw.parameters || raw.input_schema) {
        const params = (raw.input_schema || raw.parameters || {}) as Record<
          string,
          unknown
        >
        return {
          type: "function" as const,
          function: {
            name: (raw.name as string) || "",
            description: raw.description as string | undefined,
            parameters: cleanSchema(params),
          },
        }
      }

      return tool
    })
  }

  if (
    toolChoice
    && typeof toolChoice === "object"
    && !("function" in toolChoice)
  ) {
    const raw = toolChoice as Record<string, unknown>
    if (raw.type === "auto" || raw.type === "none" || raw.type === "required") {
      toolChoice = raw.type
    } else if (raw.type === "function" && raw.name) {
      toolChoice = {
        type: "function" as const,
        function: { name: raw.name as string },
      }
    }
  }

  if (tools !== payload.tools || toolChoice !== payload.tool_choice) {
    return { ...payload, tools, tool_choice: toolChoice }
  }
  return payload
}

const CUS_PREFIX = "cus-"

function stripModelPrefix(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (payload.model.startsWith(CUS_PREFIX)) {
    return { ...payload, model: payload.model.slice(CUS_PREFIX.length) }
  }
  return payload
}

/**
 * Strip Anthropic-specific fields (`cache_control`) from message content parts
 * and convert Anthropic-style `tool_result` blocks (sent inside user messages)
 * into OpenAI `tool` role messages.
 *
 * Cursor sometimes sends messages in Anthropic format even when talking to an
 * OpenAI-compatible endpoint.
 */
export function sanitizeAnthropicFields(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const outMessages: Array<Message> = []
  let changed = false

  for (const msg of payload.messages) {
    // Handle Anthropic tool_result blocks inside user messages
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(
        (p) => (p as unknown as Record<string, unknown>).type === "tool_result",
      )

      if (toolResults.length > 0) {
        changed = true

        // Extract tool_result blocks → OpenAI tool role messages
        for (const tr of toolResults) {
          const raw = tr as unknown as Record<string, unknown>
          outMessages.push({
            role: "tool",
            tool_call_id: (raw.tool_use_id as string) || "",
            content:
              typeof raw.content === "string" ?
                raw.content
              : JSON.stringify(raw.content),
          })
        }

        // Keep remaining (non-tool_result) content parts as a user message
        const otherParts = msg.content.filter(
          (p) =>
            (p as unknown as Record<string, unknown>).type !== "tool_result",
        )
        if (otherParts.length > 0) {
          outMessages.push({ ...msg, content: stripCacheControl(otherParts) })
        }
        continue
      }

      // No tool_result — just strip cache_control
      const stripped = stripCacheControl(msg.content)
      if (stripped !== msg.content) {
        changed = true
        outMessages.push({ ...msg, content: stripped })
        continue
      }
    }

    outMessages.push(msg)
  }

  return changed ? { ...payload, messages: outMessages } : payload
}

/**
 * Remove `cache_control` from every content part (Anthropic-only field).
 * Parts come from the network so they may contain fields not in our types.
 */
function stripCacheControl(
  parts: Message["content"] & Array<unknown>,
): Message["content"] & Array<unknown> {
  const cleaned = parts.map((part) => {
    if (typeof part !== "object" || part === null) return part
    const raw = part as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(raw, "cache_control")) {
      const { cache_control: _, ...rest } = raw
      return rest
    }
    return part
  })
  return cleaned as typeof parts
}

export function preparePayload(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const stripped = stripModelPrefix(payload)
  const fallbackResult = applyFallback(stripped.model)
  if (fallbackResult.didFallback) {
    consola.info(
      `Model fallback: ${fallbackResult.originalModel} → ${fallbackResult.model}`,
    )
    logEmitter.log(
      "warn",
      `Model fallback: ${fallbackResult.originalModel} → ${fallbackResult.model}`,
    )
    return { ...stripped, model: fallbackResult.model }
  }
  return stripped
}
