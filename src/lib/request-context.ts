/**
 * Request Context Module
 * Menyimpan context request untuk digunakan di seluruh aplikasi
 * Menggunakan AsyncLocalStorage untuk thread-safe storage
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface RequestContext {
  traceId: string
  startTime: number
  sessionId?: string
  userId?: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

export function generateTraceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn)
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore()
}

export function getTraceId(): string | undefined {
  return requestContext.getStore()?.traceId
}

/**
 * @deprecated Use getTraceId() instead
 */
export function getCurrentTraceId(): string | undefined {
  return getTraceId()
}
