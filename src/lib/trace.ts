/**
 * Request Tracing Middleware
 * Handles x-trace-id header and request context
 */

import type { Context, Next } from "hono"

import { requestContext, type RequestContext } from "./request-context"

const TRACE_ID_MAX_LENGTH = 64
const TRACE_ID_PATTERN = /^\w[\w.-]*$/

/**
 * Generate a new trace ID
 */
export const generateTraceId = (): string => {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

/**
 * Resolve trace ID from header or generate new one
 */
export const resolveTraceId = (rawTraceId?: string | null): string => {
  if (!rawTraceId) {
    return generateTraceId()
  }

  const trimmed = rawTraceId.trim()

  if (trimmed.length > TRACE_ID_MAX_LENGTH) {
    return generateTraceId()
  }

  if (!TRACE_ID_PATTERN.test(trimmed)) {
    return generateTraceId()
  }

  return trimmed
}

/**
 * Trace ID middleware for Hono
 * Sets up request context with trace ID
 */
export const traceIdMiddleware = async (
  c: Context,
  next: Next,
): Promise<void> => {
  const traceId = resolveTraceId(c.req.header("x-trace-id"))

  const context: RequestContext = {
    traceId,
    startTime: Date.now(),
  }

  // Set response header
  c.header("x-trace-id", traceId)

  // Run rest of middleware chain within context
  await requestContext.run(context, async () => {
    await next()
  })
}
