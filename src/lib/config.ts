/**
 * Configuration Management
 * Handles persistent configuration with file storage
 */

import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { SelectionStrategy } from "./account-pool"

// Provider configuration types
export interface ProviderConfig {
  type: "anthropic"
  enabled: boolean
  baseUrl: string
  apiKey: string
  adjustInputTokens?: boolean
  models?: Record<
    string,
    {
      temperature?: number
      topP?: number
      topK?: number
    }
  >
}

// Default configuration
const DEFAULT_CONFIG = {
  // Server settings
  port: 4141,
  debug: false,
  apiKeys: [] as Array<string>,

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

  // Quota optimization settings
  smallModel: "gpt-5-mini", // Model untuk warmup/compact requests (tidak pakai quota premium)
  compactUseSmallModel: true, // Route compact requests ke small model
  warmupUseSmallModel: true, // Route warmup requests (no tools) ke small model

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

  // Request timeout (for long model responses like Claude Opus)
  requestTimeoutMs: 300000, // 5 minutes default

  // Auto account rotation
  autoRotationEnabled: true,
  autoRotationTriggers: {
    quotaThreshold: 10,
    errorCount: 3,
    requestCount: 0, // 0 = disabled
  },
  autoRotationCooldownMinutes: 30,

  // Model reasoning efforts
  // fix: tambahkan gpt-5.4-mini dengan xhigh effort - 2026-03-24
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4-mini": "xhigh",
    "gpt-5.4": "xhigh",
  } as Record<string, "none" | "minimal" | "low" | "medium" | "high" | "xhigh">,

  // Extra prompts per model
  extraPrompts: {} as Record<string, string>,

  // Feature toggles
  useFunctionApplyPatch: true,
  useMessagesApi: true,

  // Context management models
  responsesApiContextManagementModels: [] as Array<string>,

  // Default max output tokens (32K default, can be increased up to model limit)
  // Claude models support up to 128K output tokens
  defaultMaxOutputTokens: 32768,

  // Context window override (0 = use model's default, >0 = override to this value)
  // Set to high value like 2000000 (2M) to effectively disable truncation
  // WARNING: GitHub Copilot API may reject requests exceeding actual model limits
  maxContextTokensOverride: 0,

  // Disable message truncation entirely (risky - may cause API errors)
  disableTruncation: false,
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
    if (process.env.CHAT_COMPLETION_TIMEOUT_MS) {
      const timeout = Number.parseInt(
        process.env.CHAT_COMPLETION_TIMEOUT_MS,
        10,
      )
      if (Number.isFinite(timeout) && timeout > 0) {
        config.requestTimeoutMs = timeout
      }
    }

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
export function getPublicConfig(): Omit<Config, "webuiPassword" | "apiKeys"> & {
  webuiPasswordSet: boolean
} {
  const { webuiPassword, apiKeys: _apiKeys, ...publicConfig } = config
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

/**
 * Get mapped model name from config
 * Returns the mapped model if a mapping exists, otherwise returns the original model
 */
export function getMappedModel(model: string): string {
  const mapping = config.modelMapping
  if (model in mapping) {
    return mapping[model]
  }
  return model
}

/**
 * Get reasoning effort for a specific model
 */
export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const efforts = config.modelReasoningEfforts
  if (model in efforts) {
    return efforts[model]
  }
  return "high" // default
}

/**
 * Get extra prompt for a specific model
 */
export function getExtraPromptForModel(model: string): string {
  const prompts = config.extraPrompts
  if (model in prompts) {
    return prompts[model]
  }
  return ""
}

/**
 * Check if Messages API is enabled
 */
export function isMessagesApiEnabled(): boolean {
  return config.useMessagesApi
}

/**
 * Get list of models that support context management
 */
export function getResponsesApiContextManagementModels(): Array<string> {
  return config.responsesApiContextManagementModels
}

/**
 * Check if a model supports Responses API context management
 */
export function isResponsesApiContextManagementModel(model: string): boolean {
  return getResponsesApiContextManagementModels().includes(model)
}

/**
 * Check if useFunctionApplyPatch is enabled
 */
export function isUseFunctionApplyPatchEnabled(): boolean {
  return config.useFunctionApplyPatch
}

/**
 * Get default max output tokens
 * Used when client doesn't specify max_tokens
 */
export function getDefaultMaxOutputTokens(): number {
  return config.defaultMaxOutputTokens
}

/**
 * Get max context tokens override
 * Returns 0 if no override, otherwise the override value
 */
export function getMaxContextTokensOverride(): number {
  return config.maxContextTokensOverride
}

/**
 * Check if truncation is disabled
 */
export function isTruncationDisabled(): boolean {
  return config.disableTruncation
}
