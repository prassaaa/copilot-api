import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = process.env.COPILOT_CHAT_VERSION?.trim() || "0.37.0"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

// Optional override. Leave unset to let GitHub use its current default version.
const GITHUB_API_VERSION = process.env.GITHUB_API_VERSION?.trim()

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (
  state: State,
  vision: boolean = false,
  token?: string,
) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (GITHUB_API_VERSION) headers["x-github-api-version"] = GITHUB_API_VERSION
  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => {
  const headers: Record<string, string> = {
    ...standardHeaders(),
    authorization: `token ${state.githubToken}`,
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (GITHUB_API_VERSION) headers["x-github-api-version"] = GITHUB_API_VERSION

  return headers
}

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
