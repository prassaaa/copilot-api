/**
 * Provider Count Tokens Handler
 * Forwards count_tokens requests to external Anthropic-compatible providers
 */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */

import type { Context } from "hono"

import { getConfig, type ProviderConfig } from "~/lib/config"
import {
  buildProviderUpstreamHeaders,
  createProviderProxyResponse,
  normalizeProviderBaseUrl,
  type ResolvedProviderConfig,
} from "~/services/providers/anthropic-proxy"

/**
 * Get resolved provider config by name
 */
function getProviderConfig(name: string): ResolvedProviderConfig | null {
  const config = getConfig()
  const providers = (config as Record<string, unknown>).providers as
    | Record<string, ProviderConfig>
    | undefined

  if (!providers) return null

  const provider = providers[name]
  if (!provider || !provider.enabled) return null

  return { ...provider, name }
}

/**
 * Handle provider count tokens request
 */
export async function handleProviderCountTokens(c: Context) {
  const providerName = c.req.param("provider")

  if (!providerName) {
    return c.json({ error: { message: "Provider name is required" } }, 400)
  }

  const provider = getProviderConfig(providerName)

  if (!provider) {
    return c.json({ error: { message: "Provider not found or disabled" } }, 404)
  }

  const payload: unknown = await c.req.json()

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl)
  const headers = buildProviderUpstreamHeaders(c, provider)

  const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  return createProviderProxyResponse(response)
}
