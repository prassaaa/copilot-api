import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { PoolConfig, PoolState } from "./account-pool-types"

import { getConfig, saveConfig } from "./config"

const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const POOL_FILE = path.join(CONFIG_DIR, "account-pool.json")

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

export function markPoolStateLoaded(): void {
  poolStateLoaded = true
}

export function isPoolStateLoaded(): boolean {
  return poolStateLoaded
}

export function setPoolState(next: PoolState): void {
  poolState = next
}

export function setPoolConfig(next: PoolConfig): void {
  poolConfig = next
}

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch {
    // Directory exists
  }
}

export async function loadPoolState(): Promise<void> {
  try {
    await ensureDir()
    const data = await fs.readFile(POOL_FILE)
    const saved = JSON.parse(data.toString()) as Partial<PoolState>
    poolState = {
      accounts: saved.accounts ?? [],
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

export async function savePoolState(): Promise<void> {
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
  }
}
