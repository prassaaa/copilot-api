/**
 * Usage Statistics Module
 * Tracks API usage per model with hourly granularity
 */

import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getConfig } from "./config"
import { registerInterval } from "./intervals"
import { registerShutdownHandler } from "./shutdown"
// Storage path
const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const HISTORY_FILE = path.join(CONFIG_DIR, "usage-history.json")

// In-memory storage
// Structure: Map<dateKey, { model-name: count, _total: count }>
type HourlyStats = Record<string, number>

const history = new Map<string, HourlyStats>()
let isDirty = false

/**
 * Get or create an entry in a Record
 */
function getOrCreate<K extends string, V>(
  record: Record<K, V>,
  key: K,
  defaultValue: V,
): V {
  if (!(key in record)) {
    record[key] = defaultValue
  }
  return record[key]
}

/**
 * Get current hour key
 */
function getCurrentHourKey(): string {
  const now = new Date()
  now.setMinutes(0, 0, 0)
  return now.toISOString()
}

/**
 * Ensure config directory exists
 */
async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch (error) {
    // Only ignore EEXIST, log other errors
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      consola.warn("Failed to create usage stats directory:", error)
    }
  }
}

/**
 * Load usage history from disk
 */
async function load(): Promise<void> {
  try {
    await ensureDir()
    const data = await fs.readFile(HISTORY_FILE)
    const parsed = JSON.parse(data.toString()) as Record<string, HourlyStats>
    history.clear()
    for (const [key, value] of Object.entries(parsed)) {
      history.set(key, value)
    }
    consola.debug("Usage history loaded")
  } catch {
    history.clear()
    consola.debug("Starting fresh usage history")
  }
}

function markDirty(): void {
  isDirty = true
}

function markClean(): void {
  isDirty = false
}

/**
 * Save usage history to disk
 */
async function save(): Promise<void> {
  if (!isDirty) return

  // Mark as clean before async operation to prevent duplicate saves
  markClean()

  try {
    await ensureDir()
    const historyObject = Object.fromEntries(history)
    await fs.writeFile(HISTORY_FILE, JSON.stringify(historyObject, null, 2))
    consola.debug("Usage history saved")
  } catch (error) {
    // Restore dirty flag if save failed
    markDirty()
    consola.error("Failed to save usage history:", error)
  }
}

/**
 * Prune old data (keep last 365 days)
 */
function prune(): void {
  const now = new Date()
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

  let pruned = false
  for (const key of history.keys()) {
    if (new Date(key) < cutoff) {
      history.delete(key)
      pruned = true
    }
  }

  if (pruned) isDirty = true
}

/**
 * Record a request
 */
function recordRequest(model: string): void {
  const config = getConfig()
  if (!config.trackUsage) return

  const hourKey = getCurrentHourKey()

  // Ensure hour entry exists
  let hourData = history.get(hourKey)
  if (!hourData) {
    hourData = { _total: 0 }
    history.set(hourKey, hourData)
  }

  hourData[model] = (hourData[model] || 0) + 1
  hourData._total = (hourData._total || 0) + 1

  isDirty = true
}

/**
 * Get usage statistics for a period
 */
function getStats(period: string = "24h"): {
  totalRequests: number
  byModel: Record<string, number>
  byHour: Array<{ hour: string; count: number }>
} {
  const now = new Date()
  let hoursBack: number

  switch (period) {
    case "1h": {
      hoursBack = 1
      break
    }
    case "6h": {
      hoursBack = 6
      break
    }
    case "12h": {
      hoursBack = 12
      break
    }
    case "24h": {
      hoursBack = 24
      break
    }
    case "7d": {
      hoursBack = 24 * 7
      break
    }
    case "30d": {
      hoursBack = 24 * 30
      break
    }
    default: {
      hoursBack = 24
    }
  }

  const cutoff = new Date(now.getTime() - hoursBack * 60 * 60 * 1000)
  cutoff.setMinutes(0, 0, 0)

  let totalRequests = 0
  const byModel: Record<string, number> = {}
  const byHour: Array<{ hour: string; count: number }> = []

  for (const [hourKey, stats] of history.entries()) {
    const hourDate = new Date(hourKey)
    if (hourDate >= cutoff) {
      totalRequests += stats._total || 0

      byHour.push({
        hour: hourKey,
        count: stats._total || 0,
      })

      for (const [model, count] of Object.entries(stats)) {
        if (model !== "_total") {
          byModel[model] = (byModel[model] || 0) + count
        }
      }
    }
  }

  // Sort by hour
  byHour.sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime())

  return {
    totalRequests,
    byModel,
    byHour,
  }
}

/**
 * Get usage history for N days
 */
function getHistory(days: number = 7): Array<{
  date: string
  total: number
  byModel: Record<string, number>
}> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  const dailyStats: Record<
    string,
    { total: number; byModel: Record<string, number> }
  > = {}

  for (const [hourKey, stats] of history.entries()) {
    const hourDate = new Date(hourKey)
    if (hourDate >= cutoff) {
      const dateKey = hourDate.toISOString().split("T")[0]

      // Ensure daily entry exists
      const dayData = getOrCreate(dailyStats, dateKey, {
        total: 0,
        byModel: {},
      })

      dayData.total += stats._total || 0

      for (const [model, count] of Object.entries(stats)) {
        if (model !== "_total") {
          dayData.byModel[model] = (dayData.byModel[model] || 0) + count
        }
      }
    }
  }

  return Object.entries(dailyStats)
    .map(([date, data]) => ({
      date,
      ...data,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Initialize usage stats module
 */
async function init(): Promise<void> {
  await load()
  prune()

  // Auto-save every 5 minutes
  const intervalId = setInterval(
    () => {
      void save()
    },
    5 * 60 * 1000,
  )
  registerInterval("usage-stats-autosave", intervalId)

  // Register shutdown handler
  registerShutdownHandler("usage-stats", save, 20)
}

export const usageStats = {
  init,
  recordRequest,
  getStats,
  getHistory,
  save,
}
