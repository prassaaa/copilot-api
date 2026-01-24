import { execSync } from "node:child_process"

const REPO_OWNER = "prassaaa"
const REPO_NAME = "copilot-api"
const DEFAULT_BRANCH = "main"
const CACHE_TTL_MS = 5 * 60 * 1000

export interface VersionCheckResult {
  status: "ok" | "outdated" | "error"
  local: string | null
  remote: string | null
  message?: string
  updateCommand: string
}

let cachedResult: VersionCheckResult | null = null
let lastChecked = 0

function setCachedResult(result: VersionCheckResult, checkedAt: number): void {
  cachedResult = result
  lastChecked = checkedAt
}

function getLocalCommit(): string {
  return execSync("git rev-parse HEAD", { stdio: "pipe" }).toString().trim()
}

async function getRemoteCommit(): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${DEFAULT_BRANCH}`,
  )
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`)
  }
  const data = (await response.json()) as { sha?: string }
  if (!data.sha) {
    throw new Error("Invalid GitHub API response")
  }
  return data.sha
}

export async function checkVersion(): Promise<VersionCheckResult> {
  const now = Date.now()
  if (cachedResult && now - lastChecked < CACHE_TTL_MS) {
    return cachedResult
  }

  const updateCommand = `git pull origin ${DEFAULT_BRANCH}`

  try {
    const local = getLocalCommit()
    const remote = await getRemoteCommit()

    const result: VersionCheckResult =
      local === remote ?
        { status: "ok", local, remote, updateCommand }
      : {
          status: "outdated",
          local,
          remote,
          updateCommand,
          message: "Local dashboard is not up to date.",
        }

    setCachedResult(result, now)
    return result
  } catch (error) {
    const result: VersionCheckResult = {
      status: "error",
      local: null,
      remote: null,
      updateCommand,
      message: error instanceof Error ? error.message : "Version check failed.",
    }
    setCachedResult(result, now)
    return result
  }
}
