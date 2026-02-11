import consola from "consola"

import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getGitHubUser } from "~/services/github/get-user"

import type {
  AccountQuota,
  AccountStatus,
  PoolConfig,
} from "./account-pool-types"

import {
  notifyAccountRotation,
  notifyAuthError,
  notifyRateLimit,
} from "./account-pool-notify"
import {
  checkAndAutoPauseAccounts as checkAndAutoPauseAccountsInternal,
  checkMonthlyReset as checkMonthlyResetInternal,
  fetchAccountQuota as fetchAccountQuotaInternal,
  needsQuotaRefresh,
  refreshAllQuotas as refreshAllQuotasInternal,
} from "./account-pool-quota"
import {
  findNextAvailableAccount,
  selectAccount,
} from "./account-pool-selection"
import {
  ensurePoolStateLoaded,
  invalidateActiveAccountsCache,
  isPoolStateLoaded,
  loadPoolState,
  markPoolStateLoaded,
  poolConfig,
  poolState,
  savePoolState,
  setPoolConfig,
  setPoolState,
  syncAccountsToConfig,
} from "./account-pool-store"
import { getConfig, saveConfig } from "./config"
import { state } from "./state"

export { getCurrentAccount, selectAccount } from "./account-pool-selection"

export type {
  AccountQuota,
  AccountStatus,
  PoolConfig,
  SelectionStrategy,
} from "./account-pool-types"

/**
 * Update global state to reflect the current account's user info.
 * This syncs the account pool's active account with the display state.
 */
function syncGlobalStateToAccount(account: AccountStatus | null): void {
  if (account) {
    state.githubUser = { login: account.login, id: Number(account.id) || 0 }
    state.githubToken = account.token
    consola.debug(`Synced global state to account: ${account.login}`)
  } else {
    state.githubUser = undefined
    state.githubToken = undefined
    consola.debug("Cleared global state (no account)")
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
      invalidateActiveAccountsCache()
    }

    return account
  } catch (error) {
    consola.error(`Failed to initialize account:`, error)
    return null
  }
}

function updateAccountToken(
  account: AccountStatus,
  copilotToken: string,
  expiresIn: number,
): void {
  const wasInactive = !account.active || account.rateLimited
  account.copilotToken = copilotToken
  account.copilotTokenExpires = Date.now() + expiresIn * 1000
  account.active = true
  account.rateLimited = false
  if (wasInactive) {
    invalidateActiveAccountsCache()
  }
}

function markAccountInactive(account: AccountStatus): void {
  if (account.active) {
    account.active = false
    invalidateActiveAccountsCache()
  }
}

async function refreshAccountToken(account: AccountStatus): Promise<void> {
  const needsRefresh =
    !account.copilotTokenExpires
    || Date.now() > account.copilotTokenExpires - 60000
  if (needsRefresh) {
    try {
      const copilot = await getCopilotToken(account.token)
      updateAccountToken(account, copilot.token, copilot.refresh_in)
    } catch {
      markAccountInactive(account)
    }
  }
}

export async function initializePool(config: PoolConfig): Promise<void> {
  await loadPoolState()
  markPoolStateLoaded()

  const savedEnabled = poolConfig.enabled
  const savedStrategy = poolConfig.strategy

  setPoolConfig({
    ...config,
    enabled: savedEnabled || config.enabled,
    strategy: savedStrategy !== "sticky" ? savedStrategy : config.strategy,
  })

  // If no accounts in config but we have saved accounts, use those
  if (config.accounts.length === 0 && poolState.accounts.length > 0) {
    consola.info(
      `Using ${poolState.accounts.length} saved accounts from pool state`,
    )
    for (const account of poolState.accounts) {
      await refreshAccountToken(account)
    }
    savePoolState()
    await syncAccountsToConfig()
    return
  }

  if (!poolConfig.enabled || config.accounts.length === 0) {
    // Even if pool is disabled, sync any existing accounts to config
    if (poolState.accounts.length > 0) {
      await syncAccountsToConfig()
    }
    consola.debug("Account pool disabled or empty")
    return
  }

  consola.info(
    `Initializing account pool with ${config.accounts.length} accounts from config...`,
  )

  const processedTokens = new Set<string>()
  const mergedAccounts: Array<AccountStatus> = []

  // First, process accounts from config
  for (const acc of config.accounts) {
    const existing = poolState.accounts.find((a) => a.token === acc.token)

    if (existing) {
      await refreshAccountToken(existing)
      mergedAccounts.push(existing)
    } else {
      const account = await initializeAccount(acc.token, acc.label)
      if (account) {
        mergedAccounts.push(account)
      }
    }
    processedTokens.add(acc.token)
  }

  // Then, add any accounts from poolState that weren't in config
  for (const account of poolState.accounts) {
    if (!processedTokens.has(account.token)) {
      await refreshAccountToken(account)
      mergedAccounts.push(account)
      consola.info(`Restored account ${account.login} from saved state`)
    }
  }

  // Assign merged accounts
  consola.debug(
    `initializePool: mergedAccounts=${mergedAccounts.length}, from config=${config.accounts.length}, from poolState=${poolState.accounts.length}`,
  )
  setPoolState({
    ...poolState,
    accounts: mergedAccounts,
  })
  savePoolState()
  await syncAccountsToConfig()

  const activeCount = mergedAccounts.filter((a) => a.active).length
  consola.success(
    `Account pool initialized: ${activeCount}/${mergedAccounts.length} active`,
  )
}

export async function getPooledCopilotToken(): Promise<string | null> {
  // Check for monthly reset first
  checkMonthlyReset()

  // Maximum attempts to prevent infinite loops (use account count + 1 as reasonable limit)
  const maxAttempts = poolState.accounts.length + 1
  let attempts = 0
  const triedAccounts = new Set<string>()

  while (attempts < maxAttempts) {
    attempts++

    const account = selectAccount()
    if (!account) return null

    // Skip accounts we've already tried this round
    if (triedAccounts.has(account.id)) {
      consola.debug(
        `Already tried account ${account.login}, no more accounts available`,
      )
      return null
    }
    triedAccounts.add(account.id)

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
        // Reset error count on successful token refresh
        if (account.errorCount > 0) {
          account.errorCount = Math.max(0, account.errorCount - 1)
        }
        savePoolState()
      } catch (error) {
        consola.error(`Failed to refresh token for ${account.login}:`, error)
        account.active = false
        account.lastError = String(error)
        invalidateActiveAccountsCache()
        savePoolState()
        // Try next account (continue loop instead of recursive call)
        continue
      }
    }

    // Refresh quota if needed (async, don't block request)
    if (needsQuotaRefresh(account)) {
      void fetchAccountQuota(account).then(() => {
        checkAndAutoPauseAccounts()
        savePoolState()
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
      savePoolState()
    }

    return account.copilotToken
  }

  consola.error("All accounts exhausted, no valid token available")
  return null
}

function shouldAutoRotate(
  errorType: "rate-limit" | "auth" | "quota" | "other",
  errorCount: number,
  config: {
    autoRotationEnabled?: boolean
    autoRotationTriggers: { errorCount: number }
    autoRotationCooldownMinutes?: number
  },
): boolean {
  if (!config.autoRotationEnabled) return false
  if (errorType === "rate-limit") return true
  if (errorType === "quota") return true
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
    syncGlobalStateToAccount(nextAccount)
    await notifyAccountRotation(account.login, nextAccount.login, reason)
  }
}

export function reportAccountError(
  errorType: "rate-limit" | "auth" | "quota" | "other",
  resetAt?: number,
): void {
  const account =
    (poolState.lastSelectedId ?
      poolState.accounts.find((a) => a.id === poolState.lastSelectedId)
    : undefined)
    ?? (poolState.stickyAccountId ?
      poolState.accounts.find((a) => a.id === poolState.stickyAccountId)
    : undefined)
    ?? selectAccount()
  if (!account) return

  const previousAccount = account.login
  account.errorCount++
  account.lastError = errorType

  switch (errorType) {
    case "rate-limit": {
      account.rateLimited = true
      account.rateLimitResetAt = resetAt ?? Date.now() + 60000
      invalidateActiveAccountsCache()
      consola.warn(
        `Account ${account.login} rate limited until ${new Date(account.rateLimitResetAt).toISOString()}`,
      )
      void notifyRateLimit(account.login, account.rateLimitResetAt)
      break
    }

    case "quota": {
      account.paused = true
      account.pausedReason = "quota"
      account.rateLimited = false
      account.rateLimitResetAt = undefined
      invalidateActiveAccountsCache()
      consola.warn(`Account ${account.login} quota exceeded, pausing account`)
      break
    }

    case "auth": {
      account.active = false
      invalidateActiveAccountsCache()
      consola.error(`Account ${account.login} auth failed, deactivating`)
      void notifyAuthError(account.login)
      break
    }

    default: {
      break
    }
  }

  const config = getConfig()
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
      syncGlobalStateToAccount(nextAccount)
      consola.info(
        `Auto-rotated from ${previousAccount} to ${nextAccount.login}`,
      )
      void notifyAccountRotation(previousAccount, nextAccount.login, errorType)
    } else {
      poolState.stickyAccountId = undefined
      poolState.currentIndex++
    }
  }

  savePoolState()
}

export async function addAccount(
  token: string,
  label?: string,
): Promise<AccountStatus | null> {
  await ensurePoolStateLoaded()

  if (poolState.accounts.some((a) => a.token === token)) {
    consola.warn("Account already in pool")
    return null
  }

  const account = await initializeAccount(token, label)
  if (account) {
    poolState.accounts.push(account)
    poolConfig.accounts.push({ token, label })
    if (!poolConfig.enabled) {
      poolConfig.enabled = true
      consola.info("Account pool auto-enabled")
    }
    savePoolState()
    await syncAccountsToConfig()
    consola.success(`Account ${account.login} added to pool`)
  }

  return account
}

export async function addInitialAccount(
  token: string,
  userInfo: { login: string; id: number; name?: string; avatar_url?: string },
): Promise<AccountStatus | null> {
  await ensurePoolStateLoaded()

  const existingAccount = poolState.accounts.find((a) => a.token === token)
  if (existingAccount) {
    consola.debug("Initial account already in pool")
    // Sync sticky account to the logged-in account
    if (poolState.stickyAccountId !== existingAccount.id) {
      poolState.stickyAccountId = existingAccount.id
      syncGlobalStateToAccount(existingAccount)
      savePoolState()
      consola.info(`Switched active account to ${existingAccount.login}`)
    }
    return existingAccount
  }

  const account: AccountStatus = {
    id: userInfo.login,
    login: userInfo.login,
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
    invalidateActiveAccountsCache()
  }

  poolState.accounts.unshift(account)
  poolConfig.accounts.unshift({ token, label: userInfo.login })
  poolState.stickyAccountId = account.id

  if (!poolConfig.enabled) {
    poolConfig.enabled = true
    consola.info("Account pool auto-enabled")
  }

  savePoolState()
  await syncAccountsToConfig()
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
    // Update global state to the next available account or clear it
    const nextAccount = poolState.accounts.find(
      (a) => a.active && !a.rateLimited && !a.paused,
    )
    poolState.stickyAccountId = nextAccount?.id
    syncGlobalStateToAccount(nextAccount ?? null)
  }

  savePoolState()

  // Sync removal to config.json
  try {
    const config = getConfig()
    const updatedPoolAccounts = config.poolAccounts.filter(
      (a) => a.token !== token,
    )
    await saveConfig({ poolAccounts: updatedPoolAccounts })
  } catch (error) {
    consola.error("Failed to sync account removal to config:", error)
  }

  consola.info(`Account ${id} removed from pool`)
  return { removed: true, token }
}

export async function getAccountsStatus(): Promise<
  Array<Omit<AccountStatus, "token" | "copilotToken">>
> {
  await ensurePoolStateLoaded()
  consola.debug(
    `getAccountsStatus: poolStateLoaded=${isPoolStateLoaded()}, accounts=${poolState.accounts.length}`,
  )

  // Filter out invalid accounts and dedupe by id
  const seenIds = new Set<string>()
  return poolState.accounts
    .filter((a) => {
      if (!a.id || seenIds.has(a.id)) return false
      seenIds.add(a.id)
      return true
    })
    .map((a) => ({
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
  invalidateActiveAccountsCache()
  savePoolState()
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
  savePoolState()
}

export async function isPoolEnabled(): Promise<boolean> {
  await ensurePoolStateLoaded()
  return poolConfig.enabled && poolState.accounts.length > 0
}

export function isPoolEnabledSync(): boolean {
  return poolConfig.enabled && poolState.accounts.length > 0
}

type TokenRefreshResult =
  | {
      account: AccountStatus
      ok: true
      token: string
      refreshIn: number
    }
  | {
      account: AccountStatus
      ok: false
      error: unknown
    }

async function fetchTokenRefreshResult(
  account: AccountStatus,
): Promise<TokenRefreshResult> {
  try {
    const copilot = await getCopilotToken(account.token)
    return {
      account,
      ok: true,
      token: copilot.token,
      refreshIn: copilot.refresh_in,
    }
  } catch (error) {
    return {
      account,
      ok: false,
      error,
    }
  }
}

export async function refreshAllTokens(): Promise<void> {
  await ensurePoolStateLoaded()
  const refreshResults = await Promise.all(
    poolState.accounts.map((account) => fetchTokenRefreshResult(account)),
  )

  let statusChanged = false
  for (const result of refreshResults) {
    if (result.ok) {
      const account = result.account
      const changed = !account.active || account.rateLimited
      account.copilotToken = result.token
      account.copilotTokenExpires = Date.now() + result.refreshIn * 1000
      account.active = true
      account.rateLimited = false
      account.errorCount = 0
      account.lastError = undefined
      statusChanged ||= changed
      continue
    }

    const account = result.account
    const changed = account.active
    account.active = false
    account.lastError = String(result.error)
    statusChanged ||= changed
  }

  if (statusChanged) {
    invalidateActiveAccountsCache()
  }

  savePoolState()
}

export async function fetchAccountQuota(
  account: AccountStatus,
): Promise<AccountQuota | null> {
  return fetchAccountQuotaInternal(account, poolState)
}

export async function refreshAllQuotas(): Promise<void> {
  await ensurePoolStateLoaded()
  await refreshAllQuotasInternal(poolState, savePoolState)
  checkAndAutoPauseAccountsInternal(
    poolState,
    rotateToNextAccount,
    savePoolState,
  )
}

export function checkAndAutoPauseAccounts(): void {
  checkAndAutoPauseAccountsInternal(
    poolState,
    rotateToNextAccount,
    savePoolState,
  )
}

export function checkMonthlyReset(): void {
  checkMonthlyResetInternal(poolState, refreshAllQuotas, savePoolState)
}

export function setCurrentAccount(accountId: string): {
  success: boolean
  account?: AccountStatus
} {
  const account = poolState.accounts.find((a) => a.id === accountId)

  if (!account) {
    consola.warn(`setCurrentAccount: Account ${accountId} not found`)
    return { success: false }
  }

  consola.debug(
    `setCurrentAccount: Setting current to ${account.login} (id: ${account.id})`,
  )

  // Set this account as the sticky and last selected account
  poolState.stickyAccountId = accountId
  poolState.lastSelectedId = accountId
  syncGlobalStateToAccount(account)

  savePoolState()

  return { success: true, account }
}
