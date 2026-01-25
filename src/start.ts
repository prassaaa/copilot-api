#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { addInitialAccount, getCurrentAccount } from "./lib/account-pool"
import { loadConfig, saveConfig, type Config } from "./lib/config"
import { costCalculator } from "./lib/cost-calculator"
import { logEmitter } from "./lib/logger"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { requestCache } from "./lib/request-cache"
import { requestHistory } from "./lib/request-history"
import { initQueue } from "./lib/request-queue"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import {
  setupAccountPool,
  setupCopilotToken,
  setupGitHubToken,
} from "./lib/token"
import { usageStats } from "./lib/usage-stats"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { webhook } from "./lib/webhook"
import { server } from "./server"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  debug: boolean
  fallback: boolean
  webuiPassword?: string
}

/**
 * Apply CLI options to state and config
 */
async function applyCliOptions(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose || options.debug) {
    consola.level = 5
    consola.info("Debug/verbose logging enabled")
  }

  if (options.fallback) {
    await saveConfig({ fallbackEnabled: true })
    consola.info("Model fallback enabled via CLI")
  }

  if (options.webuiPassword) {
    await saveConfig({ webuiPassword: options.webuiPassword })
    consola.info("WebUI password set via CLI")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
}

/**
 * Setup Claude Code integration if requested
 */
async function setupClaudeCodeIntegration(serverUrl: string): Promise<void> {
  invariant(state.models, "Models should be loaded by now")

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    {
      type: "select",
      options: state.models.data.map((model) => model.id),
    },
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: state.models.data.map((model) => model.id),
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

/**
 * Initialize core services
 */
async function initializeServices(config: Config): Promise<void> {
  await ensurePaths()
  await cacheVSCodeVersion()
  await usageStats.init()
  await requestHistory.init()
  await requestCache.init()
  await costCalculator.init()
  await webhook.init()
  initQueue({
    enabled: config.queueEnabled,
    maxConcurrent: config.queueMaxConcurrent,
    maxSize: config.queueMaxSize,
    timeout: config.queueTimeout,
  })
}

/**
 * Setup GitHub token based on pool or CLI options
 */
async function setupGitHubAuth(
  options: RunServerOptions,
  config: Config,
  poolConfig: boolean,
): Promise<void> {
  if (poolConfig) {
    const poolToken = config.poolAccounts[0]?.token
    if (poolToken) {
      state.githubToken = poolToken
      consola.info("Using pooled GitHub token for Copilot bootstrap")
    }
    // Sync state.githubUser from current account in pool
    const currentAccount = getCurrentAccount()
    if (currentAccount) {
      state.githubUser = {
        login: currentAccount.login,
        id: Number(currentAccount.id) || 0,
      }
      state.githubToken = currentAccount.token
      consola.info(`Current pool account: ${currentAccount.login}`)
    }
  } else if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }
}

/**
 * Add initial account to pool if needed
 */
async function addInitialAccountIfNeeded(poolConfig: boolean): Promise<void> {
  if (!poolConfig && state.githubToken && state.githubUser) {
    await addInitialAccount(state.githubToken, {
      login: state.githubUser.login,
      id: state.githubUser.id,
      name: state.githubUser.name ?? undefined,
      avatar_url: state.githubUser.avatar_url,
    })
  }
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const config = await loadConfig()
  state.rateLimitSeconds = config.rateLimitSeconds
  state.rateLimitWait = config.rateLimitWait
  await applyCliOptions(options)

  await initializeServices(config)

  // Always try to setup account pool to load saved accounts
  await setupAccountPool()
  const poolConfigured = config.poolEnabled && config.poolAccounts.length > 0

  await setupGitHubAuth(options, config, poolConfigured)
  await setupCopilotToken(state.githubToken)
  await cacheModels()
  await addInitialAccountIfNeeded(poolConfigured)

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    await setupClaudeCodeIntegration(serverUrl)
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  logEmitter.log("success", `Server started on ${serverUrl}`)

  // Get user from pool account first, fallback to state.githubUser
  const currentUser =
    getCurrentAccount()?.login || state.githubUser?.login || "Unknown"
  logEmitter.log(
    "info",
    `User: ${currentUser}, Models: ${state.models?.data.length || 0}`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    debug: {
      alias: "d",
      type: "boolean",
      default: false,
      description: "Enable debug mode (verbose logging)",
    },
    fallback: {
      alias: "f",
      type: "boolean",
      default: false,
      description:
        "Enable automatic model fallback when requested model is unavailable",
    },
    "webui-password": {
      type: "string",
      description: "Set WebUI password for authentication",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      rateLimitRaw ? Number.parseInt(rateLimitRaw, 10) : undefined

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      debug: args.debug,
      fallback: args.fallback,
      webuiPassword: args["webui-password"],
    })
  },
})
