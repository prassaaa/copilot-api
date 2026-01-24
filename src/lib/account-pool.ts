/**
 * Multi-Account Pool Management
 * Manages multiple GitHub tokens with selection strategies
 */

import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsageForAccount } from "~/services/github/get-copilot-usage"
import { getGitHubUser } from "~/services/github/get-user"

// Selection strategies
export type SelectionStrategy =
  | "sticky"
  | "round-robin"
  | "hybrid"
  | "quota-based"

// Quota info per account
export interface AccountQuota {
  chat: {
    remaining: number
    entitlement: number
    percentRemaining: number
    unlimited: boolean
  }
  completions: {
    remaining: number
    entitlement: number
    percentRemaining: number
    unlimited: boolean
  }
  premiumInteractions: {
    remaining: number
    entitlement: number
    percentRemaining: number
    unlimited: boolean
  }
  resetDate?: string
  lastFetched?: number
}

// Account status
export interface AccountStatus {
  id: string
  login: string
  token: string // GitHub access token
  copilotToken?: string // Copilot API token
  copilotTokenExpires?: number
  lastUsed?: number
  requestCount: number
  errorCount: number
  lastError?: string
  rateLimited: boolean
  rateLimitResetAt?: number
  active: boolean
  paused?: boolean // User manually paused the account
  pausedReason?: "manual" | "quota" // Why the account is paused
  quota?: AccountQuota // Quota information
}

// Pool configuration
export interface PoolConfig {
  enabled: boolean
  strategy: SelectionStrategy
  accounts: Array<{ token: string; label?: string }>
}

// Pool state
interface PoolState {
  accounts: Array<AccountStatus>
  currentIndex: number
  stickyAccountId?: string
  lastSelectedId?: string
  // Pool config is now stored with state
  config?: {
    enabled: boolean
    strategy: SelectionStrategy
  }
}

// File paths
const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const POOL_FILE = path.join(CONFIG_DIR, "account-pool.json")

// In-memory state
let poolState: PoolState = {
  accounts: [],
  currentIndex: 0,
}

let poolConfig: PoolConfig = {
  enabled: false,
  strategy: "sticky",
  accounts: [],
}

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
 * Load pool state from file
 */
async function loadPoolState(): Promise<void> {
  try {
    await ensureDir()
    const data = await fs.readFile(POOL_FILE)
    const saved = JSON.parse(data.toString()) as Partial<PoolState>
    poolState = {
      accounts: saved.accounts ?? [],
      currentIndex: saved.currentIndex ?? 0,
      stickyAccountId: saved.stickyAccountId,
      lastSelectedId: saved.lastSelectedId,
    }
    // Load config from saved state
    if (saved.config) {
      poolConfig.enabled = saved.config.enabled
      poolConfig.strategy = saved.config.strategy
    }
  } catch {
    // File doesn't exist, use defaults
  }
}

/**
 * Save pool state to file
 */
async function savePoolState(): Promise<void> {
  try {
    await ensureDir()
    // Include config in saved state
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
 * Initialize an account from a GitHub token
 */
async function initializeAccount(
  token: string,
  label?: string,
): Promise<AccountStatus | null> {
  try {
    // Get user info
    const user = await getGitHubUser(token)

    const account: AccountStatus = {
      id: user.login,
      login: label ?? user.login,
      token,
      requestCount: 0,
      errorCount: 0,
      rateLimited: false,
      active: true,
    }

    // Try to get Copilot token
    try {
      const copilot = await getCopilotToken(token)
      account.copilotToken = copilot.token
      account.copilotTokenExpires = Date.now() + copilot.refresh_in * 1000
    } catch (error) {
      consola.warn(`Account ${account.login} has no Copilot access:`, error)
      account.active = false
      account.lastError = "No Copilot access"
    }

    return account
  } catch (error) {
    consola.error(`Failed to initialize account:`, error)
    return null
  }
}

/**
 * Ensure pool state is loaded (called on first access)
 */
let poolStateLoaded = false
function markPoolStateLoaded(): void {
  poolStateLoaded = true
}

async function ensurePoolStateLoaded(): Promise<void> {
  if (!poolStateLoaded) {
    await loadPoolState()
    markPoolStateLoaded()
  }
}

/**
 * Initialize the account pool
 */
export async function initializePool(config: PoolConfig): Promise<void> {
  // Load saved state first
  await loadPoolState()
  markPoolStateLoaded()

  // Merge config - saved config takes precedence for enabled/strategy
  const savedEnabled = poolConfig.enabled
  const savedStrategy = poolConfig.strategy

  poolConfig = {
    ...config,
    enabled: savedEnabled || config.enabled,
    strategy: savedStrategy !== "sticky" ? savedStrategy : config.strategy,
  }

  if (!poolConfig.enabled || config.accounts.length === 0) {
    consola.debug("Account pool disabled or empty")
    return
  }

  consola.info(
    `Initializing account pool with ${config.accounts.length} accounts...`,
  )

  // Initialize each account
  const newAccounts: Array<AccountStatus> = []

  for (const acc of config.accounts) {
    // Check if already initialized
    const existing = poolState.accounts.find((a) => a.token === acc.token)

    if (existing) {
      // Refresh Copilot token if expired
      if (
        !existing.copilotTokenExpires
        || Date.now() > existing.copilotTokenExpires - 60000
      ) {
        try {
          const copilot = await getCopilotToken(existing.token)
          existing.copilotToken = copilot.token
          existing.copilotTokenExpires = Date.now() + copilot.refresh_in * 1000
          existing.active = true
          existing.rateLimited = false
        } catch {
          existing.active = false
        }
      }
      newAccounts.push(existing)
    } else {
      const account = await initializeAccount(acc.token, acc.label)
      if (account) {
        newAccounts.push(account)
      }
    }
  }

  // Assign all at once to avoid race condition
  poolState = {
    ...poolState,
    accounts: newAccounts,
  }
  await savePoolState()

  const activeCount = newAccounts.filter((a) => a.active).length
  consola.success(
    `Account pool initialized: ${activeCount}/${newAccounts.length} active`,
  )
}

/**
 * Reset expired rate limits and return first available account
 */
function resetExpiredRateLimits(): AccountStatus | null {
  const now = Date.now()
  for (const account of poolState.accounts) {
    if (
      account.rateLimited
      && account.rateLimitResetAt
      && account.rateLimitResetAt <= now
      && !account.paused
    ) {
      account.rateLimited = false
      account.rateLimitResetAt = undefined
      if (account.active) {
        return account
      }
    }
  }
  return null
}

/**
 * Select account based on sticky strategy
 */
function selectStickyAccount(
  activeAccounts: Array<AccountStatus>,
): AccountStatus {
  if (poolState.stickyAccountId) {
    const sticky = activeAccounts.find(
      (a) => a.id === poolState.stickyAccountId,
    )
    if (sticky) return sticky
  }
  const selected = activeAccounts[0]
  poolState.stickyAccountId = selected.id
  return selected
}

/**
 * Select account based on round-robin strategy
 */
function selectRoundRobinAccount(
  activeAccounts: Array<AccountStatus>,
): AccountStatus {
  const index = poolState.currentIndex % activeAccounts.length
  poolState.currentIndex = (poolState.currentIndex + 1) % activeAccounts.length
  return activeAccounts[index]
}

/**
 * Get the next account based on strategy
 */
export function selectAccount(): AccountStatus | null {
  if (!poolConfig.enabled || poolState.accounts.length === 0) {
    return null
  }

  const activeAccounts = poolState.accounts.filter(
    (a) => a.active && !a.rateLimited && !a.paused,
  )

  if (activeAccounts.length === 0) {
    const resetAccount = resetExpiredRateLimits()
    if (resetAccount) {
      poolState.lastSelectedId = resetAccount.id
      return resetAccount
    }

    consola.warn("No active accounts available in pool")
    return null
  }

  let selected: AccountStatus

  switch (poolConfig.strategy) {
    case "sticky": {
      selected = selectStickyAccount(activeAccounts)
      break
    }

    case "round-robin": {
      selected = selectRoundRobinAccount(activeAccounts)
      break
    }

    case "quota-based": {
      selected = selectByQuota(activeAccounts)
      break
    }

    case "hybrid": {
      // Sticky but rotate on error
      if (poolState.stickyAccountId) {
        const sticky = activeAccounts.find(
          (a) => a.id === poolState.stickyAccountId,
        )
        if (sticky) {
          selected = sticky
          break
        }
      }
      const nextAccount =
        activeAccounts[poolState.currentIndex % activeAccounts.length]
      poolState.stickyAccountId = nextAccount.id
      selected = nextAccount
      break
    }

    default: {
      selected = activeAccounts[0]
      break
    }
  }

  poolState.lastSelectedId = selected.id
  return selected
}

/**
 * Get Copilot token for a request
 * Returns the token from the selected account
 */
export async function getPooledCopilotToken(): Promise<string | null> {
  // Check for monthly reset first
  await checkMonthlyReset()

  const account = selectAccount()
  if (!account) return null

  // Refresh token if needed
  if (
    !account.copilotToken
    || !account.copilotTokenExpires
    || Date.now() > account.copilotTokenExpires - 60000
  ) {
    try {
      const copilot = await getCopilotToken(account.token)
      account.copilotToken = copilot.token
      account.copilotTokenExpires = Date.now() + copilot.refresh_in * 1000
      await savePoolState()
    } catch (error) {
      consola.error(`Failed to refresh token for ${account.login}:`, error)
      account.active = false
      account.lastError = String(error)
      await savePoolState()
      // Try next account
      return getPooledCopilotToken()
    }
  }

  // Refresh quota if needed (async, don't block request)
  if (needsQuotaRefresh(account)) {
    void fetchAccountQuota(account).then(() => {
      void checkAndAutoPauseAccounts()
      void savePoolState()
    })
  }

  const isFirstUse = !account.lastUsed
  account.lastUsed = Date.now()
  account.requestCount++

  // Save state on first use or periodically (every 10 requests) to avoid too many writes
  if (isFirstUse || account.requestCount % 10 === 0) {
    void savePoolState()
  }

  return account.copilotToken
}

/**
 * Send notifications for rate limit event
 */
async function notifyRateLimit(
  accountLogin: string,
  resetAt: number,
): Promise<void> {
  try {
    const { webhook } = await import("./webhook")
    await webhook.sendRateLimit(accountLogin, resetAt)
  } catch {
    // Webhook not initialized
  }

  try {
    const { notificationCenter } = await import("./notification-center")
    notificationCenter.rateLimit(accountLogin, resetAt)
  } catch {
    // Notification center not initialized
  }
}

/**
 * Send notifications for auth error event
 */
async function notifyAuthError(accountLogin: string): Promise<void> {
  try {
    const { webhook } = await import("./webhook")
    await webhook.sendAccountError(accountLogin, "Authentication failed")
  } catch {
    // Webhook not initialized
  }

  try {
    const { notificationCenter } = await import("./notification-center")
    notificationCenter.accountError(accountLogin, "Authentication failed")
  } catch {
    // Notification center not initialized
  }
}

/**
 * Send notifications for account rotation event
 */
async function notifyAccountRotation(
  fromAccount: string,
  toAccount: string,
  reason: string,
): Promise<void> {
  try {
    const { webhook } = await import("./webhook")
    await webhook.sendAccountRotation(fromAccount, toAccount, reason)
  } catch {
    // Webhook not initialized
  }

  try {
    const { notificationCenter } = await import("./notification-center")
    notificationCenter.accountRotation(fromAccount, toAccount, reason)
  } catch {
    // Notification center not initialized
  }
}

/**
 * Check if auto-rotation should be triggered
 */
function shouldAutoRotate(
  errorType: "rate-limit" | "auth" | "other",
  errorCount: number,
  config: {
    autoRotationEnabled?: boolean
    autoRotationTriggers?: { errorCount?: number }
  },
): boolean {
  if (!config.autoRotationEnabled) return false
  if (errorType === "rate-limit") return true
  if (errorType === "other") {
    const threshold = config.autoRotationTriggers?.errorCount ?? 3
    return errorCount >= threshold
  }
  return false
}

/**
 * Report an error for the current account
 */
export async function reportAccountError(
  errorType: "rate-limit" | "auth" | "other",
  resetAt?: number,
): Promise<void> {
  const account = selectAccount()
  if (!account) return

  const previousAccount = account.login
  account.errorCount++
  account.lastError = errorType

  if (errorType === "rate-limit") {
    account.rateLimited = true
    account.rateLimitResetAt = resetAt ?? Date.now() + 60000
    consola.warn(
      `Account ${account.login} rate limited until ${new Date(account.rateLimitResetAt).toISOString()}`,
    )
    await notifyRateLimit(account.login, account.rateLimitResetAt)
  } else if (errorType === "auth") {
    account.active = false
    consola.error(`Account ${account.login} auth failed, deactivating`)
    await notifyAuthError(account.login)
  }

  // Auto-rotate to next account based on config
  const config = await import("./config").then((m) => m.getConfig())
  const doRotate =
    shouldAutoRotate(errorType, account.errorCount, config)
    || poolConfig.strategy === "hybrid"

  if (doRotate) {
    const nextAccount = findNextAvailableAccount(account.id)
    if (nextAccount) {
      poolState.stickyAccountId = nextAccount.id
      poolState.currentIndex = poolState.accounts.findIndex(
        (a) => a.id === nextAccount.id,
      )

      consola.info(
        `Auto-rotated from ${previousAccount} to ${nextAccount.login}`,
      )

      await notifyAccountRotation(previousAccount, nextAccount.login, errorType)
    } else {
      poolState.stickyAccountId = undefined
      poolState.currentIndex++
    }
  }

  await savePoolState()
}

/**
 * Find next available account (for rotation)
 */
function findNextAvailableAccount(excludeId: string): AccountStatus | null {
  const availableAccounts = poolState.accounts.filter(
    (a) => a.id !== excludeId && a.active && !a.rateLimited && !a.paused,
  )

  if (availableAccounts.length === 0) return null

  // Use quota-based selection for auto-rotation
  return availableAccounts.reduce((best, current) => {
    const bestQuota = getEffectiveQuotaPercent(best)
    const currentQuota = getEffectiveQuotaPercent(current)
    return currentQuota > bestQuota ? current : best
  })
}

/**
 * Add a new account to the pool
 */
export async function addAccount(
  token: string,
  label?: string,
): Promise<AccountStatus | null> {
  await ensurePoolStateLoaded()

  // Check if already exists
  if (poolState.accounts.some((a) => a.token === token)) {
    consola.warn("Account already in pool")
    return null
  }

  const account = await initializeAccount(token, label)
  if (account) {
    poolState.accounts.push(account)
    poolConfig.accounts.push({ token, label })

    // Auto-enable pool when account is added
    if (!poolConfig.enabled) {
      poolConfig.enabled = true
      consola.info("Account pool auto-enabled")
    }

    await savePoolState()
    consola.success(`Account ${account.login} added to pool`)
  }

  return account
}

/**
 * Add the initial/primary account to the pool (called at startup)
 * This ensures the first logged-in account is part of the pool
 */
export async function addInitialAccount(
  token: string,
  userInfo: { login: string; id: number; name?: string; avatar_url?: string },
): Promise<AccountStatus | null> {
  await ensurePoolStateLoaded()

  // Check if already exists
  const existingAccount = poolState.accounts.find((a) => a.token === token)
  if (existingAccount) {
    consola.debug("Initial account already in pool")
    // Sync sticky account to the logged-in account
    // This ensures the account shown at startup matches the active account
    if (poolState.stickyAccountId !== existingAccount.id) {
      poolState.stickyAccountId = existingAccount.id
      await savePoolState()
      consola.info(`Switched active account to ${existingAccount.login}`)
    }
    return existingAccount
  }

  // Create account status directly since we already have user info
  const account: AccountStatus = {
    id: userInfo.login,
    login: userInfo.login,
    token,
    requestCount: 0,
    errorCount: 0,
    rateLimited: false,
    active: true,
  }

  // Try to get Copilot token
  try {
    const copilot = await getCopilotToken(token)
    account.copilotToken = copilot.token
    account.copilotTokenExpires = Date.now() + copilot.refresh_in * 1000
  } catch (error) {
    consola.warn(
      `Initial account ${account.login} has no Copilot access:`,
      error,
    )
    account.active = false
    account.lastError = "No Copilot access"
  }

  poolState.accounts.unshift(account) // Add to beginning
  poolConfig.accounts.unshift({ token, label: userInfo.login })

  // Set as sticky account so it becomes the active account
  poolState.stickyAccountId = account.id

  // Auto-enable pool when first account is added
  if (!poolConfig.enabled) {
    poolConfig.enabled = true
    consola.info("Account pool auto-enabled")
  }

  await savePoolState()
  consola.success(`Initial account ${account.login} added to pool`)

  return account
}

/**
 * Remove an account from the pool
 * Returns the removed account's token for config sync, or null if not found
 */
export async function removeAccount(
  id: string,
): Promise<{ removed: boolean; token?: string }> {
  const index = poolState.accounts.findIndex((a) => a.id === id)
  if (index === -1) return { removed: false }

  const account = poolState.accounts[index]
  const token = account.token
  poolState.accounts.splice(index, 1)
  poolConfig.accounts = poolConfig.accounts.filter(
    (a) => a.token !== account.token,
  )

  if (poolState.stickyAccountId === id) {
    poolState.stickyAccountId = undefined
  }

  await savePoolState()
  consola.info(`Account ${id} removed from pool`)
  return { removed: true, token }
}

/**
 * Get all accounts status (sanitized - no tokens)
 */
export async function getAccountsStatus(): Promise<
  Array<Omit<AccountStatus, "token" | "copilotToken">>
> {
  await ensurePoolStateLoaded()
  return poolState.accounts.map((a) => ({
    id: a.id,
    login: a.login,
    lastUsed: a.lastUsed,
    requestCount: a.requestCount,
    errorCount: a.errorCount,
    lastError: a.lastError,
    rateLimited: a.rateLimited,
    rateLimitResetAt: a.rateLimitResetAt,
    active: a.active,
    paused: a.paused ?? false,
    pausedReason: a.pausedReason,
    quota: a.quota,
  }))
}

/**
 * Pause or unpause an account
 */
export async function toggleAccountPause(
  id: string,
  paused: boolean,
): Promise<{ success: boolean; paused?: boolean }> {
  await ensurePoolStateLoaded()
  const account = poolState.accounts.find((a) => a.id === id)
  if (!account) return { success: false }

  account.paused = paused
  account.pausedReason = paused ? "manual" : undefined
  await savePoolState()
  consola.info(`Account ${id} ${paused ? "paused" : "resumed"}`)
  return { success: true, paused: account.paused }
}

/**
 * Get pool configuration
 */
export async function getPoolConfig(): Promise<PoolConfig> {
  await ensurePoolStateLoaded()
  return {
    ...poolConfig,
    accounts: poolConfig.accounts.map((a) => ({
      token: "***",
      label: a.label,
    })),
  }
}

/**
 * Update pool configuration
 */
export async function updatePoolConfig(
  updates: Partial<Pick<PoolConfig, "enabled" | "strategy">>,
): Promise<void> {
  await ensurePoolStateLoaded()
  if (updates.enabled !== undefined) {
    poolConfig.enabled = updates.enabled
  }
  if (updates.strategy !== undefined) {
    poolConfig.strategy = updates.strategy
  }
  await savePoolState()
}

/**
 * Check if pool is enabled and has accounts
 */
export async function isPoolEnabled(): Promise<boolean> {
  await ensurePoolStateLoaded()
  return poolConfig.enabled && poolState.accounts.length > 0
}

/**
 * Check if pool is enabled (sync version for internal use)
 */
export function isPoolEnabledSync(): boolean {
  return poolConfig.enabled && poolState.accounts.length > 0
}

/**
 * Get current account (for status display)
 */
export function getCurrentAccount(): AccountStatus | null {
  const activeAccounts = poolState.accounts.filter(
    (a) => a.active && !a.rateLimited && !a.paused,
  )

  if (activeAccounts.length === 0) return null

  if (poolState.lastSelectedId) {
    const lastSelected = activeAccounts.find(
      (a) => a.id === poolState.lastSelectedId,
    )
    if (lastSelected) return lastSelected
  }

  if (poolState.stickyAccountId) {
    const sticky = activeAccounts.find(
      (a) => a.id === poolState.stickyAccountId,
    )
    if (sticky) return sticky
  }

  return activeAccounts[0]
}

/**
 * Refresh all account tokens
 */
export async function refreshAllTokens(): Promise<void> {
  for (const account of poolState.accounts) {
    try {
      const copilot = await getCopilotToken(account.token)
      account.copilotToken = copilot.token
      account.copilotTokenExpires = Date.now() + copilot.refresh_in * 1000
      account.active = true
      account.rateLimited = false
      account.errorCount = 0
    } catch (error) {
      account.active = false
      account.lastError = String(error)
    }
  }
  await savePoolState()
}

// Quota management configuration
const QUOTA_THRESHOLD_PERCENT = 5 // Pause account when quota is below this percentage
const QUOTA_REFRESH_INTERVAL = 5 * 60 * 1000 // Refresh quota every 5 minutes

/**
 * Fetch and update quota for a specific account
 */
export async function fetchAccountQuota(
  account: AccountStatus,
): Promise<AccountQuota | null> {
  try {
    const usage = await getCopilotUsageForAccount(account.token)
    const quota: AccountQuota = {
      chat: {
        remaining: usage.quota_snapshots.chat.quota_remaining,
        entitlement: usage.quota_snapshots.chat.entitlement,
        percentRemaining: usage.quota_snapshots.chat.percent_remaining,
        unlimited: usage.quota_snapshots.chat.unlimited,
      },
      completions: {
        remaining: usage.quota_snapshots.completions.quota_remaining,
        entitlement: usage.quota_snapshots.completions.entitlement,
        percentRemaining: usage.quota_snapshots.completions.percent_remaining,
        unlimited: usage.quota_snapshots.completions.unlimited,
      },
      premiumInteractions: {
        remaining: usage.quota_snapshots.premium_interactions.quota_remaining,
        entitlement: usage.quota_snapshots.premium_interactions.entitlement,
        percentRemaining:
          usage.quota_snapshots.premium_interactions.percent_remaining,
        unlimited: usage.quota_snapshots.premium_interactions.unlimited,
      },
      resetDate: usage.quota_reset_date,
      lastFetched: Date.now(),
    }
    // Find the account in poolState to update (avoid race condition)
    const poolAccount = poolState.accounts.find((a) => a.id === account.id)
    if (poolAccount) {
      poolAccount.quota = quota
    }
    return quota
  } catch (error) {
    consola.warn(`Failed to fetch quota for ${account.login}:`, error)
    return null
  }
}

/**
 * Refresh quota for all accounts
 */
export async function refreshAllQuotas(): Promise<void> {
  consola.info("Refreshing quota for all accounts...")
  for (const account of poolState.accounts) {
    await fetchAccountQuota(account)
  }
  await savePoolState()
  consola.success("Quota refreshed for all accounts")
}

/**
 * Check if quota needs refresh (older than QUOTA_REFRESH_INTERVAL)
 */
function needsQuotaRefresh(account: AccountStatus): boolean {
  if (!account.quota?.lastFetched) return true
  return Date.now() - account.quota.lastFetched > QUOTA_REFRESH_INTERVAL
}

/**
 * Get the effective quota percentage (minimum of chat and premium)
 * This is used for selection and auto-pause decisions
 */
function getEffectiveQuotaPercent(account: AccountStatus): number {
  if (!account.quota) return 100 // Assume full if no quota info
  if (
    account.quota.chat.unlimited
    && account.quota.premiumInteractions.unlimited
  ) {
    return 100
  }
  // Use the lower of chat and premium interactions
  const chatPercent =
    account.quota.chat.unlimited ? 100 : account.quota.chat.percentRemaining
  const premiumPercent =
    account.quota.premiumInteractions.unlimited ?
      100
    : account.quota.premiumInteractions.percentRemaining
  return Math.min(chatPercent, premiumPercent)
}

/**
 * Check and auto-pause accounts with low quota
 */
export async function checkAndAutoPauseAccounts(): Promise<void> {
  let changed = false
  for (const account of poolState.accounts) {
    if (account.paused && account.pausedReason === "manual") {
      continue // Don't touch manually paused accounts
    }

    const quotaPercent = getEffectiveQuotaPercent(account)
    if (quotaPercent <= QUOTA_THRESHOLD_PERCENT && !account.paused) {
      account.paused = true
      account.pausedReason = "quota"
      consola.warn(
        `Account ${account.login} auto-paused: quota at ${quotaPercent.toFixed(1)}%`,
      )
      changed = true
    } else if (
      quotaPercent > QUOTA_THRESHOLD_PERCENT
      && account.pausedReason === "quota"
    ) {
      // Reactivate if quota recovered (shouldn't normally happen mid-month)
      account.paused = false
      account.pausedReason = undefined
      consola.info(`Account ${account.login} reactivated: quota recovered`)
      changed = true
    }
  }
  if (changed) {
    await savePoolState()
  }
}

/**
 * Check if we're in a new month and reactivate quota-paused accounts
 */
let lastMonthCheck: number | null = null

export async function checkMonthlyReset(): Promise<void> {
  const now = new Date()
  const currentMonth = now.getFullYear() * 12 + now.getMonth()

  if (lastMonthCheck === null) {
    lastMonthCheck = currentMonth
    return
  }

  if (currentMonth > lastMonthCheck) {
    consola.info("New month detected! Reactivating quota-paused accounts...")
    lastMonthCheck = currentMonth

    let changed = false
    for (const account of poolState.accounts) {
      if (account.paused && account.pausedReason === "quota") {
        account.paused = false
        account.pausedReason = undefined
        account.quota = undefined // Clear old quota, will be refreshed
        consola.success(`Account ${account.login} reactivated for new month`)
        changed = true
      }
    }

    if (changed) {
      await savePoolState()
      // Refresh quota for all accounts
      await refreshAllQuotas()
    }
  }
}

/**
 * Select account based on highest quota (smart selection)
 */
function selectByQuota(activeAccounts: Array<AccountStatus>): AccountStatus {
  // Sort by effective quota percentage (descending)
  const sorted = [...activeAccounts].sort((a, b) => {
    const aQuota = getEffectiveQuotaPercent(a)
    const bQuota = getEffectiveQuotaPercent(b)
    return bQuota - aQuota
  })
  return sorted[0]
}
