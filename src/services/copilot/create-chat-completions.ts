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
import { fetchWithTimeout } from "~/lib/fetch-with-timeout"
import { logEmitter } from "~/lib/logger"
import { sleep } from "~/lib/retry"
import { state } from "~/lib/state"
import { getActiveCopilotToken } from "~/lib/token"
import { normalizeAssistantToolCalls } from "~/lib/tool-call-arguments"
import { CHAT_COMPLETION_TIMEOUT } from "~/services/copilot/chat-completion-timeout"
import {
  findFallbackModelForFailedResponse,
  type CopilotErrorBody,
} from "~/services/copilot/fallback-selection"

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isImageDetail(
  value: unknown,
): value is NonNullable<ImagePart["image_url"]["detail"]> {
  return value === "low" || value === "high" || value === "auto"
}

function toImageUrlPartFromImageUrl(
  imageUrlValue: unknown,
  includeDetail: boolean,
): ImagePart | null {
  if (typeof imageUrlValue === "string") {
    return { type: "image_url", image_url: { url: imageUrlValue } }
  }

  if (!isRecord(imageUrlValue) || typeof imageUrlValue.url !== "string") {
    return null
  }

  let detail: ImagePart["image_url"]["detail"] | undefined
  if (includeDetail && isImageDetail(imageUrlValue.detail)) {
    detail = imageUrlValue.detail
  }

  return {
    type: "image_url",
    image_url: {
      url: imageUrlValue.url,
      ...(detail ? { detail } : {}),
    },
  }
}

function toImageUrlPartFromSource(sourceValue: unknown): ImagePart | null {
  if (!isRecord(sourceValue)) {
    return null
  }

  if (
    sourceValue.type === "base64"
    && typeof sourceValue.media_type === "string"
    && typeof sourceValue.data === "string"
  ) {
    return {
      type: "image_url",
      image_url: {
        url: `data:${sourceValue.media_type};base64,${sourceValue.data}`,
      },
    }
  }

  if (sourceValue.type === "url" && typeof sourceValue.url === "string") {
    return { type: "image_url", image_url: { url: sourceValue.url } }
  }

  return null
}

function toImageUrlPart(part: Record<string, unknown>): ImagePart | null {
  if (part.type === "image_url") {
    return toImageUrlPartFromImageUrl(part.image_url, true)
  }

  if (part.type === "input_image") {
    return (
      toImageUrlPartFromImageUrl(part.image_url, false)
      ?? toImageUrlPartFromSource(part.source)
    )
  }

  if (part.type === "image") {
    return toImageUrlPartFromSource(part.source)
  }

  return null
}

function toTextPart(part: Record<string, unknown>): TextPart | null {
  const type = part.type

  if (
    (type === "text" || type === "input_text")
    && typeof part.text === "string"
  ) {
    return { type: "text", text: part.text }
  }

  if (type === "thinking" && typeof part.thinking === "string") {
    return { type: "text", text: part.thinking }
  }

  return null
}

function normalizeContentPart(part: unknown): ContentPart | null {
  if (typeof part === "string") {
    return { type: "text", text: part }
  }

  if (!isRecord(part)) {
    return null
  }

  return toTextPart(part) ?? toImageUrlPart(part)
}

function serializeUnknownContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }

  if (
    typeof content === "number"
    || typeof content === "boolean"
    || typeof content === "bigint"
  ) {
    return String(content)
  }

  if (content === null) {
    return "null"
  }

  try {
    return JSON.stringify(content)
  } catch {
    // Ignore serialization errors and fall back to empty string.
  }

  return ""
}

function normalizeMessageContent(content: unknown): Message["content"] {
  if (content === null || typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return serializeUnknownContent(content)
  }

  const normalizedContent = content
    .map((part) => normalizeContentPart(part))
    .filter((part): part is ContentPart => part !== null)

  if (normalizedContent.length === 0 && content.length > 0) {
    return JSON.stringify(content)
  }

  return normalizedContent
}

function normalizeToolMessageContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content
  }

  if (content === null) {
    return ""
  }

  const textParts = content.filter(
    (part): part is TextPart => part.type === "text",
  )
  if (textParts.length === content.length) {
    return textParts.map((part) => part.text).join("\n\n")
  }

  return JSON.stringify(content)
}

function normalizePayloadContent(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return {
    ...payload,
    messages: payload.messages.map((message) => {
      const normalizedContent =
        message.role === "tool" ?
          normalizeToolMessageContent(normalizeMessageContent(message.content))
        : normalizeMessageContent(message.content)
      const normalizedToolCalls = normalizeAssistantToolCalls(message)

      if (
        normalizedContent === message.content
        && normalizedToolCalls === message.tool_calls
      ) {
        return message
      }

      return {
        ...message,
        content: normalizedContent,
        ...(normalizedToolCalls !== undefined ?
          { tool_calls: normalizedToolCalls }
        : {}),
      }
    }),
  }
}

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
  if (error instanceof Error && error.name === "AbortError") {
    return false
  }

  const code = (error as { code?: string }).code
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      error.name === "AbortError"
      || error.name === "TimeoutError"
      || message.includes("timeout")
      || message.includes("network")
      || message.includes("fetch failed")
    )
  }

  return false
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
  options: { signal?: AbortSignal } = {},
) => {
  const { signal } = options
  const normalizedPayload = normalizePayloadContent(payload)

  // Get token from pool (with tracking) or fallback to state
  const token = await getActiveCopilotToken()

  // Agent/user check for X-Initiator header.
  // Only the latest turn should decide initiator type.
  const lastMessage = normalizedPayload.messages.at(-1)
  const isAgentCall =
    lastMessage?.role === "assistant" || lastMessage?.role === "tool"

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
      ...copilotHeaders(state, { vision: payloadEnableVision, token }),
      "X-Initiator": isAgentCall ? "agent" : "user",
    }
  }

  const sendRequest = (requestPayload: ChatCompletionsPayload) =>
    fetchWithTimeout(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(requestPayload),
      body: JSON.stringify(requestPayload),
      timeout: CHAT_COMPLETION_TIMEOUT,
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
      const fallbackPayload = {
        ...normalizedPayload,
        model: fallbackSelection.model,
      }
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

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
