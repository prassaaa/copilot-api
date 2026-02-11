/**
 * WebUI Routes - Web interface for Copilot API management
 *
 * Features:
 * - Dashboard with real-time quota visualization
 * - Models list view
 * - Settings editor for Claude CLI
 * - Live server logs streaming
 */

import type { Context } from "hono"

import { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { streamSSE } from "hono/streaming"

import {
  addAccount,
  getAccountsStatus,
  getPoolConfig,
  isPoolEnabled,
  removeAccount,
  updatePoolConfig,
  refreshAllTokens,
  refreshAllQuotas,
  getCurrentAccount,
  toggleAccountPause,
  setCurrentAccount,
} from "~/lib/account-pool"
import {
  readClaudeConfig,
  updateClaudeConfig,
  getClaudeConfigPath,
} from "~/lib/claude-config"
import {
  getPublicConfig,
  saveConfig,
  getConfig,
  getConfigFile,
} from "~/lib/config"
import { registerInterval } from "~/lib/intervals"
import { logEmitter } from "~/lib/logger"
import { requestCache } from "~/lib/request-cache"
import { updateQueueConfig } from "~/lib/request-queue"
import { registerShutdownHandler } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { usageStats } from "~/lib/usage-stats"
import { cacheModels } from "~/lib/utils"
import { checkVersion } from "~/lib/version-check"
import { getDeviceCode } from "~/services/github/get-device-code"
import { pollAccessToken } from "~/services/github/poll-access-token"
import { cacheRoutes } from "~/webui/api/cache"
import { costRoutes } from "~/webui/api/cost"
import { historyRoutes } from "~/webui/api/history"
import { notificationRoutes } from "~/webui/api/notifications"
import { queueRoutes } from "~/webui/api/queue"
import { webhookRoutes } from "~/webui/api/webhooks"

export const webuiRoutes = new Hono()

// Session expiration time (24 hours in milliseconds)
const SESSION_EXPIRATION_MS = 24 * 60 * 60 * 1000
// Cleanup interval (every 5 minutes)
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
// OAuth flow expiration (10 minutes)
const OAUTH_FLOW_EXPIRATION_MS = 10 * 60 * 1000

// Store active sessions with creation time
interface SessionData {
  createdAt: number
}
const activeSessions = new Map<string, SessionData>()

// Store pending OAuth flows
const pendingOAuthFlows = new Map<
  string,
  {
    deviceCode: Awaited<ReturnType<typeof getDeviceCode>>
    label?: string
    createdAt: number
  }
>()

// ==========================================
// Authentication Middleware
// ==========================================

/**
 * Simple token-based authentication for WebUI
 * Uses cookie-based session after login
 */
function generateSessionToken(): string {
  return crypto.randomUUID()
}

/**
 * Cleanup expired sessions and OAuth flows
 */
function cleanupExpiredSessions(): void {
  const now = Date.now()

  // Cleanup expired sessions
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_EXPIRATION_MS) {
      activeSessions.delete(token)
    }
  }

  // Cleanup expired OAuth flows
  for (const [flowId, flow] of pendingOAuthFlows) {
    if (now - flow.createdAt > OAUTH_FLOW_EXPIRATION_MS) {
      pendingOAuthFlows.delete(flowId)
    }
  }
}

/**
 * Initialize session cleanup interval
 */
export function initSessionCleanup(): void {
  const intervalId = setInterval(
    cleanupExpiredSessions,
    SESSION_CLEANUP_INTERVAL_MS,
  )
  registerInterval("webui-session-cleanup", intervalId)

  // Register shutdown handler to cleanup sessions info
  registerShutdownHandler(
    "webui-sessions",
    () => {
      activeSessions.clear()
      pendingOAuthFlows.clear()
    },
    90,
  )
}

/**
 * POST /api/login - Authenticate with password
 */
webuiRoutes.post("/api/login", async (c) => {
  const config = getConfig()

  // If no password is set, login is always successful
  if (!config.webuiPassword) {
    return c.json({ status: "ok", message: "No password required" })
  }

  const body = await c.req.json<{ password?: string }>()

  if (body.password === config.webuiPassword) {
    const token = generateSessionToken()
    activeSessions.set(token, { createdAt: Date.now() })

    // Set cookie that expires in 24 hours
    setCookie(c, "session", token, {
      httpOnly: true,
      maxAge: 86400, // 24 hours
      sameSite: "Strict",
    })

    return c.json({ status: "ok", message: "Login successful" })
  }

  return c.json({ status: "error", error: "Invalid password" }, 401)
})

/**
 * POST /api/logout - Clear session
 */
webuiRoutes.post("/api/logout", (c) => {
  const token = getCookie(c, "session")
  if (token) {
    activeSessions.delete(token)
  }

  setCookie(c, "session", "", { maxAge: 0 })
  return c.json({ status: "ok", message: "Logged out" })
})

/**
 * GET /api/version-check - Check if local WebUI matches GitHub main
 */
webuiRoutes.get("/api/version-check", async (c) => {
  try {
    const result = await checkVersion()
    return c.json(result)
  } catch (error) {
    return c.json({ status: "error", message: (error as Error).message }, 500)
  }
})

/**
 * GET /api/auth-status - Check if authenticated
 */
webuiRoutes.get("/api/auth-status", (c) => {
  const config = getConfig()

  // No password = no auth required
  if (!config.webuiPassword) {
    return c.json({
      status: "ok",
      authenticated: true,
      passwordRequired: false,
    })
  }

  const token = getCookie(c, "session")
  const authenticated = token ? activeSessions.has(token) : false

  return c.json({
    status: "ok",
    authenticated,
    passwordRequired: true,
  })
})

/**
 * Middleware to check authentication for protected routes
 */
webuiRoutes.use("/api/*", async (c: Context, next) => {
  // Skip auth check for login and auth-status endpoints
  const path = c.req.path
  if (
    path === "/api/login"
    || path === "/api/logout"
    || path === "/api/auth-status"
  ) {
    return next()
  }

  const config = getConfig()

  // No password = no auth required
  if (!config.webuiPassword) {
    return next()
  }

  const token = getCookie(c, "session")
  if (token && activeSessions.has(token)) {
    return next()
  }

  return c.json({ status: "error", error: "Authentication required" }, 401)
})

// ==========================================
// Mount Sub-routes
// ==========================================
webuiRoutes.route("/api/notifications", notificationRoutes)
webuiRoutes.route("/api/webhooks", webhookRoutes)
webuiRoutes.route("/api/history", historyRoutes)
webuiRoutes.route("/api/cache", cacheRoutes)
webuiRoutes.route("/api/queue", queueRoutes)
webuiRoutes.route("/api/cost", costRoutes)

// ==========================================
// Dashboard API (Protected)
// ==========================================

function applyRuntimeConfig(config: ReturnType<typeof getConfig>): void {
  updateQueueConfig({
    enabled: config.queueEnabled,
    maxConcurrent: config.queueMaxConcurrent,
    maxSize: config.queueMaxSize,
    timeout: config.queueTimeout,
  })
  requestCache.updateConfig({
    enabled: config.cacheEnabled,
    maxSize: config.cacheMaxSize,
    ttlSeconds: config.cacheTtlSeconds,
  })
  state.rateLimitSeconds = config.rateLimitSeconds
  state.rateLimitWait = config.rateLimitWait
}

function sanitizeConfigUpdates(
  updates: Partial<ReturnType<typeof getPublicConfig>>,
): Partial<ReturnType<typeof getPublicConfig>> {
  const allowedKeys = new Set(
    Object.keys(getPublicConfig()).filter((k) => k !== "webuiPasswordSet"),
  )
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(updates)) {
    if (!allowedKeys.has(key)) continue
    sanitized[key] = value
  }
  return sanitized as Partial<ReturnType<typeof getPublicConfig>>
}

/**
 * GET /api/status - Get server status and basic info
 */
webuiRoutes.get("/api/status", (c) => {
  return c.json({
    status: "ok",
    version: process.env.npm_package_version || "0.7.0",
    uptime: process.uptime(),
    user:
      state.githubUser?.login
      || (state.githubToken ? "authenticated" : "not authenticated"),
    accountType: state.accountType,
    modelsCount: state.models?.data.length || 0,
    configPath: getConfigFile(),
    claudeConfigPath: getClaudeConfigPath(),
  })
})

/**
 * POST /api/server/restart - Restart the server
 */
webuiRoutes.post("/api/server/restart", (c) => {
  // Schedule restart after response is sent
  setTimeout(() => {
    process.exit(0) // Exit with 0 so process managers can restart
  }, 500)

  return c.json({
    status: "ok",
    message: "Server is restarting...",
  })
})

/**
 * GET /api/models - Get available models
 */
webuiRoutes.get("/api/models", async (c) => {
  if (!state.models) {
    await cacheModels()
  }

  if (!state.models) {
    return c.json({ status: "error", error: "Models not loaded" }, 503)
  }

  // Dedupe models by id
  const seenIds = new Set<string>()
  const uniqueModels = state.models.data.filter((model) => {
    if (!model.id || seenIds.has(model.id)) return false
    seenIds.add(model.id)
    return true
  })

  return c.json({
    status: "ok",
    models: uniqueModels.map((model) => {
      const caps = model.capabilities
      return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        version: model.version,
        preview: model.preview,
        modelPickerEnabled: model.model_picker_enabled,
        policy:
          model.policy ?
            {
              state: model.policy.state,
              terms: model.policy.terms,
            }
          : null,
        capabilities: {
          family: caps.family,
          type: caps.type,
          tokenizer: caps.tokenizer,
          limits: {
            maxContextTokens: caps.limits?.max_context_window_tokens,
            maxOutputTokens: caps.limits?.max_output_tokens,
            maxPromptTokens: caps.limits?.max_prompt_tokens,
            maxInputs: caps.limits?.max_inputs,
          },
          supports: {
            toolCalls: caps.supports?.tool_calls,
            parallelToolCalls: caps.supports?.parallel_tool_calls,
            dimensions: caps.supports?.dimensions,
          },
        },
      }
    }),
  })
})

// ==========================================
// Copilot Usage/Quota API
// ==========================================

/**
 * GET /api/copilot-usage - Get Copilot quota and usage data
 */
webuiRoutes.get("/api/copilot-usage", async (c) => {
  try {
    const { getCopilotUsage } = await import(
      "~/services/github/get-copilot-usage"
    )
    const usage = await getCopilotUsage()

    return c.json({
      status: "ok",
      usage,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 500)
  }
})

// ==========================================
// Usage Stats API
// ==========================================

/**
 * GET /api/usage-stats - Get usage statistics
 */
webuiRoutes.get("/api/usage-stats", (c) => {
  const period = c.req.query("period") || "24h"
  const stats = usageStats.getStats(period)

  return c.json({
    status: "ok",
    period,
    stats,
  })
})

/**
 * GET /api/usage-stats/history - Get usage history
 */
webuiRoutes.get("/api/usage-stats/history", (c) => {
  const days = Number.parseInt(c.req.query("days") || "7", 10)
  const history = usageStats.getHistory(days)

  return c.json({
    status: "ok",
    days,
    history,
  })
})

// ==========================================
// Config API
// ==========================================

/**
 * GET /api/config - Get public configuration
 */
webuiRoutes.get("/api/config", (c) => {
  const config = getPublicConfig()
  const configPath = getConfigFile()
  const claudeConfigPath = getClaudeConfigPath()

  return c.json({
    status: "ok",
    config,
    serverInfo: {
      version: process.env.npm_package_version || "0.7.0",
      uptime: process.uptime(),
      user: state.githubUser?.login || null,
      configPath,
      claudeConfigPath,
    },
  })
})

/**
 * POST /api/config - Update configuration
 */
webuiRoutes.post("/api/config", async (c) => {
  try {
    const updates =
      await c.req.json<Partial<ReturnType<typeof getPublicConfig>>>()
    const sanitized = sanitizeConfigUpdates(updates)
    await saveConfig(sanitized)
    applyRuntimeConfig(getConfig())
    return c.json({
      status: "ok",
      message: "Configuration updated",
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/config/reset - Reset configuration to defaults
 */
webuiRoutes.post("/api/config/reset", async (c) => {
  try {
    await saveConfig({
      debug: false,
      rateLimitSeconds: undefined,
      rateLimitWait: false,
      fallbackEnabled: false,
      modelMapping: {},
      trackUsage: true,
      defaultModel: "gpt-4.1",
      defaultSmallModel: "gpt-4.1",
    })
    applyRuntimeConfig(getConfig())
    return c.json({
      status: "ok",
      message: "Configuration reset to defaults",
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

// ==========================================
// Claude CLI Settings API
// ==========================================

/**
 * GET /api/claude-config - Get Claude CLI settings
 */
webuiRoutes.get("/api/claude-config", async (c) => {
  try {
    const config = await readClaudeConfig()
    const configPath = getClaudeConfigPath()
    return c.json({
      status: "ok",
      config,
      path: configPath,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 500)
  }
})

/**
 * POST /api/claude-config - Update Claude CLI settings
 */
webuiRoutes.post("/api/claude-config", async (c) => {
  try {
    const updates = await c.req.json<Record<string, unknown>>()
    await updateClaudeConfig(
      updates as Parameters<typeof updateClaudeConfig>[0],
    )
    return c.json({
      status: "ok",
      message: "Claude CLI settings updated",
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

// ==========================================
// Logs Streaming API
// ==========================================

/**
 * GET /api/logs/stream - Stream server logs via SSE
 */
webuiRoutes.get("/api/logs/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const sendLog = (log: {
      level: string
      message: string
      timestamp: string
    }) => {
      void stream.writeSSE({
        event: "log",
        data: JSON.stringify(log),
      })
    }

    // Subscribe to log events
    logEmitter.on("log", sendLog)

    // Send initial connection message
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ message: "Log stream connected" }),
    })

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      void stream.writeSSE({
        event: "heartbeat",
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      })
    }, 30000)

    // Cleanup on disconnect
    stream.onAbort(() => {
      logEmitter.off("log", sendLog)
      clearInterval(heartbeat)
    })

    // Keep stream open
    await new Promise(() => {})
  })
})

/**
 * GET /api/logs/recent - Get recent logs
 */
webuiRoutes.get("/api/logs/recent", (c) => {
  const limit = Number.parseInt(c.req.query("limit") || "100", 10)
  const logs = logEmitter.getRecentLogs(limit)

  return c.json({
    status: "ok",
    logs,
  })
})

// ==========================================
// Account Pool API
// ==========================================

/**
 * GET /api/accounts - Get all accounts status
 */
webuiRoutes.get("/api/accounts", async (c) => {
  const poolAccounts = await getAccountsStatus()
  const poolConfigData = await getPoolConfig()
  const poolEnabled = await isPoolEnabled()
  const currentAccount = getCurrentAccount()

  return c.json({
    status: "ok",
    poolEnabled,
    strategy: poolConfigData.strategy,
    currentAccountId: currentAccount?.id ?? null,
    configuredCount: poolAccounts.length,
    accounts: poolAccounts,
  })
})

/**
 * POST /api/accounts - Add a new account to the pool
 */
webuiRoutes.post("/api/accounts", async (c) => {
  try {
    const body = await c.req.json<{ token: string; label?: string }>()

    if (!body.token) {
      return c.json({ status: "error", error: "Token is required" }, 400)
    }

    const account = await addAccount(body.token, body.label)

    if (!account) {
      return c.json({ status: "error", error: "Failed to add account" }, 400)
    }

    // addAccount now handles syncing to config.json internally

    return c.json({
      status: "ok",
      message: `Account ${account.login} added`,
      account: {
        id: account.id,
        login: account.login,
        active: account.active,
      },
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * DELETE /api/accounts/:id - Remove an account from the pool
 */
webuiRoutes.delete("/api/accounts/:id", async (c) => {
  try {
    const id = c.req.param("id")
    const result = await removeAccount(id)

    if (!result.removed) {
      return c.json({ status: "error", error: "Account not found" }, 404)
    }

    // removeAccount now handles syncing to config.json internally

    return c.json({
      status: "ok",
      message: `Account ${id} removed`,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/accounts/:id/pause - Pause/unpause an account
 */
webuiRoutes.post("/api/accounts/:id/pause", async (c) => {
  try {
    const id = c.req.param("id")
    const body = await c.req.json<{ paused: boolean }>()
    const result = await toggleAccountPause(id, body.paused)

    if (!result.success) {
      return c.json({ status: "error", error: "Account not found" }, 404)
    }

    return c.json({
      status: "ok",
      message: `Account ${id} ${result.paused ? "paused" : "resumed"}`,
      paused: result.paused,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/accounts/:id/set-current - Set account as current (sticky)
 */
webuiRoutes.post("/api/accounts/:id/set-current", async (c) => {
  try {
    const id = c.req.param("id")
    const result = setCurrentAccount(id)

    if (!result.success) {
      return c.json({ status: "error", error: "Account not found" }, 404)
    }

    const accounts = await getAccountsStatus()

    return c.json({
      status: "ok",
      message: `Account ${id} set as current`,
      accounts,
      currentAccountId: id,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/accounts/refresh - Refresh all account tokens
 */
webuiRoutes.post("/api/accounts/refresh", async (c) => {
  try {
    await refreshAllTokens()
    const accounts = await getAccountsStatus()
    const currentAccount = getCurrentAccount()

    return c.json({
      status: "ok",
      message: "Tokens refreshed",
      accounts,
      currentAccountId: currentAccount?.id ?? null,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/pool-config - Update pool configuration
 */
webuiRoutes.post("/api/pool-config", async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean; strategy?: string }>()

    await updatePoolConfig({
      enabled: body.enabled,
      strategy: body.strategy as
        | "sticky"
        | "round-robin"
        | "hybrid"
        | "quota-based",
    })

    // Also save to config file
    await saveConfig({
      poolEnabled: body.enabled,
      poolStrategy: body.strategy as
        | "sticky"
        | "round-robin"
        | "hybrid"
        | "quota-based",
    })

    return c.json({
      status: "ok",
      message: "Pool configuration updated",
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/accounts/refresh-quotas - Refresh quota for all accounts
 */
webuiRoutes.post("/api/accounts/refresh-quotas", async (c) => {
  try {
    refreshAllQuotas()
    const accounts = await getAccountsStatus()

    return c.json({
      status: "ok",
      message: "Quotas refreshed for all accounts",
      accounts,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

// ==========================================
// OAuth Device Flow for Adding Accounts
// ==========================================

/**
 * POST /api/accounts/oauth/start - Start OAuth device flow for new account
 */
webuiRoutes.post("/api/accounts/oauth/start", async (c) => {
  try {
    const body = await c.req.json<{ label?: string }>()

    // Get device code from GitHub
    const deviceCode = await getDeviceCode()

    // Generate a flow ID
    const flowId = crypto.randomUUID()

    // Store the pending flow
    pendingOAuthFlows.set(flowId, {
      deviceCode,
      label: body.label,
      createdAt: Date.now(),
    })

    // Clean up old flows (older than 15 minutes)
    const now = Date.now()
    for (const [id, flow] of pendingOAuthFlows) {
      if (now - flow.createdAt > 15 * 60 * 1000) {
        pendingOAuthFlows.delete(id)
      }
    }

    return c.json({
      status: "ok",
      flowId,
      userCode: deviceCode.user_code,
      verificationUri: deviceCode.verification_uri,
      expiresIn: deviceCode.expires_in,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/accounts/oauth/complete - Complete OAuth flow and add account
 */
webuiRoutes.post("/api/accounts/oauth/complete", async (c) => {
  try {
    const body = await c.req.json<{ flowId: string }>()

    const flow = pendingOAuthFlows.get(body.flowId)
    if (!flow) {
      return c.json(
        { status: "error", error: "Invalid or expired flow ID" },
        400,
      )
    }

    // Poll for access token (with timeout)
    const token = await Promise.race([
      pollAccessToken(flow.deviceCode),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OAuth timeout")), 5 * 60 * 1000),
      ),
    ])

    // Remove the pending flow
    pendingOAuthFlows.delete(body.flowId)

    // Add the account to the pool
    const account = await addAccount(token, flow.label)

    if (!account) {
      return c.json({ status: "error", error: "Failed to add account" }, 400)
    }

    // addAccount now handles syncing to config.json internally

    return c.json({
      status: "ok",
      message: `Account ${account.login} added successfully`,
      account: {
        id: account.id,
        login: account.login,
        active: account.active,
      },
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/accounts/oauth/cancel - Cancel a pending OAuth flow
 */
webuiRoutes.post("/api/accounts/oauth/cancel", async (c) => {
  try {
    const body = await c.req.json<{ flowId: string }>()
    pendingOAuthFlows.delete(body.flowId)
    return c.json({ status: "ok", message: "OAuth flow cancelled" })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})
