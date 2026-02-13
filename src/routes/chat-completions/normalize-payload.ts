import consola from "consola"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

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
 * Some clients (e.g. Cursor) send tools without the `type: "function"` wrapper.
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

      // Tool sent without wrapper — has name/parameters at top level
      if (raw.name || raw.parameters) {
        return {
          type: "function" as const,
          function: {
            name: (raw.name as string) || "",
            description: raw.description as string | undefined,
            parameters: cleanSchema(
              raw.parameters ? (raw.parameters as Record<string, unknown>) : {},
            ),
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
