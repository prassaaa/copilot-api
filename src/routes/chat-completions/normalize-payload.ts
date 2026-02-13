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

  // Recursively clean schema composition keywords (anyOf, oneOf, allOf)
  // Cursor commonly sends union types using these constructs.
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(cleaned[keyword])) {
      cleaned[keyword] = (cleaned[keyword] as Array<unknown>).map((item) =>
        typeof item === "object" && item !== null ?
          cleanSchema(item as Record<string, unknown>)
        : item,
      )
    }
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
    } else if (raw.type === "any") {
      // Anthropic "any" maps to OpenAI "required"
      toolChoice = "required"
    } else if ((raw.type === "function" || raw.type === "tool") && raw.name) {
      // Anthropic { type: "tool", name } maps to OpenAI { type: "function", function: { name } }
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

interface ClassifiedParts {
  toolResults: Array<Record<string, unknown>>
  toolUses: Array<Record<string, unknown>>
  other: Array<unknown>
}

function classifyContentParts(parts: Array<unknown>): ClassifiedParts {
  const toolResults: Array<Record<string, unknown>> = []
  const toolUses: Array<Record<string, unknown>> = []
  const other: Array<unknown> = []

  for (const part of parts) {
    const raw = part as Record<string, unknown>
    if (raw.type === "tool_result") {
      toolResults.push(raw)
    } else if (raw.type === "tool_use") {
      toolUses.push(raw)
    } else {
      other.push(part)
    }
  }

  return { toolResults, toolUses, other }
}

function generateToolCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`
}

function toolUsePartsToAssistantMessage(
  toolUseParts: Array<Record<string, unknown>>,
  otherParts: Array<unknown>,
): Message {
  const textContent = otherParts
    .filter(
      (p) =>
        (p as Record<string, unknown>).type === "text"
        && (p as Record<string, unknown>).text,
    )
    .map((p) => (p as Record<string, unknown>).text as string)
    .join("")

  return {
    role: "assistant",
    content: textContent || null,
    tool_calls: toolUseParts.map((tu) => {
      const id = (tu.id as string) || generateToolCallId()
      return {
        id,
        type: "function" as const,
        function: {
          name: (tu.name as string) || "",
          arguments:
            typeof tu.input === "string" ?
              tu.input
            : JSON.stringify(tu.input ?? {}),
        },
      }
    }),
  }
}

function toolResultPartToToolMessage(tr: Record<string, unknown>): Message {
  return {
    role: "tool",
    tool_call_id: (tr.tool_use_id as string) || generateToolCallId(),
    content:
      typeof tr.content === "string" ?
        tr.content
      : JSON.stringify(tr.content ?? ""),
  }
}

/**
 * Strip Anthropic-specific fields and convert Anthropic message format
 * to OpenAI format.
 *
 * Handles:
 * - `tool_result` blocks (in any message) → OpenAI `tool` role messages
 * - `tool_use` blocks (in assistant messages) → OpenAI `tool_calls` array
 * - `cache_control` field removal from content parts
 *
 * Cursor sometimes sends the entire conversation in Anthropic format
 * even when talking to an OpenAI-compatible endpoint.
 */
export function sanitizeAnthropicFields(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const outMessages: Array<Message> = []
  let changed = false

  for (const msg of payload.messages) {
    if (!Array.isArray(msg.content)) {
      outMessages.push(msg)
      continue
    }

    const { toolResults, toolUses, other } = classifyContentParts(
      msg.content as Array<unknown>,
    )

    // No Anthropic blocks found — just strip cache_control
    if (toolResults.length === 0 && toolUses.length === 0) {
      const stripped = stripCacheControl(msg.content)
      if (stripped !== msg.content) {
        changed = true
      }
      outMessages.push({ ...msg, content: stripped })
      continue
    }

    changed = true

    if (toolUses.length > 0) {
      outMessages.push(toolUsePartsToAssistantMessage(toolUses, other))
    }

    for (const tr of toolResults) {
      outMessages.push(toolResultPartToToolMessage(tr))
    }

    // Keep remaining non-tool parts as a separate message (if any)
    if (other.length > 0 && toolUses.length === 0) {
      outMessages.push({
        ...msg,
        content: stripCacheControl(
          other as Message["content"] & Array<unknown>,
        ),
      })
    }
  }

  return changed ? { ...payload, messages: outMessages } : payload
}

/**
 * Remove `cache_control` from every content part (Anthropic-only field).
 * Parts come from the network so they may contain fields not in our types.
 * Returns the original array unchanged when no parts had `cache_control`.
 */
function stripCacheControl(
  parts: Message["content"] & Array<unknown>,
): Message["content"] & Array<unknown> {
  const hasCacheControl = parts.some(
    (part) =>
      typeof part === "object"
      && part !== null
      && Object.prototype.hasOwnProperty.call(part, "cache_control"),
  )
  if (!hasCacheControl) return parts

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
