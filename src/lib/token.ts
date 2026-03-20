import consola from "consola"
import fs from "node:fs/promises"

import {
  getPooledCopilotToken,
  initializePool,
  isPoolEnabledSync,
} from "~/lib/account-pool"
import { getConfig } from "~/lib/config"
import { registerInterval } from "~/lib/intervals"
import { PATHS } from "~/lib/paths"
import { sleep } from "~/lib/retry"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { formatErrorForLog, HTTPError } from "./error"
import { state } from "./state"

// Constants for token refresh retry logic
const MAX_TOKEN_REFRESH_RETRIES = 3

function maskToken(token: string): string {
  if (token.length <= 8) return "***"
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

const updateState = <K extends keyof typeof state>(
  key: K,
  value: (typeof state)[K],
) => {
  state[key] = value
}

/**
 * Get active Copilot token
 * Uses pool if enabled, otherwise single account
 */
export async function getActiveCopilotToken(): Promise<string> {
  if (isPoolEnabledSync()) {
    const poolToken = await getPooledCopilotToken()
    if (poolToken) {
      return poolToken
    }
    // Fall back to single account
  }

  if (!state.copilotToken) {
    throw new Error("No Copilot token available")
  }

  return state.copilotToken
}

export const setupCopilotToken = async (tokenOverride?: string) => {
  if (tokenOverride) {
    updateState("githubToken", tokenOverride)
  }
  const tokenSource = tokenOverride ?? state.githubToken
  const { token, refresh_in } = await getCopilotToken(tokenSource)
  updateState("copilotToken", token)

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", maskToken(token))
  }

  const refreshInterval = (refresh_in - 60) * 1000
  const intervalId = setInterval(async () => {
    consola.debug("Refreshing Copilot token")

    for (let attempt = 1; attempt <= MAX_TOKEN_REFRESH_RETRIES; attempt++) {
      try {
        const { token: newToken } = await getCopilotToken(tokenSource)
        updateState("copilotToken", newToken)
        consola.debug("Copilot token refreshed")
        if (state.showToken) {
          consola.info("Refreshed Copilot token:", maskToken(newToken))
        }
        return // Success, exit
      } catch (error) {
        consola.error(
          `Failed to refresh Copilot token (attempt ${attempt}/${MAX_TOKEN_REFRESH_RETRIES}): ${formatErrorForLog(error)}`,
        )
        if (attempt < MAX_TOKEN_REFRESH_RETRIES) {
          await sleep(attempt * 5000) // Exponential backoff
        }
      }
    }

    consola.error(
      "All token refresh attempts failed. Token may become invalid.",
    )
  }, refreshInterval)

  registerInterval("copilot-token-refresh", intervalId)
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      updateState("githubToken", githubToken)
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    updateState("githubToken", token)

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
  updateState("githubUser", user)
}

/**
 * Initialize account pool if configured
 */
export async function setupAccountPool(): Promise<void> {
  const config = getConfig()

  if (config.poolEnabled && config.poolAccounts.length > 0) {
    await initializePool({
      enabled: config.poolEnabled,
      strategy: config.poolStrategy,
      accounts: config.poolAccounts,
    })
  }
}
