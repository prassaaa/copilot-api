/**
 * Model Fallback System
 * Handles automatic model fallback when primary model fails or is unavailable
 */

import consola from "consola"

import { getConfig } from "./config"
import { state } from "./state"

// Default fallback mappings based on model families
const DEFAULT_FALLBACKS: Record<string, Array<string>> = {
  // Claude models
  "claude-opus-4.6": [
    "claude-opus-4.5",
    "claude-sonnet-4.5",
    "claude-sonnet-4",
  ],
  "claude-opus-4.5": [
    "claude-sonnet-4.5",
    "claude-sonnet-4",
    "claude-haiku-4.5",
  ],
  "claude-sonnet-4.5": ["claude-sonnet-4", "claude-haiku-4.5"],
  "claude-sonnet-4": ["claude-haiku-4.5", "claude-sonnet-4.5"],
  "claude-haiku-4.5": ["claude-sonnet-4", "claude-sonnet-4.5"],

  // GPT models
  "gpt-5": ["gpt-4o", "gpt-4.1", "gpt-4"],
  "gpt-5.1": ["gpt-5", "gpt-4o", "gpt-4.1"],
  "gpt-5.2": ["gpt-5.1", "gpt-5", "gpt-4o"],
  "gpt-4o": ["gpt-4.1", "gpt-4", "gpt-4o-mini"],
  "gpt-4.1": ["gpt-4o", "gpt-4", "gpt-4o-mini"],
  "gpt-4": ["gpt-4o", "gpt-4.1", "gpt-4o-mini"],
  "gpt-4o-mini": ["gpt-3.5-turbo", "gpt-4o"],

  // Gemini models
  "gemini-2.5-pro": ["gemini-3-pro-preview", "gemini-3-flash-preview"],
  "gemini-3-pro-preview": ["gemini-2.5-pro", "gemini-3-flash-preview"],
  "gemini-3-flash-preview": ["gemini-2.5-pro", "gemini-3-pro-preview"],
}

/**
 * Get available fallback models for a given model
 */
export function getFallbackModels(model: string): Array<string> {
  const config = getConfig()

  // Check user-defined mappings first
  const userFallback = config.modelMapping[model]
  if (userFallback) {
    return Array.isArray(userFallback) ? userFallback : [userFallback]
  }

  // Use default fallbacks
  return DEFAULT_FALLBACKS[model] ?? []
}

/**
 * Check if a model is available
 */
export function isModelAvailable(modelId: string): boolean {
  if (!state.models) return false
  return state.models.data.some((m) => m.id === modelId)
}

/**
 * Get the best available fallback model
 */
export function getBestFallback(model: string): string | null {
  const fallbacks = getFallbackModels(model)

  for (const fallback of fallbacks) {
    if (isModelAvailable(fallback)) {
      consola.info(`Model fallback: ${model} → ${fallback}`)
      return fallback
    }
  }

  return null
}

/**
 * Check if fallback is enabled
 */
export function isFallbackEnabled(): boolean {
  const config = getConfig()
  return config.fallbackEnabled || process.env.FALLBACK === "true"
}

/**
 * Apply fallback to payload if needed
 * Returns the potentially modified model ID
 */
export function applyFallback(requestedModel: string): {
  model: string
  didFallback: boolean
  originalModel?: string
} {
  // Check if the requested model is available
  if (isModelAvailable(requestedModel)) {
    return { model: requestedModel, didFallback: false }
  }

  // If fallback is not enabled, return original model
  if (!isFallbackEnabled()) {
    consola.warn(
      `Model ${requestedModel} not available and fallback is disabled`,
    )
    return { model: requestedModel, didFallback: false }
  }

  // Try to find a fallback
  const fallbackModel = getBestFallback(requestedModel)

  if (fallbackModel) {
    return {
      model: fallbackModel,
      didFallback: true,
      originalModel: requestedModel,
    }
  }

  // No fallback available, return original
  consola.warn(`No fallback available for model ${requestedModel}`)
  return { model: requestedModel, didFallback: false }
}
