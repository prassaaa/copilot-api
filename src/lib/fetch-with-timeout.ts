/**
 * Fetch with timeout utility
 * Wraps fetch with AbortController timeout to prevent hanging requests
 */

const DEFAULT_TIMEOUT = 30000 // 30 seconds

export interface FetchWithTimeoutOptions extends RequestInit {
  timeout?: number
}

/**
 * Fetch with automatic timeout
 * @param url - URL to fetch
 * @param options - Fetch options with optional timeout (default: 30s)
 * @returns Promise<Response>
 * @throws Error if request times out
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const {
    timeout = DEFAULT_TIMEOUT,
    signal: parentSignal,
    ...fetchOptions
  } = options

  const timeoutController = new AbortController()
  const abortFromParent = () => timeoutController.abort()
  if (parentSignal?.aborted) {
    timeoutController.abort()
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true })
  }
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: timeoutController.signal,
    })
    return response
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (parentSignal?.aborted) {
        throw error
      }
      throw new Error(`Request timeout after ${timeout}ms: ${String(url)}`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
    parentSignal?.removeEventListener("abort", abortFromParent)
  }
}
