/**
 * Health Check Endpoint
 * Provides system health status for monitoring
 */

import { Hono } from "hono"

import { getAccountsStatus, isPoolEnabled } from "~/lib/account-pool"
import { getQueueStatus, type QueueStatus } from "~/lib/request-queue"
import { state } from "~/lib/state"

export interface HealthCheck {
  status: "healthy" | "degraded" | "unhealthy"
  timestamp: string
  uptime: number
  checks: {
    accounts: { status: string; active: number; total: number }
    models: { status: string; count: number }
    queue?: { status: string; size: number; maxSize: number }
  }
}

export const healthRoutes = new Hono()

type QueueHealth = { status: "paused" | "ok"; size: number; maxSize: number }

function getQueueHealth(): QueueHealth | undefined {
  const queueStatus: QueueStatus = getQueueStatus()
  if (!queueStatus.enabled) return undefined

  return {
    status: queueStatus.paused ? "paused" : "ok",
    size: queueStatus.size,
    maxSize: queueStatus.maxSize,
  }
}

function getOverallStatus(params: {
  modelsCount: number
  poolEnabled: boolean
  activeAccounts: number
  totalAccounts: number
  queueStatus?: QueueHealth
}): HealthCheck["status"] {
  const {
    modelsCount,
    poolEnabled,
    activeAccounts,
    totalAccounts,
    queueStatus,
  } = params

  if (modelsCount === 0) return "unhealthy"
  if (poolEnabled && activeAccounts === 0) return "unhealthy"
  if (poolEnabled && activeAccounts < totalAccounts / 2) return "degraded"
  if (queueStatus && queueStatus.size > queueStatus.maxSize * 0.8)
    return "degraded"
  return "healthy"
}

function getStatusCode(status: HealthCheck["status"]): 200 | 503 {
  if (status === "unhealthy") return 503
  return 200
}

/**
 * GET /health - Simple health check (no auth required)
 * Returns 200 OK if server is running
 */
healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  })
})

/**
 * GET /health/detailed - Detailed health check
 * Returns comprehensive health information
 */
healthRoutes.get("/detailed", async (c) => {
  // Check accounts
  const poolEnabled = await isPoolEnabled()
  const accounts = poolEnabled ? await getAccountsStatus() : []
  const activeAccounts = accounts.filter(
    (a) => a.active && !a.rateLimited && a.paused !== true,
  )

  // Check models
  const modelsCount = state.models?.data.length || 0

  // Check queue
  const queueStatus = getQueueHealth()

  const overallStatus = getOverallStatus({
    modelsCount,
    poolEnabled,
    activeAccounts: activeAccounts.length,
    totalAccounts: accounts.length,
    queueStatus,
  })

  const healthCheck: HealthCheck = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      accounts: {
        status: activeAccounts.length > 0 ? "ok" : "warning",
        active: activeAccounts.length,
        total: accounts.length,
      },
      models: {
        status: modelsCount > 0 ? "ok" : "error",
        count: modelsCount,
      },
    },
  }

  if (queueStatus) {
    healthCheck.checks.queue = queueStatus
  }

  return c.json(healthCheck, getStatusCode(overallStatus))
})

/**
 * GET /health/live - Kubernetes liveness probe
 */
healthRoutes.get("/live", (c) => {
  return c.json({ status: "ok" })
})

/**
 * GET /health/ready - Kubernetes readiness probe
 */
healthRoutes.get("/ready", (c) => {
  const modelsCount = state.models?.data.length || 0

  if (modelsCount === 0) {
    return c.json({ status: "not ready", reason: "models not loaded" }, 503)
  }

  return c.json({ status: "ready" })
})
