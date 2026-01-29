/**
 * Cost Calculator Module
 * Calculates estimated costs based on token usage
 */

import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getConfig } from "./config"
import { registerInterval } from "./intervals"
import { registerShutdownHandler } from "./shutdown"
// Model pricing (per 1M tokens in USD)
export interface ModelPricing {
  model: string
  inputCostPer1M: number
  outputCostPer1M: number
}

export interface CostEstimate {
  model: string
  inputTokens: number
  outputTokens: number
  inputCost: number
  outputCost: number
  totalCost: number
  currency: string
}

export interface CostHistoryEntry {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
}

// Default pricing for common models (estimates based on public pricing)
// These are approximate and should be updated based on actual pricing
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // OpenAI models
  "gpt-4.1": { model: "gpt-4.1", inputCostPer1M: 2.0, outputCostPer1M: 8.0 },
  "gpt-4.1-mini": {
    model: "gpt-4.1-mini",
    inputCostPer1M: 0.4,
    outputCostPer1M: 1.6,
  },
  "gpt-4o": { model: "gpt-4o", inputCostPer1M: 2.5, outputCostPer1M: 10.0 },
  "gpt-4o-mini": {
    model: "gpt-4o-mini",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
  },
  "gpt-4-turbo": {
    model: "gpt-4-turbo",
    inputCostPer1M: 10.0,
    outputCostPer1M: 30.0,
  },
  "gpt-4": { model: "gpt-4", inputCostPer1M: 30.0, outputCostPer1M: 60.0 },
  "gpt-3.5-turbo": {
    model: "gpt-3.5-turbo",
    inputCostPer1M: 0.5,
    outputCostPer1M: 1.5,
  },
  "o1-preview": {
    model: "o1-preview",
    inputCostPer1M: 15.0,
    outputCostPer1M: 60.0,
  },
  "o1-mini": { model: "o1-mini", inputCostPer1M: 3.0, outputCostPer1M: 12.0 },
  "o3-mini": { model: "o3-mini", inputCostPer1M: 1.1, outputCostPer1M: 4.4 },
  // GPT-5 series
  "gpt-5": { model: "gpt-5", inputCostPer1M: 5.0, outputCostPer1M: 15.0 },
  "gpt-5-mini": {
    model: "gpt-5-mini",
    inputCostPer1M: 0.5,
    outputCostPer1M: 1.5,
  },
  "gpt-5.1": { model: "gpt-5.1", inputCostPer1M: 5.0, outputCostPer1M: 15.0 },
  "gpt-5.1-codex": {
    model: "gpt-5.1-codex",
    inputCostPer1M: 5.0,
    outputCostPer1M: 15.0,
  },
  "gpt-5.1-codex-mini": {
    model: "gpt-5.1-codex-mini",
    inputCostPer1M: 1.0,
    outputCostPer1M: 3.0,
  },
  "gpt-5.1-codex-max": {
    model: "gpt-5.1-codex-max",
    inputCostPer1M: 10.0,
    outputCostPer1M: 30.0,
  },
  "gpt-5.2": { model: "gpt-5.2", inputCostPer1M: 5.0, outputCostPer1M: 15.0 },
  "gpt-5.2-codex": {
    model: "gpt-5.2-codex",
    inputCostPer1M: 5.0,
    outputCostPer1M: 15.0,
  },
  "gpt-5-codex": {
    model: "gpt-5-codex",
    inputCostPer1M: 5.0,
    outputCostPer1M: 15.0,
  },

  // Anthropic models (via Copilot)
  "claude-3.5-sonnet": {
    model: "claude-3.5-sonnet",
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  "claude-3-opus": {
    model: "claude-3-opus",
    inputCostPer1M: 15.0,
    outputCostPer1M: 75.0,
  },
  "claude-3-sonnet": {
    model: "claude-3-sonnet",
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  "claude-3-haiku": {
    model: "claude-3-haiku",
    inputCostPer1M: 0.25,
    outputCostPer1M: 1.25,
  },
  // Claude 4 series
  "claude-sonnet-4": {
    model: "claude-sonnet-4",
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  "claude-sonnet-4.5": {
    model: "claude-sonnet-4.5",
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  "claude-opus-4.5": {
    model: "claude-opus-4.5",
    inputCostPer1M: 15.0,
    outputCostPer1M: 75.0,
  },
  "claude-haiku-4.5": {
    model: "claude-haiku-4.5",
    inputCostPer1M: 0.8,
    outputCostPer1M: 4.0,
  },

  // Google models
  "gemini-2.0-flash": {
    model: "gemini-2.0-flash",
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.4,
  },
  "gemini-1.5-pro": {
    model: "gemini-1.5-pro",
    inputCostPer1M: 1.25,
    outputCostPer1M: 5.0,
  },
  "gemini-1.5-flash": {
    model: "gemini-1.5-flash",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.3,
  },
  // Gemini 2.5/3 series
  "gemini-2.5-pro": {
    model: "gemini-2.5-pro",
    inputCostPer1M: 1.25,
    outputCostPer1M: 5.0,
  },
  "gemini-3-pro": {
    model: "gemini-3-pro",
    inputCostPer1M: 1.25,
    outputCostPer1M: 5.0,
  },
  "gemini-3-flash": {
    model: "gemini-3-flash",
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.4,
  },

  // xAI models
  "grok-code-fast-1": {
    model: "grok-code-fast-1",
    inputCostPer1M: 5.0,
    outputCostPer1M: 15.0,
  },

  // Embedding models
  "text-embedding-3-small": {
    model: "text-embedding-3-small",
    inputCostPer1M: 0.02,
    outputCostPer1M: 0,
  },
  "text-embedding-3-large": {
    model: "text-embedding-3-large",
    inputCostPer1M: 0.13,
    outputCostPer1M: 0,
  },
}

// File path for cost history
const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const COST_HISTORY_FILE = path.join(CONFIG_DIR, "cost-history.json")

// In-memory state
let customPricing: Record<string, ModelPricing> = {}
let costHistory: Array<CostHistoryEntry> = []
let isDirty = false

// Retention settings
const MAX_HISTORY_ENTRIES = 10000
const HISTORY_RETENTION_DAYS = 30

/**
 * Ensure config directory exists
 */
async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch (error) {
    // Only ignore EEXIST, log other errors
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      consola.warn("Failed to create cost history directory:", error)
    }
  }
}

/**
 * Load cost history from disk
 */
async function loadHistory(): Promise<void> {
  try {
    await ensureDir()
    const data = await fs.readFile(COST_HISTORY_FILE)
    const parsed = JSON.parse(data.toString()) as {
      history?: Array<CostHistoryEntry>
      customPricing?: Record<string, ModelPricing>
    }
    costHistory = parsed.history ?? []
    customPricing = parsed.customPricing ?? {}
    pruneHistory()
    consola.debug("Cost history loaded")
  } catch {
    costHistory = []
    customPricing = {}
    consola.debug("Starting fresh cost history")
  }
}

/**
 * Save cost history to disk
 */
async function saveHistory(): Promise<void> {
  if (!isDirty) return
  isDirty = false
  try {
    await ensureDir()
    await fs.writeFile(
      COST_HISTORY_FILE,
      JSON.stringify({ history: costHistory, customPricing }, null, 2),
    )
    consola.debug("Cost history saved")
  } catch (error) {
    markDirty()
    consola.error("Failed to save cost history:", error)
  }
}

function markDirty(): void {
  isDirty = true
}

/**
 * Prune old history entries
 */
function pruneHistory(): void {
  const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const before = costHistory.length
  costHistory = costHistory.filter((entry) => entry.timestamp > cutoff)

  // Also limit by count
  if (costHistory.length > MAX_HISTORY_ENTRIES) {
    costHistory = costHistory.slice(-MAX_HISTORY_ENTRIES)
  }

  if (costHistory.length < before) {
    isDirty = true
  }
}

/**
 * Get pricing for a model
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Check custom pricing first
  if (model in customPricing) {
    return customPricing[model]
  }

  // Check default pricing
  if (model in DEFAULT_PRICING) {
    return DEFAULT_PRICING[model]
  }

  // Try to find a matching prefix
  for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (model.toLowerCase().includes(key.toLowerCase())) {
      return pricing
    }
  }

  return null
}

/**
 * Calculate cost estimate
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const pricing = getModelPricing(model)

  if (!pricing) {
    return {
      model,
      inputTokens,
      outputTokens,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      currency: "USD",
    }
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M

  return {
    model,
    inputTokens,
    outputTokens,
    inputCost: Math.round(inputCost * 1_000_000) / 1_000_000, // Round to 6 decimal places
    outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
    totalCost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    currency: "USD",
  }
}

/**
 * Record a cost entry
 */
export function recordCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const config = getConfig()
  if (!config.trackCost) {
    return {
      model,
      inputTokens,
      outputTokens,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      currency: "USD",
    }
  }

  const estimate = calculateCost(model, inputTokens, outputTokens)

  costHistory.push({
    timestamp: Date.now(),
    model,
    inputTokens,
    outputTokens,
    cost: estimate.totalCost,
  })

  isDirty = true

  // Prune if needed
  if (costHistory.length > MAX_HISTORY_ENTRIES) {
    pruneHistory()
  }

  return estimate
}

/**
 * Get cost history for a period
 */
export function getCostHistory(days: number = 7): {
  entries: Array<CostHistoryEntry>
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  byModel: Record<
    string,
    { cost: number; inputTokens: number; outputTokens: number }
  >
  byDay: Array<{ date: string; cost: number; requests: number }>
} {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const entries = costHistory.filter((e) => e.timestamp > cutoff)

  let totalCost = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const byModel: Record<
    string,
    { cost: number; inputTokens: number; outputTokens: number }
  > = {}
  const dailyData: Record<string, { cost: number; requests: number }> = {}

  for (const entry of entries) {
    totalCost += entry.cost
    totalInputTokens += entry.inputTokens
    totalOutputTokens += entry.outputTokens

    // By model
    const modelData = byModel[entry.model] ?? {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    modelData.cost += entry.cost
    modelData.inputTokens += entry.inputTokens
    modelData.outputTokens += entry.outputTokens
    byModel[entry.model] = modelData

    // By day
    const date = new Date(entry.timestamp).toISOString().split("T")[0]
    const dayData = dailyData[date] ?? { cost: 0, requests: 0 }
    dayData.cost += entry.cost
    dayData.requests++
    dailyData[date] = dayData
  }

  const byDay = Object.entries(dailyData)
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    entries,
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    totalInputTokens,
    totalOutputTokens,
    byModel,
    byDay,
  }
}

/**
 * Set custom pricing for a model
 */
export function setModelPricing(pricing: ModelPricing): void {
  customPricing[pricing.model] = pricing
  isDirty = true
}

/**
 * Get all available pricing
 */
export function getAllPricing(): Record<string, ModelPricing> {
  return { ...DEFAULT_PRICING, ...customPricing }
}

/**
 * Clear cost history
 */
export function clearCostHistory(): void {
  costHistory = []
  isDirty = true
}

/**
 * Initialize cost calculator module
 */
export async function initCostCalculator(): Promise<void> {
  await loadHistory()

  // Auto-save every 5 minutes
  const intervalId = setInterval(
    () => {
      void saveHistory()
    },
    5 * 60 * 1000,
  )
  registerInterval("cost-calculator-autosave", intervalId)

  // Register shutdown handler
  registerShutdownHandler("cost-calculator", saveHistory, 20)

  consola.debug("Cost calculator initialized")
}

export const costCalculator = {
  init: initCostCalculator,
  calculate: calculateCost,
  record: recordCost,
  getHistory: getCostHistory,
  getPricing: getModelPricing,
  getAllPricing,
  setPricing: setModelPricing,
  clearHistory: clearCostHistory,
  save: saveHistory,
}
