import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getGitHubUser } from "~/services/github/get-user"

import {
  notifyAccountRotation,
  notifyAuthError,
  notifyRateLimit,
} from "./account-pool-notify"
import {
  checkAndAutoPauseAccounts as checkAndAutoPauseAccountsInternal,
  checkMonthlyReset as checkMonthlyResetInternal,
  fetchAccountQuota as fetchAccountQuotaInternal,
  getEffectiveQuotaPercent,
  needsQuotaRefresh,
  refreshAllQuotas as refreshAllQuotasInternal,
} from "./account-pool-quota"

export type SelectionStrategy =
  | "sticky"
  | "round-robin"
  | "hybrid"
  | "quota-based"

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

export interface PoolConfig {
  enabled: boolean
  strategy: SelectionStrategy
  accounts: Array<{ token: string; label?: string }>
}

export interface PoolState {
  accounts: Array<AccountStatus>
  currentIndex: number
  stickyAccountId?: string
  lastSelectedId?: string
  lastAutoRotationAt?: number
  config?: {
    enabled: boolean
    strategy: SelectionStrategy
  }
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const POOL_FILE = path.join(CONFIG_DIR, "account-pool.json")

let poolState: PoolState = {
  accounts: [],
  currentIndex: 0,
}

let poolConfig: PoolConfig = {
  enabled: false,
  strategy: "sticky",
  accounts: [],
}

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch {
    // Directory exists
  }
}

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
      lastAutoRotationAt: saved.lastAutoRotationAt,
    }
    if (saved.config) {
      poolConfig.enabled = saved.config.enabled
      poolConfig.strategy = saved.config.strategy
    }
  } catch {
    // File doesn't exist, use defaults
  }
}

async function savePoolState(): Promise<void> {
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

async function initializeAccount(
  token: string,
  label?: string,
): Promise<AccountStatus | null> {
  try {
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

    try {
      const copilot = await getCopilotToken(token)
      account.copilotToken = copilot.token
      account.copilotTokenExpires = Date.now() + copilot.refresh_in * 1000

      // Fetch quota for new account
      try {
        const quota = await fetchAccountQuotaInternal(account, poolState)
        if (quota) {
          account.quota = quota
        }
      } catch {
        consola.debug(`Could not fetch initial quota for ${account.login}`)
      }
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

export async function initializePool(config: PoolConfig): Promise<void> {
  await loadPoolState()
  markPoolStateLoaded()

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

  const newAccounts: Array<AccountStatus> = []

  for (const acc of config.accounts) {
    const existing = poolState.accounts.find((a) => a.token === acc.token)

    if (existing) {
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

function selectRoundRobinAccount(
  activeAccounts: Array<AccountStatus>,
): AccountStatus {
  const index = poolState.currentIndex % activeAccounts.length
  poolState.currentIndex = (poolState.currentIndex + 1) % activeAccounts.length
  return activeAccounts[index]
}

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

  try {
    const config = await import("./config").then((m) => m.getConfig())
    const requestLimit = config.autoRotationTriggers.requestCount
    if (
      config.autoRotationEnabled
      && requestLimit > 0
      && account.requestCount >= requestLimit
    ) {
      await rotateToNextAccount({ account, reason: "request-count" })
      account.requestCount = 0
    }
  } catch {
    // Ignore rotation errors
  }

  // Save state on first use or periodically (every 10 requests) to avoid too many writes
  if (isFirstUse || account.requestCount % 10 === 0) {
    void savePoolState()
  }

  return account.copilotToken
}

function shouldAutoRotate(
  errorType: "rate-limit" | "auth" | "other",
  errorCount: number,
  config: {
    autoRotationEnabled?: boolean
    autoRotationTriggers: { errorCount: number }
    autoRotationCooldownMinutes?: number
  },
): boolean {
  if (!config.autoRotationEnabled) return false
  if (errorType === "rate-limit") return true
  if (errorType === "other") {
    const threshold = config.autoRotationTriggers.errorCount
    return errorCount >= threshold
  }
  return false
}

function canRotateNow(config: {
  autoRotationCooldownMinutes?: number
}): boolean {
  const cooldownMinutes = config.autoRotationCooldownMinutes ?? 0
  if (cooldownMinutes <= 0) return true
  const last = poolState.lastAutoRotationAt
  if (!last) return true
  return Date.now() - last >= cooldownMinutes * 60 * 1000
}

async function rotateToNextAccount({
  account,
  reason,
}: {
  account: AccountStatus
  reason: string
}): Promise<void> {
  const config = await import("./config").then((m) => m.getConfig())
  if (!config.autoRotationEnabled || !canRotateNow(config)) return

  const nextAccount = findNextAvailableAccount(account.id)
  if (nextAccount) {
    poolState.stickyAccountId = nextAccount.id
    poolState.currentIndex = poolState.accounts.findIndex(
      (a) => a.id === nextAccount.id,
    )
    poolState.lastAutoRotationAt = Date.now()
    await notifyAccountRotation(account.login, nextAccount.login, reason)
  }
}

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

  if (doRotate && canRotateNow(config)) {
    const nextAccount = findNextAvailableAccount(account.id)
    if (nextAccount) {
      poolState.stickyAccountId = nextAccount.id
      poolState.currentIndex = poolState.accounts.findIndex(
        (a) => a.id === nextAccount.id,
      )
      poolState.lastAutoRotationAt = Date.now()

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

    // Fetch quota for initial account
    try {
      const quota = await fetchAccountQuotaInternal(account, poolState)
      if (quota) {
        account.quota = quota
      }
    } catch {
      consola.debug(`Could not fetch initial quota for ${account.login}`)
    }
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

export async function isPoolEnabled(): Promise<boolean> {
  await ensurePoolStateLoaded()
  return poolConfig.enabled && poolState.accounts.length > 0
}

export function isPoolEnabledSync(): boolean {
  return poolConfig.enabled && poolState.accounts.length > 0
}

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

export async function fetchAccountQuota(
  account: AccountStatus,
): Promise<AccountQuota | null> {
  return fetchAccountQuotaInternal(account, poolState)
}

export async function refreshAllQuotas(): Promise<void> {
  await refreshAllQuotasInternal(poolState, savePoolState)
}

export async function checkAndAutoPauseAccounts(): Promise<void> {
  await checkAndAutoPauseAccountsInternal(
    poolState,
    rotateToNextAccount,
    savePoolState,
  )
}

export async function checkMonthlyReset(): Promise<void> {
  await checkMonthlyResetInternal(poolState, refreshAllQuotas, savePoolState)
}

function selectByQuota(activeAccounts: Array<AccountStatus>): AccountStatus {
  // Sort by effective quota percentage (descending)
  const sorted = [...activeAccounts].sort((a, b) => {
    const aQuota = getEffectiveQuotaPercent(a)
    const bQuota = getEffectiveQuotaPercent(b)
    return bQuota - aQuota
  })
  return sorted[0]
}
