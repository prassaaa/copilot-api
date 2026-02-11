import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

/**
 * Safely get error message from unknown error
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseNestedMessage(
  message: unknown,
): { message?: string; code?: string } | null {
  if (typeof message !== "string") return null
  try {
    const parsed = JSON.parse(message) as unknown
    if (!isRecord(parsed)) return null
    const nestedError = parsed.error
    if (!isRecord(nestedError)) return null
    return {
      message:
        typeof nestedError.message === "string" ?
          nestedError.message
        : undefined,
      code: typeof nestedError.code === "string" ? nestedError.code : undefined,
    }
  } catch {
    return null
  }
}

function normalizeHttpError(errorText: string): {
  message: string
  type: "error"
  code?: string
} {
  try {
    const parsed = JSON.parse(errorText) as unknown
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const upstreamMessage = parsed.error.message
      const upstreamCode = parsed.error.code

      const nested = parseNestedMessage(upstreamMessage)
      if (nested?.message) {
        return {
          message: nested.message,
          type: "error",
          code:
            nested.code
            || (typeof upstreamCode === "string" ? upstreamCode : undefined),
        }
      }

      if (typeof upstreamMessage === "string") {
        return {
          message: upstreamMessage,
          type: "error",
          code: typeof upstreamCode === "string" ? upstreamCode : undefined,
        }
      }
    }
  } catch {
    // Keep raw text fallback
  }

  return {
    message: errorText,
    type: "error",
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    const normalized = normalizeHttpError(errorText)
    consola.error("HTTP error:", normalized)
    return c.json(
      {
        error: normalized,
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: getErrorMessage(error),
        type: "error",
      },
    },
    500,
  )
}
