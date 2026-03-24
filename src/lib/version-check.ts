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

function getRemoteCommit(branch: string): string {
  const output = execSync(`git ls-remote --heads origin ${branch}`, {
    stdio: "pipe",
  })
    .toString()
    .trim()

  const [sha] = output.split(/\s+/)
  if (!sha) {
    throw new Error(`Cannot resolve origin/${branch}`)
  }

  return sha
}

function isLocalUpToDate(local: string, remote: string): boolean {
  if (local === remote) {
    return true
  }

  try {
    execSync(`git merge-base --is-ancestor ${remote} ${local}`, {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

export function checkVersion(options?: {
  force?: boolean
}): VersionCheckResult {
  const force = options?.force === true
  const now = Date.now()
  if (!force && cachedResult && now - lastChecked < CACHE_TTL_MS) {
    return cachedResult
  }

  const updateCommand = `git pull origin ${DEFAULT_BRANCH}`

  try {
    const local = getLocalCommit()
    const remote = getRemoteCommit(DEFAULT_BRANCH)
    const upToDate = isLocalUpToDate(local, remote)

    const result: VersionCheckResult =
      upToDate ?
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
