import { createHash, randomUUID } from "node:crypto"
import { networkInterfaces } from "node:os"

import { buildBetaHeaders } from "./beta-features"
import { state } from "./state"

const OPENCODE_GITHUB_CLIENT_ID = "Ov23li8tweQw6odWQebz"

export const isOpencodeOauthApp = (): boolean => {
  return process.env.COPILOT_API_OAUTH_APP === "opencode"
}

export const normalizeDomain = (domain: string): string => {
  return domain.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

export const getEnterpriseDomain = (): string | undefined => {
  const url = process.env.COPILOT_API_ENTERPRISE_URL
  return url ? normalizeDomain(url) : undefined
}

export const getGitHubBaseUrl = (): string => {
  const enterprise = getEnterpriseDomain()
  return enterprise ? `https://${enterprise}` : "https://github.com"
}

export const getGitHubApiBaseUrl = (): string => {
  const enterprise = getEnterpriseDomain()
  return enterprise ? `https://api.${enterprise}` : "https://api.github.com"
}

export const getOauthAppConfig = () => {
  if (isOpencodeOauthApp()) {
    return {
      clientId: OPENCODE_GITHUB_CLIENT_ID,
      userAgent: "opencode/1.0.0",
    }
  }
  return {
    clientId: "Iv1.b507a08c87ecfe98",
    userAgent: `vscode/${state.vsCodeVersion ?? "1.99.0"}`,
  }
}

export const prepareForCompact = (
  headers: Record<string, string>,
  isCompact?: boolean,
): void => {
  if (isCompact) {
    headers["x-initiator"] = "agent"
  }
}

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.35.0"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

const API_VERSION = "2025-10-01"

/**
 * Stable per-machine identifier derived from the first valid network MAC
 * address (SHA-256 hashed).  VS Code sends a `vscode-machineid` header and
 * some Copilot API endpoints reject requests that lack it.
 */
function generateMachineId(): string {
  const INVALID_MACS = new Set(["00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"])
  const interfaces = networkInterfaces()
  for (const [, addrs] of Object.entries(interfaces)) {
    for (const iface of addrs ?? []) {
      if (iface.mac && !INVALID_MACS.has(iface.mac)) {
        return createHash("sha256").update(iface.mac, "utf8").digest("hex")
      }
    }
  }
  // Fallback — should rarely happen on real machines
  return createHash("sha256").update(randomUUID()).digest("hex")
}

const MACHINE_ID = generateMachineId()

// Session ID for maintaining conversation context
const currentSessionId = randomUUID() + Date.now().toString()

/**
 * Get or generate a stable session ID for the current session
 */
export function getSessionId(): string {
  return currentSessionId
}

/**
 * Generate a deterministic request ID from content for deduplication
 */
export function generateRequestId(content: string, sessionId?: string): string {
  const input = (sessionId ?? "") + MACHINE_ID + content
  const uuidBytes = createHash("sha256").update(input).digest().subarray(0, 16)

  // Set version (4) and variant bits
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80

  const hex = uuidBytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const copilotBaseUrl = (stateArg: { accountType: string }) =>
  stateArg.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${stateArg.accountType}.githubcopilot.com`

export interface CopilotHeadersOptions {
  vision?: boolean
  token?: string
  /** Set to true if this is a subagent request (for quota optimization) */
  isSubagent?: boolean
  /** Session ID for interaction tracking */
  sessionId?: string
  /** Request ID for deduplication */
  requestId?: string
  /** Beta features header from client (will be filtered) */
  betaHeader?: string
}

export const copilotHeaders = (
  stateArg: {
    accountType: string
    vsCodeVersion?: string
    copilotToken?: string
    vsCodeSessionId?: string
    macMachineId?: string
  },
  options: CopilotHeadersOptions = {},
) => {
  const {
    vision = false,
    token,
    isSubagent = false,
    sessionId,
    requestId,
    betaHeader,
  } = options

  const reqId = requestId ?? randomUUID()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? stateArg.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${stateArg.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-github-api-version": API_VERSION,
    "x-request-id": reqId,
    "x-agent-task-id": reqId,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "vscode-machineid": MACHINE_ID,
    "vscode-sessionid": getSessionId(),
  }

  if (vision) headers["copilot-vision-request"] = "true"

  // Add interaction headers for quota optimization
  if (isSubagent) {
    // Subagent requests should be marked as agent-initiated
    // and classified as subagent conversation type
    headers["x-initiator"] = "agent"
    headers["x-interaction-type"] = "conversation-subagent"
  } else {
    headers["x-interaction-type"] = "conversation-agent"
  }

  // Add session-based interaction ID for request deduplication
  if (sessionId) {
    headers["x-interaction-id"] = sessionId
  }

  // Add filtered beta features headers
  const betaHeaders = buildBetaHeaders(betaHeader)
  Object.assign(headers, betaHeaders)

  return headers
}

/**
 * Prepare interaction headers based on subagent status and session
 * Used by services to add appropriate headers for quota tracking
 */
export function prepareInteractionHeaders(
  sessionId: string | undefined,
  isSubagent: boolean,
  headers: Record<string, string>,
): void {
  const sendInteractionHeaders = !isOpencodeOauthApp()

  if (isSubagent) {
    headers["x-initiator"] = "agent"
    if (sendInteractionHeaders) {
      headers["x-interaction-type"] = "conversation-subagent"
    }
  }

  if (sessionId && sendInteractionHeaders) {
    headers["x-interaction-id"] = sessionId
  }
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (stateArg: {
  githubToken?: string
  vsCodeVersion?: string
}) => ({
  ...standardHeaders(),
  authorization: `token ${stateArg.githubToken}`,
  "editor-version": `vscode/${stateArg.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
