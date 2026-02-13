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

const FORWARDED_ERROR_HEADERS = new Set([
  "retry-after",
  "www-authenticate",
  "x-request-id",
  "x-github-request-id",
])

function shouldForwardErrorHeader(headerName: string): boolean {
  const normalized = headerName.toLowerCase()
  return (
    FORWARDED_ERROR_HEADERS.has(normalized)
    || normalized.startsWith("x-ratelimit-")
  )
}

function forwardRelevantErrorHeaders(c: Context, response: Response): void {
  for (const [key, value] of response.headers.entries()) {
    if (shouldForwardErrorHeader(key)) {
      c.header(key, value)
    }
  }
}

const QUOTA_ERROR_CODES = new Set(["quota_exceeded", "insufficient_quota"])

const QUOTA_ERROR_KEYWORDS = ["no quota", "quota exceeded"]

/**
 * Detect whether an error is a quota-exhaustion error.
 * Quota errors should NOT be forwarded as 429 (Too Many Requests) because
 * clients like Cursor treat 429 as retryable and loop endlessly.
 * Instead we return 402 (Payment Required) which signals a non-retryable
 * billing/quota issue.
 */
function isQuotaError(
  normalized: ReturnType<typeof normalizeHttpError>,
): boolean {
  const code = normalized.code?.toLowerCase()
  if (code && QUOTA_ERROR_CODES.has(code)) return true
  const msg = normalized.message.toLowerCase()
  return QUOTA_ERROR_KEYWORDS.some((kw) => msg.includes(kw))
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    forwardRelevantErrorHeaders(c, error.response)
    let normalized: ReturnType<typeof normalizeHttpError>
    try {
      const errorText = await error.response.text()
      normalized = normalizeHttpError(errorText)
    } catch {
      // Response body may already be consumed (e.g. by parseCopilotErrorBody).
      normalized = {
        message: error.message || "Unknown upstream error",
        type: "error",
      }
    }
    consola.error("HTTP error:", normalized)

    // Quota errors: return 402 instead of 429 so clients stop retrying.
    // Also strip retry-after since this is not a temporary condition.
    let status = error.response.status as ContentfulStatusCode
    if (status === 429 && isQuotaError(normalized)) {
      status = 402
      c.header("retry-after", null as unknown as string)
    }

    return c.json(
      {
        error: normalized,
      },
      status,
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
