/**
 * Request Context using AsyncLocalStorage
 * Provides request-scoped context for tracing and logging
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface RequestContext {
  traceId: string
  startTime: number
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

/**
 * Get current request context
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore()
}

/**
 * Get current trace ID or undefined
 */
export function getCurrentTraceId(): string | undefined {
  return requestContext.getStore()?.traceId
}
