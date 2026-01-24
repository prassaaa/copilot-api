/**
 * Request History Module
 * Tracks request history with details
 */

import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface RequestHistoryEntry {
  id: string
  timestamp: number
  type: "chat" | "message" | "embedding"
  model: string
  accountId?: string
  tokens: { input: number; output: number }
  cost: number
  duration: number
  status: "success" | "error" | "cached"
  error?: string
  cached?: boolean
}

export interface RequestHistoryFilter {
  limit?: number
  offset?: number
  model?: string
  status?: "success" | "error" | "cached"
  accountId?: string
  from?: number
  to?: number
}

// File path for history
const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const HISTORY_FILE = path.join(CONFIG_DIR, "request-history.json")

// Configuration
const MAX_ENTRIES = 1000
const RETENTION_DAYS = 7

// In-memory state
let history: Array<RequestHistoryEntry> = []
let isDirty = false

/**
 * Ensure config directory exists
 */
async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch {
    // Directory exists
  }
}

/**
 * Load history from disk
 */
async function loadHistory(): Promise<void> {
  try {
    await ensureDir()
    const data = await fs.readFile(HISTORY_FILE)
    history = JSON.parse(data.toString()) as Array<RequestHistoryEntry>
    pruneHistory()
    consola.debug(`Request history loaded: ${history.length} entries`)
  } catch {
    history = []
    consola.debug("Starting fresh request history")
  }
}

let isSaving = false

function setIsSaving(value: boolean): void {
  isSaving = value
}

/**
 * Save history to disk
 */
async function saveHistory(): Promise<void> {
  if (!isDirty || isSaving) return

  setIsSaving(true)
  isDirty = false
  try {
    await ensureDir()
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2))
    consola.debug("Request history saved")
  } catch (error) {
    // Mark dirty again on failure - use OR to preserve any new dirty state
    isDirty ||= true
    consola.error("Failed to save request history:", error)
  } finally {
    setIsSaving(false)
  }
}

/**
 * Prune old entries
 */
function pruneHistory(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const before = history.length

  // Remove old entries
  history = history.filter((entry) => entry.timestamp > cutoff)

  // Also limit by count
  if (history.length > MAX_ENTRIES) {
    history = history.slice(-MAX_ENTRIES)
  }

  if (history.length < before) {
    isDirty = true
  }
}

/**
 * Generate unique request ID
 */
function generateId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Record a request
 */
export function recordRequest(
  entry: Omit<RequestHistoryEntry, "id" | "timestamp">,
): RequestHistoryEntry {
  const record: RequestHistoryEntry = {
    id: generateId(),
    timestamp: Date.now(),
    ...entry,
  }

  history.push(record)
  isDirty = true

  // Prune if needed
  if (history.length > MAX_ENTRIES) {
    pruneHistory()
  }

  return record
}

/**
 * Get request history with filtering
 */
export function getRequestHistory(filter: RequestHistoryFilter = {}): {
  entries: Array<RequestHistoryEntry>
  total: number
  hasMore: boolean
} {
  let filtered = [...history]

  // Apply filters
  if (filter.model) {
    const modelFilter = filter.model.toLowerCase()
    filtered = filtered.filter((e) =>
      e.model.toLowerCase().includes(modelFilter),
    )
  }

  if (filter.status) {
    filtered = filtered.filter((e) => e.status === filter.status)
  }

  if (filter.accountId) {
    filtered = filtered.filter((e) => e.accountId === filter.accountId)
  }

  if (filter.from) {
    const fromTimestamp = filter.from
    filtered = filtered.filter((e) => e.timestamp >= fromTimestamp)
  }

  if (filter.to) {
    const toTimestamp = filter.to
    filtered = filtered.filter((e) => e.timestamp <= toTimestamp)
  }

  // Sort by timestamp (newest first)
  filtered.sort((a, b) => b.timestamp - a.timestamp)

  const total = filtered.length

  // Apply pagination
  const offset = filter.offset || 0
  const limit = filter.limit || 50

  const entries = filtered.slice(offset, offset + limit)
  const hasMore = offset + limit < total

  return { entries, total, hasMore }
}

/**
 * Get request by ID
 */
export function getRequestById(id: string): RequestHistoryEntry | null {
  return history.find((e) => e.id === id) || null
}

/**
 * Get history statistics
 */
export function getHistoryStats(): {
  total: number
  byStatus: Record<string, number>
  byModel: Record<string, number>
  byAccount: Record<string, number>
  totalTokens: { input: number; output: number }
  totalCost: number
  averageDuration: number
  cacheHitRate: number
} {
  const byStatus: Record<string, number> = { success: 0, error: 0, cached: 0 }
  const byModel: Record<string, number> = {}
  const byAccount: Record<string, number> = {}
  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  let totalDuration = 0
  let cachedCount = 0

  for (const entry of history) {
    // By status
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1

    // By model
    byModel[entry.model] = (byModel[entry.model] || 0) + 1

    // By account
    if (entry.accountId) {
      byAccount[entry.accountId] = (byAccount[entry.accountId] || 0) + 1
    }

    // Tokens
    totalInput += entry.tokens.input
    totalOutput += entry.tokens.output

    // Cost
    totalCost += entry.cost

    // Duration
    totalDuration += entry.duration

    // Cache hits
    if (entry.status === "cached" || entry.cached) {
      cachedCount++
    }
  }

  return {
    total: history.length,
    byStatus,
    byModel,
    byAccount,
    totalTokens: { input: totalInput, output: totalOutput },
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    averageDuration:
      history.length > 0 ? Math.round(totalDuration / history.length) : 0,
    cacheHitRate:
      history.length > 0 ?
        Math.round((cachedCount / history.length) * 100) / 100
      : 0,
  }
}

/**
 * Clear request history
 */
export function clearHistory(): void {
  history = []
  isDirty = true
  consola.info("Request history cleared")
}

/**
 * Delete a specific entry
 */
export function deleteHistoryEntry(id: string): boolean {
  const index = history.findIndex((e) => e.id === id)
  if (index === -1) return false

  history.splice(index, 1)
  isDirty = true
  return true
}

/**
 * Initialize request history module
 */
export async function initRequestHistory(): Promise<void> {
  await loadHistory()

  // Auto-save every 5 minutes
  setInterval(
    () => {
      void saveHistory()
    },
    5 * 60 * 1000,
  )

  // Save on process exit
  process.on("beforeExit", () => {
    void saveHistory()
  })

  consola.debug("Request history module initialized")
}

export const requestHistory = {
  init: initRequestHistory,
  record: recordRequest,
  getHistory: getRequestHistory,
  getById: getRequestById,
  getStats: getHistoryStats,
  clear: clearHistory,
  delete: deleteHistoryEntry,
  save: saveHistory,
}
