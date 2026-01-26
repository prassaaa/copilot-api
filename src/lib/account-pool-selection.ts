import consola from "consola"

import type { AccountStatus } from "./account-pool-types"

import { getEffectiveQuotaPercent } from "./account-pool-quota"
import { poolConfig, poolState } from "./account-pool-store"

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

function selectByQuota(activeAccounts: Array<AccountStatus>): AccountStatus {
  // Sort by effective quota percentage (descending)
  const sorted = [...activeAccounts].sort((a, b) => {
    const aQuota = getEffectiveQuotaPercent(a)
    const bQuota = getEffectiveQuotaPercent(b)
    return bQuota - aQuota
  })
  return sorted[0]
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

export function findNextAvailableAccount(
  excludeId: string,
): AccountStatus | null {
  const availableAccounts = poolState.accounts.filter(
    (a) => a.id !== excludeId && a.active && !a.rateLimited && !a.paused,
  )
  if (availableAccounts.length === 0) return null
  return availableAccounts.reduce((best, current) => {
    const bestQuota = getEffectiveQuotaPercent(best)
    const currentQuota = getEffectiveQuotaPercent(current)
    return currentQuota > bestQuota ? current : best
  })
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
