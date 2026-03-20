import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AccountStatus, PoolConfig, PoolState } from "./account-pool-types"

import { getConfig, saveConfig } from "./config"
import { registerShutdownHandler } from "./shutdown"

const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const POOL_FILE = path.join(CONFIG_DIR, "account-pool.json")

// Debounce delay for saving pool state (500ms)
const SAVE_DEBOUNCE_MS = 500

export let poolState: PoolState = {
  accounts: [],
  currentIndex: 0,
}

export let poolConfig: PoolConfig = {
  enabled: false,
  strategy: "sticky",
  accounts: [],
}

let poolStateLoaded = false
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave = false

// Cached active accounts list
let cachedActiveAccounts: Array<AccountStatus> | null = null
let cacheVersion = 0

export function markPoolStateLoaded(): void {
  poolStateLoaded = true
}

export function isPoolStateLoaded(): boolean {
  return poolStateLoaded
}

export function setPoolState(next: PoolState): void {
  poolState = next
  invalidateActiveAccountsCache()
}

export function setPoolConfig(next: PoolConfig): void {
  poolConfig = next
}

/**
 * Invalidate the active accounts cache
 * Call this when account status changes
 */
export function invalidateActiveAccountsCache(): void {
  cachedActiveAccounts = null
  cacheVersion++
}

/**
 * Get active accounts with caching
 * Avoids filtering on every request
 */
export function getActiveAccounts(): Array<AccountStatus> {
  if (cachedActiveAccounts === null) {
    cachedActiveAccounts = poolState.accounts.filter(
      (a) => a.active && !a.rateLimited && a.paused !== true,
    )
  }
  return cachedActiveAccounts
}

/**
 * Get current cache version for checking staleness
 */
export function getCacheVersion(): number {
  return cacheVersion
}

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch (error) {
    // Only ignore EEXIST, log other errors
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      consola.warn("Failed to create account pool directory:", error)
    }
  }
}

export async function loadPoolState(): Promise<void> {
  try {
    await ensureDir()
    const data = await fs.readFile(POOL_FILE)
    const saved = JSON.parse(data.toString()) as Partial<PoolState>

    // Dedupe accounts by id, keeping the first occurrence (which has correct paused state)
    const seenIds = new Set<string>()
    const dedupedAccounts = (saved.accounts ?? []).filter((a) => {
      if (!a.id || seenIds.has(a.id)) return false
      seenIds.add(a.id)
      return true
    })

    const removedCount = (saved.accounts?.length ?? 0) - dedupedAccounts.length
    if (removedCount > 0) {
      consola.warn(
        `loadPoolState: removed ${removedCount} duplicate account(s)`,
      )
    }

    poolState = {
      accounts: dedupedAccounts,
      currentIndex: saved.currentIndex ?? 0,
      stickyAccountId: saved.stickyAccountId,
      lastSelectedId: saved.lastSelectedId,
      lastAutoRotationAt: saved.lastAutoRotationAt,
    }
    if (saved.config) {
      poolConfig.enabled = saved.config.enabled
      poolConfig.strategy = saved.config.strategy
    }
    consola.debug(
      `loadPoolState: loaded ${poolState.accounts.length} accounts from file`,
    )
  } catch {
    // File doesn't exist, use defaults
    consola.debug("loadPoolState: no file found, using defaults")
  }
}

export function savePoolState(): void {
  // Mark that we need to save
  pendingSave = true

  // Clear existing timer if any
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer)
  }

  // Set new timer for debounced save
  saveDebounceTimer = setTimeout(() => {
    if (!pendingSave) return
    pendingSave = false

    void ensureDir()
      .then(() => {
        const stateToSave = {
          ...poolState,
          config: {
            enabled: poolConfig.enabled,
            strategy: poolConfig.strategy,
          },
        }
        return fs.writeFile(POOL_FILE, JSON.stringify(stateToSave, null, 2))
      })
      .catch((error: unknown) => {
        consola.error("Failed to save pool state:", error)
      })
  }, SAVE_DEBOUNCE_MS)
}

/**
 * Force immediate save (for shutdown scenarios)
 */
export async function savePoolStateImmediate(): Promise<void> {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer)
    saveDebounceTimer = null
  }

  try {
    await ensureDir()
    const stateToSave = {
      ...poolState,
      config: {
        enabled: poolConfig.enabled,
        strategy: poolConfig.strategy,
      },
    }
    await fs.writeFile(POOL_FILE, JSON.stringify(stateToSave, null, 2))
    pendingSave = false
  } catch (error) {
    consola.error("Failed to save pool state:", error)
  }
}

/**
 * Sync poolState.accounts to config.json
 * This ensures accounts persist across server restarts
 */
export async function syncAccountsToConfig(): Promise<void> {
  try {
    const config = getConfig()
    const currentTokens = new Set(config.poolAccounts.map((a) => a.token))

    // Get tokens from poolState.accounts (the actual loaded accounts)
    const poolTokens = poolState.accounts.map((a) => ({
      token: a.token,
      label: a.login,
    }))

    // Check if there are any new tokens to add
    const newAccounts = poolTokens.filter((a) => !currentTokens.has(a.token))

    if (newAccounts.length > 0) {
      await saveConfig({
        poolEnabled: poolConfig.enabled,
        poolStrategy: poolConfig.strategy,
        poolAccounts: [...config.poolAccounts, ...newAccounts],
      })
      consola.debug(`Synced ${newAccounts.length} account(s) to config`)
    }
  } catch (error) {
    consola.error("Failed to sync accounts to config:", error)
  }
}

export async function ensurePoolStateLoaded(): Promise<void> {
  if (!poolStateLoaded) {
    await loadPoolState()
    markPoolStateLoaded()

    // Register shutdown handler for immediate save (high priority)
    registerShutdownHandler("account-pool", savePoolStateImmediate, 10)
  }
}
