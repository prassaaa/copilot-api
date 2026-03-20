/**
 * Reasoning utilities for model effort mapping
 */

import { getReasoningEffortForModel } from "./config"

/**
 * Convert internal reasoning effort to Anthropic API effort format
 * Maps: xhigh → max, none/minimal → low, others stay same
 */
export function getAnthropicEffortForModel(
  model: string,
): "low" | "medium" | "high" | "max" {
  const effort = getReasoningEffortForModel(model)

  if (effort === "xhigh") {
    return "max"
  }

  if (effort === "none" || effort === "minimal") {
    return "low"
  }

  return effort
}

/**
 * Check if a model should use adaptive thinking
 * Based on model capabilities and reasoning effort
 */
export function shouldUseAdaptiveThinking(model: string): boolean {
  const effort = getReasoningEffortForModel(model)
  // Models with high/xhigh effort should use adaptive thinking
  return effort === "high" || effort === "xhigh"
}

/**
 * Get thinking budget based on model and effort
 */
export function getThinkingBudget(
  model: string,
  maxOutputTokens?: number,
): number {
  const effort = getReasoningEffortForModel(model)

  // Default budgets based on effort
  const budgets: Record<string, number> = {
    none: 0,
    minimal: 1024,
    low: 2048,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
  }

  const budget = budgets[effort] ?? 4096

  // Cap at max_output_tokens if provided
  if (maxOutputTokens && budget > maxOutputTokens) {
    return Math.max(1024, maxOutputTokens - 1000)
  }

  return budget
}
