import consola from "consola"

import {
  type FetchWithTimeoutOptions,
  fetchWithTimeout,
} from "~/lib/fetch-with-timeout"

type HeaderInput = RequestInit["headers"]

function toHeaderRecord(headers: HeaderInput): Record<string, string> {
  const normalized = new Headers(headers)
  const result: Record<string, string> = {}
  for (const [key, value] of normalized.entries()) {
    result[key] = value
  }
  return result
}

function buildCompatibilityHeaders(
  headers: HeaderInput,
): Record<string, string> {
  const nextHeaders = toHeaderRecord(headers)

  // These client-version headers can trigger 466 when upstream deprecates versions.
  delete nextHeaders["x-github-api-version"]
  delete nextHeaders["editor-plugin-version"]
  delete nextHeaders["user-agent"]
  delete nextHeaders["x-vscode-user-agent-library-version"]

  return nextHeaders
}

export async function fetchCopilotWithCompatibilityRetry(
  url: string,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const initial = await fetchWithTimeout(url, options)
  if (initial.status !== 466) return initial

  const compatibilityHeaders = buildCompatibilityHeaders(options.headers)
  consola.warn("Copilot API returned 466, retrying with compatibility headers")

  return fetchWithTimeout(url, {
    ...options,
    headers: compatibilityHeaders,
  })
}
