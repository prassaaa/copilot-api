/**
 * Configuration Management
 * Handles persistent configuration with file storage
 */

import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { SelectionStrategy } from "./account-pool"

// Default configuration
const DEFAULT_CONFIG = {
  // Server settings
  port: 4141,
  debug: false,

  // WebUI settings
  webuiPassword: "",

  // Rate limiting
  rateLimitSeconds: undefined as number | undefined,
  rateLimitWait: false,

  // Model fallback
  fallbackEnabled: false,
  modelMapping: {} as Record<string, string>,

  // Usage tracking
  trackUsage: true,

  // Claude CLI defaults
  defaultModel: "gpt-4.1",
  defaultSmallModel: "gpt-4.1",

  // Multi-account pool
  poolEnabled: false,
  poolStrategy: "sticky" as SelectionStrategy,
  poolAccounts: [] as Array<{ token: string; label?: string }>,

  // Request queue
  queueEnabled: false,
  queueMaxConcurrent: 3,
  queueMaxSize: 100,
  queueTimeout: 60000,

  // Cost tracking
  trackCost: true,

  // Webhook notifications
  webhookEnabled: false,
  webhookProvider: "discord" as "discord" | "slack" | "custom",
  webhookUrl: "",
  webhookEvents: {
    quotaLow: { enabled: true, threshold: 10 },
    accountError: true,
    rateLimitHit: true,
    accountRotation: true,
  },

  // Request caching
  cacheEnabled: true,
  cacheMaxSize: 1000,
  cacheTtlSeconds: 3600,

  // Auto account rotation
  autoRotationEnabled: true,
  autoRotationTriggers: {
    quotaThreshold: 10,
    errorCount: 3,
    requestCount: 0, // 0 = disabled
  },
  autoRotationCooldownMinutes: 30,
}

export type Config = typeof DEFAULT_CONFIG

// Config file path
const CONFIG_DIR = path.join(os.homedir(), ".config", "copilot-api")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")

// In-memory config
let config: Config = { ...DEFAULT_CONFIG }

// Mutex for config file operations
let configMutex = Promise.resolve()

async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = configMutex
  let resolver: (() => void) | undefined
  configMutex = new Promise((r) => {
    resolver = r
  })

  await release
  try {
    return await fn()
  } finally {
    if (resolver) resolver()
  }
}

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
  } catch (error) {
    // Only ignore EEXIST, log other errors
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      consola.warn("Failed to create config directory:", error)
    }
  }
}

/**
 * Load configuration from file
 */
export async function loadConfig(): Promise<Config> {
  return withConfigLock(async () => {
    try {
      await ensureConfigDir()

      const fileContent = await fs.readFile(CONFIG_FILE)
      const userConfig = JSON.parse(fileContent.toString()) as Partial<Config>
      config = { ...DEFAULT_CONFIG, ...userConfig }

      consola.debug("Configuration loaded from", CONFIG_FILE)
    } catch {
      // File doesn't exist or is invalid, use defaults
      consola.debug("Using default configuration")
    }

    // Environment variable overrides
    if (process.env.PORT) config.port = Number.parseInt(process.env.PORT, 10)
    if (process.env.DEBUG === "true") config.debug = true
    if (process.env.WEBUI_PASSWORD)
      config.webuiPassword = process.env.WEBUI_PASSWORD
    if (process.env.FALLBACK === "true") config.fallbackEnabled = true

    return config
  })
}

/**
 * Save configuration to file
 */
export async function saveConfig(updates: Partial<Config>): Promise<void> {
  return withConfigLock(async () => {
    try {
      await ensureConfigDir()

      config = { ...config, ...updates }
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))

      consola.debug("Configuration saved to", CONFIG_FILE)
    } catch (error) {
      consola.error("Failed to save configuration:", error)
      throw error
    }
  })
}

/**
 * Get current configuration (public, without sensitive data)
 */
export function getPublicConfig(): Omit<Config, "webuiPassword"> & {
  webuiPasswordSet: boolean
} {
  const { webuiPassword, ...publicConfig } = config
  return {
    ...publicConfig,
    webuiPasswordSet: Boolean(webuiPassword),
  }
}

/**
 * Get full configuration (internal use only)
 */
export function getConfig(): Config {
  return { ...config }
}

/**
 * Get config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR
}

/**
 * Get config file path
 */
export function getConfigFile(): string {
  return CONFIG_FILE
}
