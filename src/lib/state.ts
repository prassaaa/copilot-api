import type { ModelsResponse } from "~/services/copilot/get-models"

export interface GitHubUser {
  login: string
  id: number
  avatar_url?: string
  name?: string
}

export interface State {
  githubToken?: string
  copilotToken?: string
  githubUser?: GitHubUser
  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
