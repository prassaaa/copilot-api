/**
 * Beta Features Filtering
 *
 * Handles parsing and filtering of Anthropic beta feature headers to only
 * include features that are supported by the GitHub Copilot API.
 */

/**
 * Set of supported beta features that can be forwarded to GitHub Copilot API
 */
export const SUPPORTED_BETA_FEATURES = new Set([
  "advanced-tool-use-2025-11-20",
  "interleaved-thinking-2025-05-14",
])

/**
 * Parse beta header string into an array of feature strings
 *
 * @param betaHeader - Raw beta header value (e.g., "feature1,feature2" or "feature1, feature2")
 * @returns Array of trimmed feature strings
 */
function parseBetaHeader(betaHeader: string): Array<string> {
  return betaHeader
    .split(",")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0)
}

/**
 * Filter beta features to only include supported ones
 *
 * @param betaHeader - Raw beta header value from client
 * @returns Comma-separated string of supported features, or undefined if none
 */
export function filterBetaHeader(betaHeader?: string): string | undefined {
  if (!betaHeader || betaHeader.trim().length === 0) {
    return undefined
  }

  const requestedFeatures = parseBetaHeader(betaHeader)
  const supportedFeatures = requestedFeatures.filter((feature) =>
    SUPPORTED_BETA_FEATURES.has(feature),
  )

  if (supportedFeatures.length === 0) {
    return undefined
  }

  return supportedFeatures.join(",")
}

/**
 * Build beta-related headers for GitHub Copilot API request
 *
 * @param betaHeader - Raw beta header value from client request
 * @returns Object with filtered beta headers, or empty object if no supported features
 */
export function buildBetaHeaders(betaHeader?: string): Record<string, string> {
  const filteredBeta = filterBetaHeader(betaHeader)

  if (!filteredBeta) {
    return {}
  }

  return {
    "anthropic-beta": filteredBeta,
  }
}
