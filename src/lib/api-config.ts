import { createHash, randomUUID } from "node:crypto"
import { networkInterfaces } from "node:os"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.37.4"
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

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
interface CopilotHeadersOptions {
  vision?: boolean
  token?: string
}

export const copilotHeaders = (
  state: State,
  options: CopilotHeadersOptions = {},
) => {
  const { vision = false, token } = options
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
    "vscode-machineid": MACHINE_ID,
    "vscode-sessionid": randomUUID(),
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
