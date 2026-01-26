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
