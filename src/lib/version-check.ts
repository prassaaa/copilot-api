import { execSync } from "node:child_process"

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

function getRemoteCommitFromGit(): string {
  // Fetch latest from remote and get the commit hash
  execSync("git fetch origin --quiet", { stdio: "pipe" })
  return execSync(`git rev-parse origin/${DEFAULT_BRANCH}`, { stdio: "pipe" })
    .toString()
    .trim()
}

export function checkVersion(): VersionCheckResult {
  const now = Date.now()
  if (cachedResult && now - lastChecked < CACHE_TTL_MS) {
    return cachedResult
  }

  const updateCommand = `git pull origin ${DEFAULT_BRANCH}`

  try {
    const local = getLocalCommit()
    const remote = getRemoteCommitFromGit()

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
    return result
  }
}
