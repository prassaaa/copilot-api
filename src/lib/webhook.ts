/**
 * Webhook Notifications Module
 * Sends alerts to Discord, Slack, or custom endpoints
 */

import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getConfig } from "./config"
import { registerShutdownHandler } from "./shutdown"

export type WebhookProvider = "discord" | "slack" | "custom"

export interface WebhookConfig {
  enabled: boolean
  provider: WebhookProvider
  webhookUrl: string
  events: {
    quotaLow: { enabled: boolean; threshold: number }
    accountError: boolean
    rateLimitHit: boolean
    accountRotation: boolean
  }
}

export interface WebhookHistoryEntry {
  timestamp: number
  event: string
  success: boolean
  error?: string
}

export type WebhookEventType =
  | "quota_low"
  | "account_error"
  | "rate_limit"
  | "account_rotation"
  | "test"

// File path for webhook history
const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const HISTORY_FILE = path.join(CONFIG_DIR, "webhook-history.json")

// In-memory state
let webhookConfig: WebhookConfig = {
  enabled: false,
  provider: "discord",
  webhookUrl: "",
  events: {
    quotaLow: { enabled: true, threshold: 10 },
    accountError: true,
    rateLimitHit: true,
    accountRotation: true,
  },
}

let webhookHistory: Array<WebhookHistoryEntry> = []
const MAX_HISTORY = 100

// Debounce timer for saving
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 1000

/**
 * Ensure config directory exists
 */
async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch (error) {
    // Only ignore EEXIST, log other errors
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      consola.warn("Failed to create webhook directory:", error)
    }
  }
}

/**
 * Load webhook history from disk
 */
async function loadHistory(): Promise<void> {
  try {
    await ensureDir()
    const data = await fs.readFile(HISTORY_FILE)
    webhookHistory = JSON.parse(data.toString()) as Array<WebhookHistoryEntry>
  } catch {
    webhookHistory = []
  }
}

/**
 * Save webhook history to disk (debounced)
 */
function saveHistory(): void {
  // Clear existing timer
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer)
  }

  // Set new debounced save
  saveDebounceTimer = setTimeout(() => {
    void saveHistoryImmediate()
  }, SAVE_DEBOUNCE_MS)
}

/**
 * Save webhook history immediately
 */
async function saveHistoryImmediate(): Promise<void> {
  try {
    await ensureDir()
    // Keep only recent entries
    if (webhookHistory.length > MAX_HISTORY) {
      webhookHistory = webhookHistory.slice(-MAX_HISTORY)
    }
    await fs.writeFile(HISTORY_FILE, JSON.stringify(webhookHistory, null, 2))
  } catch (error) {
    consola.error("Failed to save webhook history:", error)
  }
}

interface DiscordMessageOptions {
  event: WebhookEventType
  title: string
  description: string
  color?: number
}

/**
 * Build Discord message
 */
function buildDiscordMessage(options: DiscordMessageOptions): object {
  const { event, title, description, color } = options
  const colors = {
    quota_low: 16776960, // Yellow
    account_error: 16711680, // Red
    rate_limit: 16753920, // Orange
    account_rotation: 3447003, // Blue
    test: 5763719, // Green
  }

  const icons = {
    quota_low: "⚠️",
    account_error: "❌",
    rate_limit: "🚫",
    account_rotation: "🔄",
    test: "✅",
  }

  return {
    embeds: [
      {
        title: `${icons[event]} ${title}`,
        description,
        color: color || colors[event],
        timestamp: new Date().toISOString(),
        footer: {
          text: "Copilot API",
        },
      },
    ],
  }
}

/**
 * Build Slack message
 */
function buildSlackMessage(
  event: WebhookEventType,
  title: string,
  description: string,
): object {
  const colors = {
    quota_low: "warning",
    account_error: "danger",
    rate_limit: "warning",
    account_rotation: "#3447DB",
    test: "good",
  }

  const icons = {
    quota_low: ":warning:",
    account_error: ":x:",
    rate_limit: ":no_entry:",
    account_rotation: ":arrows_counterclockwise:",
    test: ":white_check_mark:",
  }

  return {
    attachments: [
      {
        color: colors[event],
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${icons[event]} *${title}*\n${description}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Copilot API • ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * Build custom webhook message
 */
function buildCustomMessage(
  event: WebhookEventType,
  title: string,
  description: string,
): object {
  return {
    event,
    title,
    description,
    timestamp: new Date().toISOString(),
    source: "copilot-api",
  }
}

/**
 * Check if an event type is enabled
 */
function isEventEnabled(event: WebhookEventType): boolean {
  switch (event) {
    case "test": {
      return true
    }
    case "quota_low": {
      return webhookConfig.events.quotaLow.enabled
    }
    case "account_error": {
      return webhookConfig.events.accountError
    }
    case "rate_limit": {
      return webhookConfig.events.rateLimitHit
    }
    case "account_rotation": {
      return webhookConfig.events.accountRotation
    }
    default: {
      return false
    }
  }
}

/**
 * Build message body based on provider
 */
function buildMessageBody(
  event: WebhookEventType,
  title: string,
  description: string,
): object {
  switch (webhookConfig.provider) {
    case "discord": {
      return buildDiscordMessage({ event, title, description })
    }
    case "slack": {
      return buildSlackMessage(event, title, description)
    }
    default: {
      return buildCustomMessage(event, title, description)
    }
  }
}

interface WebhookResultOptions {
  event: WebhookEventType
  title: string
  success: boolean
  error?: string
}

/**
 * Record webhook result in history
 */
function recordWebhookResult(options: WebhookResultOptions): void {
  webhookHistory.push({
    timestamp: Date.now(),
    event: `${options.event}: ${options.title}`,
    success: options.success,
    error: options.error,
  })
  saveHistory()
}

/**
 * Send webhook notification
 */
export async function sendWebhook(
  event: WebhookEventType,
  title: string,
  description: string,
): Promise<{ success: boolean; error?: string }> {
  if (!webhookConfig.enabled || !webhookConfig.webhookUrl) {
    return { success: false, error: "Webhook not configured" }
  }

  if (!isEventEnabled(event)) {
    return { success: false, error: "Event type disabled" }
  }

  const body = buildMessageBody(event, title, description)

  try {
    const response = await fetch(webhookConfig.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = `HTTP ${response.status}`
      recordWebhookResult({ event, title, success: false, error })
      consola.warn(`Webhook failed: ${error}`)
      return { success: false, error }
    }

    recordWebhookResult({ event, title, success: true })
    consola.debug(`Webhook sent: ${event} - ${title}`)
    return { success: true }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    recordWebhookResult({ event, title, success: false, error: errorMsg })
    consola.error("Webhook error:", errorMsg)
    return { success: false, error: errorMsg }
  }
}

/**
 * Send quota low alert
 */
export async function sendQuotaLowAlert(
  accountLogin: string,
  quotaPercent: number,
): Promise<void> {
  if (
    !webhookConfig.events.quotaLow.enabled
    || quotaPercent > webhookConfig.events.quotaLow.threshold
  ) {
    return
  }

  await sendWebhook(
    "quota_low",
    "Quota Low Alert",
    `Account **${accountLogin}** quota is at ${quotaPercent.toFixed(1)}%`,
  )
}

/**
 * Send account error alert
 */
export async function sendAccountErrorAlert(
  accountLogin: string,
  error: string,
): Promise<void> {
  if (!webhookConfig.events.accountError) return

  await sendWebhook(
    "account_error",
    "Account Error",
    `Account **${accountLogin}** encountered an error:\n\`\`\`${error}\`\`\``,
  )
}

/**
 * Send rate limit alert
 */
export async function sendRateLimitAlert(
  accountLogin: string,
  resetAt?: number,
): Promise<void> {
  if (!webhookConfig.events.rateLimitHit) return

  const resetTime = resetAt ? new Date(resetAt).toISOString() : "unknown"

  await sendWebhook(
    "rate_limit",
    "Rate Limit Hit",
    `Account **${accountLogin}** hit rate limit. Reset at: ${resetTime}`,
  )
}

/**
 * Send account rotation alert
 */
export async function sendAccountRotationAlert(
  fromAccount: string,
  toAccount: string,
  reason: string,
): Promise<void> {
  if (!webhookConfig.events.accountRotation) return

  await sendWebhook(
    "account_rotation",
    "Account Rotated",
    `Switched from **${fromAccount}** to **${toAccount}**\nReason: ${reason}`,
  )
}

/**
 * Test webhook configuration
 */
export async function testWebhook(): Promise<{
  success: boolean
  error?: string
}> {
  return sendWebhook(
    "test",
    "Webhook Test",
    "This is a test notification from Copilot API. If you see this, your webhook is configured correctly!",
  )
}

/**
 * Get webhook history
 */
export function getWebhookHistory(): Array<WebhookHistoryEntry> {
  return [...webhookHistory].reverse()
}

/**
 * Clear webhook history
 */
export function clearWebhookHistory(): void {
  webhookHistory = []
  saveHistory()
}

/**
 * Get webhook configuration
 */
export function getWebhookConfig(): WebhookConfig {
  return { ...webhookConfig }
}

/**
 * Update webhook configuration
 */
export function updateWebhookConfig(config: Partial<WebhookConfig>): void {
  webhookConfig = { ...webhookConfig, ...config }
  consola.debug("Webhook config updated")
}

/**
 * Initialize webhook module
 */
export async function initWebhook(): Promise<void> {
  // Load config
  const config = getConfig()
  webhookConfig = {
    enabled: config.webhookEnabled,
    provider: config.webhookProvider,
    webhookUrl: config.webhookUrl,
    events: config.webhookEvents,
  }

  await loadHistory()

  // Register shutdown handler for immediate save
  registerShutdownHandler("webhook", saveHistoryImmediate, 20)

  consola.debug(
    `Webhook module initialized: enabled=${webhookConfig.enabled}, provider=${webhookConfig.provider}`,
  )
}

export const webhook = {
  init: initWebhook,
  send: sendWebhook,
  sendQuotaLow: sendQuotaLowAlert,
  sendAccountError: sendAccountErrorAlert,
  sendRateLimit: sendRateLimitAlert,
  sendAccountRotation: sendAccountRotationAlert,
  test: testWebhook,
  getHistory: getWebhookHistory,
  clearHistory: clearWebhookHistory,
  getConfig: getWebhookConfig,
  updateConfig: updateWebhookConfig,
}
