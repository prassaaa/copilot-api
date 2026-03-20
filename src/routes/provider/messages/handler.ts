/**
 * Provider Messages Handler
 * Forwards messages to external Anthropic-compatible providers
 */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

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
 * Handle provider messages request
 */
export async function handleProviderMessages(c: Context) {
  const providerName = c.req.param("provider")

  if (!providerName) {
    return c.json({ error: { message: "Provider name is required" } }, 400)
  }

  const provider = getProviderConfig(providerName)

  if (!provider) {
    return c.json({ error: { message: "Provider not found or disabled" } }, 404)
  }

  const payload = await c.req.json()

  // Apply model-specific config if exists
  const modelConfig = provider.models?.[payload.model]
  if (modelConfig) {
    if (modelConfig.temperature !== undefined) {
      payload.temperature = modelConfig.temperature
    }
    if (modelConfig.topP !== undefined) {
      payload.top_p = modelConfig.topP
    }
    if (modelConfig.topK !== undefined) {
      payload.top_k = modelConfig.topK
    }
  }

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl)
  const headers = buildProviderUpstreamHeaders(c, provider)

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  return createProviderProxyResponse(response)
}
