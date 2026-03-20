import type { Context } from "hono"

import type { ProviderConfig } from "~/lib/config"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

export interface ResolvedProviderConfig extends ProviderConfig {
  name: string
}

const FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
  "accept",
  "user-agent",
] as const

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

/**
 * Normalize provider base URL by removing trailing slash
 */
export function normalizeProviderBaseUrl(url: string): string {
  return url.replace(/\/$/, "")
}

/**
 * Build headers for upstream provider request
 */
export function buildProviderUpstreamHeaders(
  c: Context,
  providerConfig: ResolvedProviderConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": providerConfig.apiKey,
  }

  for (const headerName of FORWARDABLE_HEADERS) {
    const headerValue = c.req.header(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  return headers
}

/**
 * Create clean proxy response from upstream
 */
export function createProviderProxyResponse(
  upstreamResponse: Response,
): Response {
  const headers = new Headers(upstreamResponse.headers)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return new Response(upstreamResponse.body, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

/**
 * Forward messages request to provider
 */
export async function forwardProviderMessages(
  c: Context,
  providerConfig: ResolvedProviderConfig,
  payload: AnthropicMessagesPayload,
): Promise<Response> {
  const baseUrl = normalizeProviderBaseUrl(providerConfig.baseUrl)
  return await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: buildProviderUpstreamHeaders(c, providerConfig),
    body: JSON.stringify(payload),
  })
}

/**
 * Forward models request to provider
 */
export async function forwardProviderModels(
  c: Context,
  providerConfig: ResolvedProviderConfig,
): Promise<Response> {
  const baseUrl = normalizeProviderBaseUrl(providerConfig.baseUrl)
  return await fetch(`${baseUrl}/v1/models`, {
    method: "GET",
    headers: buildProviderUpstreamHeaders(c, providerConfig),
  })
}
