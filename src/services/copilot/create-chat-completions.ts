import consola from "consola"
import { events } from "fetch-event-stream"

import type { Model } from "~/services/copilot/get-models"

import {
  getCurrentAccount,
  isPoolEnabledSync,
  reportAccountError,
} from "~/lib/account-pool"
import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithTimeout, RequestTimeoutError } from "~/lib/fetch-with-timeout"
import { logEmitter } from "~/lib/logger"
import { isClaude45AutoReasoningModel } from "~/lib/model-level"
import { sleep } from "~/lib/retry"
import { state } from "~/lib/state"
import { getActiveCopilotToken } from "~/lib/token"
import { normalizeModelLevelSuffix } from "~/routes/chat-completions/normalize-payload"
import { getChatCompletionTimeout } from "~/services/copilot/chat-completion-timeout"
import {
  findFallbackModelForFailedResponse,
  isModelSpecificRateLimit,
  type CopilotErrorBody,
} from "~/services/copilot/fallback-selection"

import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "./chat-completion-types"
import { normalizePayloadContent } from "./content-normalization"

// Re-export types for backwards compatibility

const MAX_CHAT_COMPLETION_RETRY_ATTEMPTS = 3
const INITIAL_CHAT_COMPLETION_RETRY_DELAY_MS = 500
const MAX_CHAT_COMPLETION_RETRY_DELAY_MS = 8000
const RETRYABLE_RESPONSE_STATUSES = new Set([429, 500, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
])
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

/**
 * Get account info string for error messages
 */
function getAccountInfoForError(): string {
  if (isPoolEnabledSync()) {
    const account = getCurrentAccount()
    if (account) {
      return `${account.login} (Pool Account #${account.id})`
    }
  }
  return state.githubUser?.login || "Primary Account"
}

function extractErrorCode(
  errorBody: CopilotErrorBody | null,
): string | undefined {
  return errorBody?.error?.code?.toLowerCase()
}

function extractErrorMessage(errorBody: CopilotErrorBody | null): string {
  return errorBody?.error?.message?.toLowerCase() ?? ""
}

function isQuotaExceededError(errorBody: CopilotErrorBody | null): boolean {
  const code = extractErrorCode(errorBody)
  const message = extractErrorMessage(errorBody)
  return (
    code === "quota_exceeded"
    || code === "insufficient_quota"
    || message.includes("no quota")
    || message.includes("quota exceeded")
  )
}

function getRateLimitResetAt(response: Response): number | undefined {
  const retryAfterRaw = response.headers.get("retry-after")
  if (!retryAfterRaw) return undefined

  const retrySeconds = Number.parseInt(retryAfterRaw, 10)
  if (!Number.isNaN(retrySeconds)) {
    return Date.now() + retrySeconds * 1000
  }

  const retryAt = Date.parse(retryAfterRaw)
  if (!Number.isNaN(retryAt)) {
    return retryAt
  }

  return undefined
}

function getRetryBackoffDelay(attempt: number): number {
  const delay =
    INITIAL_CHAT_COMPLETION_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
  const jitter = delay * 0.2 * (Math.random() - 0.5)
  return Math.min(
    Math.max(Math.round(delay + jitter), 0),
    MAX_CHAT_COMPLETION_RETRY_DELAY_MS,
  )
}

function getRetryDelayMs(attempt: number, response?: Response): number {
  if (response) {
    const retryAt = getRateLimitResetAt(response)
    if (retryAt !== undefined) {
      return Math.min(
        Math.max(retryAt - Date.now(), 0),
        MAX_CHAT_COMPLETION_RETRY_DELAY_MS,
      )
    }
  }
  return getRetryBackoffDelay(attempt)
}

function isRetryableRequestError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  // AbortError means the client disconnected or the request was intentionally
  // cancelled — never retry these since subsequent attempts would also abort.
  if (
    error instanceof RequestTimeoutError
    || (error instanceof Error && error.name === "AbortError")
  ) {
    return false
  }

  const code = (error as { code?: string }).code
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true

  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  return (
    error.name === "TimeoutError"
    || message.includes("timeout")
    || message.includes("network")
    || message.includes("fetch failed")
  )
}

async function parseCopilotErrorBody(
  response: Response,
): Promise<CopilotErrorBody | null> {
  try {
    const parsed: unknown = await response.clone().json()
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      return parsed as CopilotErrorBody
    }
  } catch {
    // Ignore parse errors
  }
  return null
}

function buildFallbackPayload(
  payload: ChatCompletionsPayload,
  fallbackModel: string,
): ChatCompletionsPayload {
  const shouldReconcileFallbackReasoning =
    payload.thinking !== undefined
    || isClaude45AutoReasoningModel(fallbackModel)

  if (!shouldReconcileFallbackReasoning) {
    return {
      ...payload,
      model: fallbackModel,
    }
  }

  return normalizeModelLevelSuffix({
    ...payload,
    model: fallbackModel,
    reasoning_effort: undefined,
    thinking: undefined,
  })
}

function supportsChatCompletionsEndpoint(model: Model): boolean {
  if (!model.supported_endpoints || model.supported_endpoints.length === 0) {
    return true
  }
  return model.supported_endpoints.includes(CHAT_COMPLETIONS_ENDPOINT)
}

function getSharedPrefixLength(left: string, right: string): number {
  const minLength = Math.min(left.length, right.length)
  let index = 0
  while (index < minLength && left[index] === right[index]) {
    index++
  }
  return index
}

type TierModelFamily = "gpt" | "claude-opus" | "claude-sonnet"

interface ParsedTierModel {
  codex: boolean
  family: TierModelFamily
  major: number
  minor: number
}

function parseTierModel(modelId: string): ParsedTierModel | null {
  // Updated regex to support codex variants with suffixes like -max, -mini
  const gptMatch = /^gpt-(\d+)(?:\.(\d+))?(-codex(?:-\w+)?)?$/.exec(modelId)
  if (gptMatch) {
    const minorVersion = gptMatch[2] || "0"
    return {
      codex: Boolean(gptMatch[3]),
      family: "gpt",
      major: Number.parseInt(gptMatch[1], 10),
      minor: Number.parseInt(minorVersion, 10),
    }
  }

  const claudeMatch =
    /^(claude-(?:opus|sonnet))-(\d+)(?:[.-](\d+))?(?:-\d{8})?$/.exec(modelId)
  if (claudeMatch) {
    const minorVersion = claudeMatch[3] || "0"
    return {
      codex: false,
      family: claudeMatch[1] as TierModelFamily,
      major: Number.parseInt(claudeMatch[2], 10),
      minor: Number.parseInt(minorVersion, 10),
    }
  }

  return null
}

function compareTierModel(
  left: Pick<ParsedTierModel, "major" | "minor">,
  right: Pick<ParsedTierModel, "major" | "minor">,
): number {
  if (left.major !== right.major) {
    return left.major - right.major
  }
  return left.minor - right.minor
}

function getLowerTierCandidates(
  requestedModelId: string,
  compatibleModels: Array<Model>,
): Array<string> {
  const requestedModel = parseTierModel(requestedModelId)
  if (!requestedModel) {
    return []
  }

  const candidates: Array<{
    id: string
    parsed: ParsedTierModel
  }> = []

  for (const model of compatibleModels) {
    const parsed = parseTierModel(model.id)
    if (!parsed || parsed.family !== requestedModel.family) {
      continue
    }

    if (
      requestedModel.family === "gpt"
      && parsed.codex !== requestedModel.codex
    ) {
      continue
    }

    if (compareTierModel(parsed, requestedModel) < 0) {
      candidates.push({
        id: model.id,
        parsed,
      })
    }
  }

  candidates.sort((left, right) => compareTierModel(right.parsed, left.parsed))
  return candidates.map((candidate) => candidate.id)
}

function getModelVariants(modelId: string): Array<string> {
  const variants = new Set<string>()

  const withoutCodex = modelId.replace(/-codex(?:-\w+)?$/, "")
  if (withoutCodex !== modelId) {
    variants.add(withoutCodex)
  }

  // Remove codex variant suffix (e.g., gpt-5.1-codex-max -> gpt-5.1-codex)
  const withoutCodexSuffix = modelId.replace(/-codex-\w+$/, "-codex")
  if (withoutCodexSuffix !== modelId) {
    variants.add(withoutCodexSuffix)
  }

  // Condense minor version for all models (e.g., gpt-5.1 -> gpt-5, gpt-5.1-codex-max -> gpt-5-codex-max)
  const condensedMinor = modelId.replace(/\.\d+(?=-|$)/, "")
  if (condensedMinor !== modelId) {
    variants.add(condensedMinor)
  }
  const withoutMinorVersion = modelId.replaceAll(/\.\d+(?=-|$)/g, "")
  if (withoutMinorVersion !== modelId) {
    variants.add(withoutMinorVersion)
  }

  const withoutDatedSuffix = modelId.replace(/-\d{8}$/, "")
  if (withoutDatedSuffix !== modelId) {
    variants.add(withoutDatedSuffix)
  }

  variants.delete(modelId)
  return [...variants]
}

function scoreFallbackCandidate(
  requestedModelId: string,
  requestedModel: Model | undefined,
  candidateModel: Model,
): number {
  let score = 0

  if (requestedModel && candidateModel.vendor === requestedModel.vendor) {
    score += 50
  }

  if (
    requestedModel
    && candidateModel.capabilities.family === requestedModel.capabilities.family
  ) {
    score += 80
  }

  if (
    requestedModelId.includes("codex") === candidateModel.id.includes("codex")
  ) {
    score += 15
  }

  score += Math.min(
    getSharedPrefixLength(requestedModelId, candidateModel.id),
    40,
  )

  if (!candidateModel.preview) {
    score += 5
  }

  return score
}

function findChatCompletionsCompatibleFallback(modelId: string): string | null {
  const allModels = state.models?.data ?? []
  const compatibleModels = allModels.filter(
    (model) => model.id !== modelId && supportsChatCompletionsEndpoint(model),
  )
  if (compatibleModels.length === 0) {
    return null
  }

  const compatibleModelMap = new Map(
    compatibleModels.map((model) => [model.id, model]),
  )

  for (const lowerTierCandidate of getLowerTierCandidates(
    modelId,
    compatibleModels,
  )) {
    if (compatibleModelMap.has(lowerTierCandidate)) {
      return lowerTierCandidate
    }
  }

  for (const variant of getModelVariants(modelId)) {
    if (compatibleModelMap.has(variant)) {
      return variant
    }
  }

  const requestedModel = allModels.find((model) => model.id === modelId)
  compatibleModels.sort((left, right) => {
    const rightScore = scoreFallbackCandidate(modelId, requestedModel, right)
    const leftScore = scoreFallbackCandidate(modelId, requestedModel, left)
    if (rightScore !== leftScore) {
      return rightScore - leftScore
    }
    return left.id.localeCompare(right.id)
  })

  return compatibleModels[0]?.id ?? null
}

function reportPoolError(
  response: Response,
  errorBody: CopilotErrorBody | null,
): void {
  if (!isPoolEnabledSync()) {
    return
  }

  const status = response.status
  if (status === 429) {
    // Don't mark account as rate-limited for model-specific rate limits
    // The model itself is throttled, not the account
    if (isModelSpecificRateLimit(errorBody)) {
      consola.info(
        "Model-specific rate limit detected, account not marked as rate-limited",
      )
      return
    }
    reportAccountError("rate-limit", getRateLimitResetAt(response))
    return
  }
  if (status === 401 || status === 403) {
    reportAccountError("auth")
    return
  }
  if (isQuotaExceededError(errorBody)) {
    reportAccountError("quota")
    return
  }

  reportAccountError("other")
}

async function handleFailedCompletion(params: {
  response: Response
  payload: ChatCompletionsPayload
}): Promise<never> {
  const { response, payload } = params

  const accountInfo = getAccountInfoForError()
  const errorBody = await parseCopilotErrorBody(response)

  consola.error(
    `Failed to create chat completions: ${response.status} ${response.statusText}`,
  )
  consola.error(`Account: ${accountInfo}`)
  consola.error(`Model requested: ${payload.model}`)

  logEmitter.log(
    "error",
    `API Error ${response.status}: ${errorBody?.error?.message || response.statusText} (model=${payload.model}, account=${accountInfo})`,
  )

  try {
    reportPoolError(response, errorBody)
  } catch (rotationError) {
    consola.warn(
      "Failed to record account error for pool rotation:",
      rotationError,
    )
  }

  if (errorBody?.error?.code === "model_not_supported") {
    consola.box(
      `⚠️  Model "${payload.model}" is not supported for this account.\n\n`
        + `Account: ${accountInfo}\n\n`
        + `To fix this:\n`
        + `1. Go to https://github.com/settings/copilot\n`
        + `2. Enable the model in "Models" section\n`
        + `3. Or use a different model that is already enabled`,
    )
    logEmitter.log(
      "warn",
      `Model "${payload.model}" not supported for account ${accountInfo}`,
    )
  }

  throw new HTTPError("Failed to create chat completions", response)
}

async function parseSuccessfulCompletion(
  response: Response,
  stream: boolean | null | undefined,
): Promise<ChatCompletionResponse | ReturnType<typeof events>> {
  if (stream) {
    return events(response)
  }
  return (await response.json()) as ChatCompletionResponse
}

async function sendRequestWithRetry(params: {
  model: string
  sendRequest: (requestPayload: ChatCompletionsPayload) => Promise<Response>
  requestPayload: ChatCompletionsPayload
}): Promise<Response> {
  const { model, sendRequest, requestPayload } = params
  let lastError: unknown

  for (
    let attempt = 1;
    attempt <= MAX_CHAT_COMPLETION_RETRY_ATTEMPTS;
    attempt++
  ) {
    try {
      const response = await sendRequest(requestPayload)

      // Don't retry if it's a model-specific rate limit - fallback should handle it
      if (response.status === 429) {
        const clonedResponse = response.clone()
        const errorBody = await parseCopilotErrorBody(
          clonedResponse as Response,
        )
        if (isModelSpecificRateLimit(errorBody)) {
          consola.warn(
            `Model-specific rate limit hit for "${model}". Skipping retries, will attempt fallback.`,
          )
          return response
        }
      }

      if (
        !RETRYABLE_RESPONSE_STATUSES.has(response.status)
        || attempt === MAX_CHAT_COMPLETION_RETRY_ATTEMPTS
      ) {
        return response
      }

      const delayMs = getRetryDelayMs(attempt, response)
      const message =
        `Transient upstream status ${response.status} for model `
        + `"${model}". Retrying (${attempt}/${MAX_CHAT_COMPLETION_RETRY_ATTEMPTS}) in ${delayMs}ms.`
      consola.warn(message)
      logEmitter.log("warn", message)
      if (delayMs > 0) {
        await sleep(delayMs)
      }
    } catch (error) {
      lastError = error

      if (
        !isRetryableRequestError(error)
        || attempt === MAX_CHAT_COMPLETION_RETRY_ATTEMPTS
      ) {
        throw error
      }

      const delayMs = getRetryDelayMs(attempt)
      const reason = error instanceof Error ? error.message : String(error)
      const message =
        `Transient upstream request error for model "${model}": `
        + `${reason}. Retrying (${attempt}/${MAX_CHAT_COMPLETION_RETRY_ATTEMPTS}) in ${delayMs}ms.`
      consola.warn(message)
      logEmitter.log("warn", message)
      if (delayMs > 0) {
        await sleep(delayMs)
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }
  throw new Error("Failed to create chat completions after retries")
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: {
    signal?: AbortSignal
    isSubagent?: boolean
    sessionId?: string
  } = {},
) => {
  const { signal, isSubagent = false, sessionId } = options
  // Normalize model level suffix (e.g., claude-opus-4.6(high) -> claude-opus-4.6 + reasoning_effort)
  const levelNormalizedPayload = normalizeModelLevelSuffix(payload)
  const normalizedPayload = normalizePayloadContent(levelNormalizedPayload)

  // Get token from pool (with tracking) or fallback to state
  const token = await getActiveCopilotToken()

  // Agent/user check for X-Initiator header.
  // Only the latest turn should decide initiator type.
  // If isSubagent is true, always use "agent" to save quota.
  const lastMessage = normalizedPayload.messages.at(-1)
  const isAgentCall =
    isSubagent
    || lastMessage?.role === "assistant"
    || lastMessage?.role === "tool"

  // Detect if this request includes tool definitions for agentic mode
  const hasTools = (normalizedPayload.tools?.length ?? 0) > 0

  if (hasTools) {
    consola.debug(
      `Agentic request: tools=${normalizedPayload.tools?.length}, tool_choice=${JSON.stringify(normalizedPayload.tool_choice)}`,
    )
  }

  const buildHeaders = (requestPayload: ChatCompletionsPayload) => {
    const payloadEnableVision = requestPayload.messages.some(
      (x) =>
        typeof x.content !== "string"
        && x.content?.some((x) => x.type === "image_url"),
    )
    return {
      ...copilotHeaders(state, {
        vision: payloadEnableVision,
        token,
        isSubagent,
        sessionId,
      }),
      "X-Initiator": isAgentCall ? "agent" : "user",
    }
  }

  const sendRequest = (requestPayload: ChatCompletionsPayload) =>
    fetchWithTimeout(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(requestPayload),
      body: JSON.stringify(requestPayload),
      timeout: getChatCompletionTimeout(),
      signal,
    })

  const response = await sendRequestWithRetry({
    model: normalizedPayload.model,
    sendRequest,
    requestPayload: normalizedPayload,
  })

  if (!response.ok) {
    const errorBody = await parseCopilotErrorBody(response)
    const fallbackSelection = findFallbackModelForFailedResponse({
      requestedModel: normalizedPayload.model,
      response,
      errorBody,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
      findCompatibleFallback: findChatCompletionsCompatibleFallback,
    })

    if (fallbackSelection) {
      const fallbackPayload = buildFallbackPayload(
        normalizedPayload,
        fallbackSelection.model,
      )
      const message =
        fallbackSelection.reason === "unsupported-endpoint" ?
          `Model "${normalizedPayload.model}" is not compatible with ${CHAT_COMPLETIONS_ENDPOINT}; retrying with "${fallbackSelection.model}".`
        : `Model "${normalizedPayload.model}" is capacity-limited upstream; retrying with fallback "${fallbackSelection.model}".`
      consola.warn(message)
      logEmitter.log("warn", message)

      const fallbackResponse = await sendRequestWithRetry({
        model: fallbackPayload.model,
        sendRequest,
        requestPayload: fallbackPayload,
      })
      if (!fallbackResponse.ok) {
        return handleFailedCompletion({
          response: fallbackResponse,
          payload: fallbackPayload,
        })
      }

      return parseSuccessfulCompletion(fallbackResponse, fallbackPayload.stream)
    }

    return handleFailedCompletion({
      response,
      payload: normalizedPayload,
    })
  }

  return parseSuccessfulCompletion(response, normalizedPayload.stream)
}

export {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type ImagePart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "./chat-completion-types"
