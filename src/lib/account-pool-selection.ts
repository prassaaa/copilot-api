import consola from "consola"

import type { AccountStatus } from "./account-pool-types"

import { getEffectiveQuotaPercent } from "./account-pool-quota"
import {
  getActiveAccounts,
  invalidateActiveAccountsCache,
  poolConfig,
  poolState,
} from "./account-pool-store"

function resetExpiredRateLimits(): AccountStatus | null {
  const now = Date.now()
  let accountReset = false
  for (const account of poolState.accounts) {
    if (
      account.rateLimited
      && account.rateLimitResetAt
      && account.rateLimitResetAt <= now
      && account.paused !== true
    ) {
      account.rateLimited = false
      account.rateLimitResetAt = undefined
      accountReset = true
      if (account.active) {
        // Invalidate cache since rate limit status changed
        invalidateActiveAccountsCache()
        return account
      }
    }
  }
  // Invalidate cache if any account's rate limit was reset
  if (accountReset) {
    invalidateActiveAccountsCache()
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

// fix: perbaiki round-robin agar currentIndex tidak di-modulo saat increment - 2026-03-24
// currentIndex harus terus naik sebagai global counter, bukan di-modulo dengan activeAccounts.length
// karena activeAccounts.length bisa berubah-ubah (account bisa jadi rate-limited atau kembali aktif)
function selectRoundRobinAccount(
  activeAccounts: Array<AccountStatus>,
): AccountStatus {
  const index = poolState.currentIndex % activeAccounts.length
  const selected = activeAccounts[index]
  poolState.currentIndex++
  consola.info(
    `[round-robin] selected=${selected.login}, index=${index}, newIndex=${poolState.currentIndex}, activeCount=${activeAccounts.length}`,
  )
  return selected
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

const QUOTA_THRESHOLD_PERCENT = 5

export function selectAccount(): AccountStatus | null {
  if (!poolConfig.enabled || poolState.accounts.length === 0) {
    return null
  }

  // Use cached active accounts instead of filtering every time
  // Also filter out accounts with depleted quota
  const allActiveAccounts = getActiveAccounts()
  const activeAccounts = allActiveAccounts.filter((a) => {
    const quotaPercent = getEffectiveQuotaPercent(a)
    return quotaPercent > QUOTA_THRESHOLD_PERCENT
  })

  if (activeAccounts.length === 0) {
    const resetAccount = resetExpiredRateLimits()
    if (resetAccount) {
      const quotaPercent = getEffectiveQuotaPercent(resetAccount)
      if (quotaPercent > QUOTA_THRESHOLD_PERCENT) {
        poolState.lastSelectedId = resetAccount.id
        return resetAccount
      }
    }

    // If no accounts with sufficient quota, log which accounts are available but depleted
    if (allActiveAccounts.length > 0) {
      const depletedAccounts = allActiveAccounts.map(
        (a) => `${a.login}(${getEffectiveQuotaPercent(a).toFixed(1)}%)`,
      )
      consola.warn(
        `All active accounts have depleted quota: ${depletedAccounts.join(", ")}`,
      )
    } else {
      consola.warn("No active accounts available in pool")
    }
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

export function findNextAvailableAccount(
  excludeId: string,
): AccountStatus | null {
  // Use cached active accounts and filter out excluded AND accounts with depleted quota
  const availableAccounts = getActiveAccounts().filter((a) => {
    if (a.id === excludeId) return false
    // Skip accounts with depleted quota
    const quotaPercent = getEffectiveQuotaPercent(a)
    if (quotaPercent <= QUOTA_THRESHOLD_PERCENT) return false
    return true
  })
  if (availableAccounts.length === 0) return null
  return availableAccounts.reduce((best, current) => {
    const bestQuota = getEffectiveQuotaPercent(best)
    const currentQuota = getEffectiveQuotaPercent(current)
    return currentQuota > bestQuota ? current : best
  })
}

export function getCurrentAccount(): AccountStatus | null {
  // Use cached active accounts
  const activeAccounts = getActiveAccounts()

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
