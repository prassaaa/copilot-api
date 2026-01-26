import consola from "consola"

import { getCopilotUsageForAccount } from "~/services/github/get-copilot-usage"

import type {
  AccountQuota,
  AccountStatus,
  PoolState,
} from "./account-pool-types"

import { notifyQuotaLow } from "./account-pool-notify"

const QUOTA_THRESHOLD_PERCENT = 5
const QUOTA_REFRESH_INTERVAL = 5 * 60 * 1000

export function needsQuotaRefresh(account: AccountStatus): boolean {
  if (!account.quota?.lastFetched) return true
  return Date.now() - account.quota.lastFetched > QUOTA_REFRESH_INTERVAL
}

export function getEffectiveQuotaPercent(account: AccountStatus): number {
  if (!account.quota) return 100
  if (
    account.quota.chat.unlimited
    && account.quota.premiumInteractions.unlimited
  )
    return 100

  const chatPercent =
    account.quota.chat.unlimited ? 100 : account.quota.chat.percentRemaining
  const premiumPercent =
    account.quota.premiumInteractions.unlimited ?
      100
    : account.quota.premiumInteractions.percentRemaining
  return Math.min(chatPercent, premiumPercent)
}

export async function fetchAccountQuota(
  account: AccountStatus,
  poolState: PoolState,
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

type RotateFn = (params: {
  account: AccountStatus
  reason: string
}) => Promise<void>

interface QuotaLowContext {
  account: AccountStatus
  quotaPercent: number
  poolState: PoolState
  rotateToNextAccount: RotateFn
}

async function handleQuotaLow({
  account,
  quotaPercent,
  poolState,
  rotateToNextAccount,
}: QuotaLowContext): Promise<boolean> {
  account.paused = true
  account.pausedReason = "quota"
  consola.warn(
    `Account ${account.login} auto-paused: quota at ${quotaPercent.toFixed(1)}%`,
  )

  await notifyQuotaLow(account.login, quotaPercent)

  try {
    const config = await import("./config").then((m) => m.getConfig())
    const quotaThreshold = config.autoRotationTriggers.quotaThreshold
    const isCurrent =
      poolState.lastSelectedId === account.id
      || poolState.stickyAccountId === account.id
    if (
      config.autoRotationEnabled
      && isCurrent
      && quotaPercent <= quotaThreshold
    ) {
      await rotateToNextAccount({ account, reason: "quota-low" })
    }
  } catch {
    // Ignore rotation errors
  }

  return true
}

function handleQuotaRecovered(account: AccountStatus): boolean {
  account.paused = false
  account.pausedReason = undefined
  consola.info(`Account ${account.login} reactivated: quota recovered`)
  return true
}

export async function checkAndAutoPauseAccounts(
  poolState: PoolState,
  rotateToNextAccount: RotateFn,
  savePoolState: () => Promise<void>,
): Promise<void> {
  let changed = false
  for (const account of poolState.accounts) {
    if (account.paused && account.pausedReason === "manual") {
      continue
    }

    const quotaPercent = getEffectiveQuotaPercent(account)
    if (quotaPercent <= QUOTA_THRESHOLD_PERCENT && !account.paused) {
      changed ||= await handleQuotaLow({
        account,
        quotaPercent,
        poolState,
        rotateToNextAccount,
      })
    } else if (
      quotaPercent > QUOTA_THRESHOLD_PERCENT
      && account.pausedReason === "quota"
    ) {
      changed ||= handleQuotaRecovered(account)
    }
  }

  if (changed) {
    await savePoolState()
  }
}

export async function refreshAllQuotas(
  poolState: PoolState,
  savePoolState: () => Promise<void>,
): Promise<void> {
  consola.info("Refreshing quota for all accounts...")
  for (const account of poolState.accounts) {
    await fetchAccountQuota(account, poolState)
  }
  await savePoolState()
  consola.success("Quota refreshed for all accounts")
}

let lastMonthCheck: number | null = null

export async function checkMonthlyReset(
  poolState: PoolState,
  refreshAllQuotasFn: () => Promise<void>,
  savePoolState: () => Promise<void>,
): Promise<void> {
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
        account.quota = undefined
        consola.success(`Account ${account.login} reactivated for new month`)
        changed = true
      }
    }

    if (changed) {
      await savePoolState()
      await refreshAllQuotasFn()
    }
  }
}
