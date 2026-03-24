/* eslint-disable max-lines */
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { getCurrentAccount, isPoolEnabledSync } from "~/lib/account-pool"
import { awaitApproval } from "~/lib/approval"
import {
  getConfig,
  getReasoningEffortForModel,
  isMessagesApiEnabled,
} from "~/lib/config"
import { costCalculator } from "~/lib/cost-calculator"
import { applyFallback } from "~/lib/fallback"
import { logEmitter } from "~/lib/logger"
import {
  parseModelNameWithLevel,
  isClaudeThinkingModel,
} from "~/lib/model-level"
import { findEndpointModel } from "~/lib/models"
import { checkRateLimit } from "~/lib/rate-limit"
import { requestCache, generateCacheKey } from "~/lib/request-cache"
import { requestHistory } from "~/lib/request-history"
import {
  enqueueRequest,
  completeRequest,
  isQueueEnabled,
  QueueFullError,
} from "~/lib/request-queue"
import { state } from "~/lib/state"
import { usageStats } from "~/lib/usage-stats"
import {
  convertResponsesResultToCompletion,
  convertResponsesStreamToChatCompletionsStream,
  convertToResponsesPayload,
  modelRequiresResponsesApi,
  type ChatCompletionsBridgeStreamEvent,
} from "~/routes/chat-completions/responses-bridge"
import { truncateMessages } from "~/routes/chat-completions/truncate-messages"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  createMessages,
  type MessagesStream,
} from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "./anthropic-types"

import {
  translateToAnthropic,
  translateToOpenAI,
  translateOpenAIPayloadToAnthropic,
} from "./non-stream-translation"
import {
  optimizeForQuota,
  type QuotaOptimizationResult,
} from "./quota-optimizer"
import { readAndNormalizeAnthropicPayload } from "./request-payload"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import {
  parseSubagentMarkerFromFirstUser,
  getRootSessionId,
  type SubagentMarker,
} from "./subagent-marker"

type OpenAIPayload = ReturnType<typeof translateToOpenAI>
type CompletionResult =
  | ChatCompletionResponse
  | AsyncIterable<{ event?: string; data?: string }>
type TokenState = { input: number; output: number }

const MESSAGES_ENDPOINT = "/v1/messages"

// System prompt prefix for compact requests
const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

function getAccountInfo(): string | undefined {
  return isPoolEnabledSync() ? getCurrentAccount()?.login : undefined
}

function buildCacheKeyOptions(payload: OpenAIPayload): {
  temperature?: number
  max_tokens?: number
  tools?: Array<unknown>
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  seed?: number
  stop?: string | Array<string> | null
  response_format?: { type: "json_object" } | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  n?: number | null
  stream?: boolean | null
} {
  return {
    temperature: payload.temperature ?? undefined,
    max_tokens: payload.max_tokens ?? undefined,
    tools: payload.tools ?? undefined,
    top_p: payload.top_p ?? undefined,
    frequency_penalty: payload.frequency_penalty ?? undefined,
    presence_penalty: payload.presence_penalty ?? undefined,
    seed: payload.seed ?? undefined,
    stop: payload.stop ?? undefined,
    response_format: payload.response_format ?? undefined,
    tool_choice: payload.tool_choice ?? undefined,
    user: payload.user ?? undefined,
    logit_bias: payload.logit_bias ?? undefined,
    logprobs: payload.logprobs ?? undefined,
    n: payload.n ?? undefined,
    stream: payload.stream ?? undefined,
  }
}

function getCacheKey(payload: OpenAIPayload, accountId?: string): string {
  return generateCacheKey(payload.model, payload.messages, {
    ...buildCacheKeyOptions(payload),
    accountId,
  })
}

function estimateInputTokens(messages: OpenAIPayload["messages"]): number {
  return messages.reduce((total, msg) => {
    const content =
      typeof msg.content === "string" ?
        msg.content
      : JSON.stringify(msg.content)
    return total + Math.ceil(content.length / 4) // Rough estimate
  }, 0)
}

function isCodexModel(modelId: string): boolean {
  return modelId.includes("-codex")
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

function getResponsesBridgeRequestOptions(payload: OpenAIPayload): {
  vision: boolean
  initiator: "agent" | "user"
} {
  const vision = payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((part) => part.type === "image_url"),
  )
  const lastMessage = payload.messages.at(-1)
  const initiator =
    lastMessage?.role === "assistant" || lastMessage?.role === "tool" ?
      "agent"
    : "user"

  return { vision, initiator }
}

async function executeViaResponsesBridge(
  payload: OpenAIPayload,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const responsesPayload = convertToResponsesPayload(payload)
  const { vision, initiator } = getResponsesBridgeRequestOptions(payload)

  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    signal,
  })

  if (
    payload.stream
    && isAsyncIterable<ChatCompletionsBridgeStreamEvent>(response)
  ) {
    return convertResponsesStreamToChatCompletionsStream(
      response,
      payload.model,
    )
  }

  return convertResponsesResultToCompletion(response as ResponsesResult)
}

function queueFullResponse(c: Context): Response {
  return c.json(
    {
      type: "error",
      error: {
        type: "overloaded_error",
        message: "Server busy, please try again later",
      },
    },
    503,
  )
}

function handleNonStreamingResponse(params: {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  openAIPayload: OpenAIPayload
  response: ChatCompletionResponse
  accountInfo?: string
  startTime: number
  tokenState: TokenState
}): Response {
  const {
    c,
    anthropicPayload,
    openAIPayload,
    response,
    accountInfo,
    startTime,
    tokenState,
  } = params
  consola.debug(
    "Non-streaming response from Copilot:",
    JSON.stringify(response).slice(-400),
  )

  if (response.usage) {
    tokenState.output = response.usage.completion_tokens || 0
    tokenState.input = response.usage.prompt_tokens || tokenState.input
  }

  const cost = costCalculator.record(
    openAIPayload.model,
    tokenState.input,
    tokenState.output,
  )
  consola.debug(`Cost estimate: $${cost.totalCost.toFixed(6)}`)

  requestCache.set({
    key: getCacheKey(openAIPayload, accountInfo),
    response,
    model: openAIPayload.model,
    inputTokens: tokenState.input,
    outputTokens: tokenState.output,
  })

  requestHistory.record({
    type: "message",
    model: anthropicPayload.model,
    accountId: accountInfo,
    tokens: { input: tokenState.input, output: tokenState.output },
    cost: cost.totalCost,
    duration: Date.now() - startTime,
    status: "success",
  })

  const anthropicResponse = translateToAnthropic(response)
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  logEmitter.log(
    "success",
    `Messages done: model=${anthropicPayload.model}${accountInfo ? `, account=${accountInfo}` : ""}`,
  )
  return c.json(anthropicResponse)
}

function handleStreamingResponse(params: {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  openAIPayload: OpenAIPayload
  response: AsyncIterable<{ data?: string; event?: string }>
  accountInfo?: string
  startTime: number
  tokenState: TokenState
}): Response {
  const {
    c,
    anthropicPayload,
    openAIPayload,
    response,
    accountInfo,
    startTime,
    tokenState,
  } = params
  consola.debug("Streaming response from Copilot (Chat Completions)")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      toolCalls: {},
    }

    let streamOutputTokens = 0

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.event === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }

      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      } catch (parseError) {
        consola.warn("Failed to parse stream chunk:", parseError, rawEvent.data)
        continue // Skip malformed chunks
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)

      if (chunk.usage?.completion_tokens) {
        streamOutputTokens = chunk.usage.completion_tokens
      }

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    const finalOutputTokens =
      streamOutputTokens || Math.round(tokenState.input * 0.5)
    const cost = costCalculator.record(
      openAIPayload.model,
      tokenState.input,
      finalOutputTokens,
    )

    requestHistory.record({
      type: "message",
      model: anthropicPayload.model,
      accountId: accountInfo,
      tokens: { input: tokenState.input, output: finalOutputTokens },
      cost: cost.totalCost,
      duration: Date.now() - startTime,
      status: "success",
    })

    logEmitter.log(
      "success",
      `Messages stream done: model=${anthropicPayload.model}${accountInfo ? `, account=${accountInfo}` : ""}`,
    )
  })
}

/**
 * Handle streaming response from Messages API (native Anthropic format)
 */
function handleMessagesApiStreamingResponse(params: {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  response: MessagesStream
  accountInfo?: string
  startTime: number
}): Response {
  const { c, anthropicPayload, response, accountInfo, startTime } = params
  consola.debug("Streaming response from Copilot (Messages API)")

  return streamSSE(c, async (stream) => {
    // fix: track tokens from messages api stream events - 2026-03-24
    let inputTokens = 0
    let outputTokens = 0

    for await (const event of response) {
      const eventName = event.event
      const data = event.data ?? ""
      consola.debug("Messages API raw stream event:", data)

      // fix: parse token usage from stream events - 2026-03-24
      if (data && eventName !== "ping") {
        try {
          const parsed = JSON.parse(data) as {
            type?: string
            message?: {
              usage?: { input_tokens?: number; output_tokens?: number }
            }
            usage?: { output_tokens?: number }
          }

          // message_start contains initial input_tokens and output_tokens
          if (parsed.type === "message_start" && parsed.message?.usage) {
            inputTokens = parsed.message.usage.input_tokens ?? 0
            outputTokens = parsed.message.usage.output_tokens ?? 0
          }

          // message_delta contains accumulated output_tokens
          if (parsed.type === "message_delta" && parsed.usage?.output_tokens) {
            outputTokens = parsed.usage.output_tokens
          }
        } catch {
          // ignore parse errors, continue streaming
        }
      }

      await stream.writeSSE({
        event: eventName,
        data,
      })
    }

    // fix: calculate cost and record with actual tokens - 2026-03-24
    const cost = costCalculator.record(
      anthropicPayload.model,
      inputTokens,
      outputTokens,
    )

    logEmitter.log(
      "success",
      `Messages API stream done: model=${anthropicPayload.model}${accountInfo ? `, account=${accountInfo}` : ""}`,
    )

    requestHistory.record({
      type: "message",
      model: anthropicPayload.model,
      accountId: accountInfo,
      tokens: { input: inputTokens, output: outputTokens },
      cost: cost.totalCost,
      duration: Date.now() - startTime,
      status: "success",
    })
  })
}

function applyFallbackIfNeeded(payload: AnthropicMessagesPayload): void {
  if (isCodexModel(payload.model)) {
    return
  }

  const fallbackResult = applyFallback(payload.model)
  if (fallbackResult.didFallback) {
    payload.model = fallbackResult.model
    const msg = `Model fallback: ${fallbackResult.originalModel} → ${fallbackResult.model}`
    consola.info(msg)
    logEmitter.log("warn", msg)
  }
}

function logRequestStart(
  payload: AnthropicMessagesPayload,
  accountInfo?: string,
  apiType?: string,
): void {
  logEmitter.log(
    "info",
    `Messages request: model=${payload.model}, stream=${payload.stream ?? false}, api=${apiType ?? "chat-completions"}${accountInfo ? `, account=${accountInfo}` : ""}`,
  )
}

async function handleQueueIfNeeded(
  c: Context,
  payload: AnthropicMessagesPayload,
): Promise<{ requestId?: string; response?: Response }> {
  if (payload.stream || !isQueueEnabled()) {
    return {}
  }
  try {
    return { requestId: await enqueueRequest("message", 0) }
  } catch (error) {
    if (error instanceof QueueFullError) {
      return { response: queueFullResponse(c) }
    }
    throw error
  }
}

interface QuotaContext {
  subagentMarker: ReturnType<typeof parseSubagentMarkerFromFirstUser>
  sessionId: string | undefined
  optimization: QuotaOptimizationResult
  requestId: string
}

/**
 * Filter thinking blocks from assistant messages.
 * Only keep valid thinking blocks with proper signature for Messages API.
 */
function filterThinkingBlocks(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    messages: payload.messages.map((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return message
      }

      const filteredContent = message.content.filter((block) => {
        if (block.type !== "thinking") return true
        // Keep thinking blocks with valid signature (not placeholder)
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })

      return {
        ...message,
        content: filteredContent,
      }
    }),
  }
}

/**
 * Strip ALL thinking blocks from assistant messages for Chat Completions API.
 */
function stripThinkingBlocks(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    messages: payload.messages.map((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return message
      }

      const filteredContent = message.content.filter(
        (block) => block.type !== "thinking",
      )

      return {
        ...message,
        content: filteredContent,
      }
    }),
  }
}

/**
 * Normalize model name with effort level suffix.
 */
function normalizeModelWithEffort(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const { baseModel, level } = parseModelNameWithLevel(payload.model)
  if (!level) {
    return payload
  }

  const normalizedPayload = {
    ...payload,
    model: baseModel,
  }

  if (isClaudeThinkingModel(baseModel)) {
    consola.debug(`Applying effort level "${level}" to model ${baseModel}`)
  }

  return normalizedPayload
}

/**
 * Format tool result content to string.
 */
function formatToolResultContent(
  content:
    | string
    | Array<{ type: string; text?: string; source?: { media_type: string } }>,
): string {
  if (typeof content === "string") {
    return content
  }

  return content
    .map((item) => {
      if (item.type === "text" && item.text) {
        return item.text
      }
      if (item.source) {
        return `[image:${item.source.media_type}]`
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * Sanitize orphan tool results in the payload.
 */
function sanitizeOrphanToolResults(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    messages: payload.messages.map((message, index) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message
      }

      const previousMessage =
        index > 0 ? payload.messages[index - 1] : undefined
      const toolUseIds = new Set<string>()

      if (
        previousMessage
        && previousMessage.role === "assistant"
        && Array.isArray(previousMessage.content)
      ) {
        for (const block of previousMessage.content) {
          if (block.type === "tool_use" && "id" in block) {
            toolUseIds.add(block.id)
          }
        }
      }

      const newContent = message.content.map((block) => {
        if (block.type !== "tool_result") {
          return block
        }

        if ("tool_use_id" in block && toolUseIds.has(block.tool_use_id)) {
          return block
        }

        const contentText =
          "content" in block ? formatToolResultContent(block.content) : ""

        consola.debug(
          `Converting orphan tool_result to text at message index ${index}`,
        )

        return {
          type: "text" as const,
          text:
            contentText.length > 0 ?
              contentText
            : "[tool_result without corresponding tool_use was removed]",
        }
      })

      return {
        ...message,
        content: newContent,
      }
    }),
  }
}

/**
 * Generate request ID from payload for deduplication
 */
function generateRequestIdFromPayload(
  payload: AnthropicMessagesPayload,
  sessionId?: string,
): string {
  const content = JSON.stringify(payload.messages.slice(-3))
  const input = (sessionId ?? "") + content + Date.now().toString()
  return Buffer.from(input).toString("base64").slice(0, 32)
}

function applyQuotaOptimization(
  anthropicPayload: AnthropicMessagesPayload,
  c: Context,
): QuotaContext {
  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const sessionId = getRootSessionId(anthropicPayload, c)
  if (subagentMarker) {
    consola.debug("Detected subagent marker:", JSON.stringify(subagentMarker))
  }

  const config = getConfig()
  const optimization = optimizeForQuota(anthropicPayload, {
    smallModel: config.smallModel,
    compactUseSmallModel: config.compactUseSmallModel,
    warmupUseSmallModel: config.warmupUseSmallModel,
    isSubagent: Boolean(subagentMarker),
    sessionId: subagentMarker?.session_id ?? sessionId,
  })

  if (optimization.optimizedModel !== anthropicPayload.model) {
    const msg = `Quota optimization: ${anthropicPayload.model} → ${optimization.optimizedModel} (reason: ${optimization.reason})`
    consola.info(msg)
    logEmitter.log("info", msg)
    anthropicPayload.model = optimization.optimizedModel
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)

  return { subagentMarker, sessionId, optimization, requestId }
}

/**
 * Check if this is a compact request (conversation summarization)
 */
function isCompactRequest(anthropicPayload: AnthropicMessagesPayload): boolean {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

/**
 * Check if model supports Messages API endpoint.
 * Note: We use Messages API for all models that support /v1/messages endpoint,
 * regardless of adaptive_thinking support. For models without adaptive_thinking,
 * we simply don't inject the thinking parameter.
 */
function shouldUseMessagesApi(selectedModel: Model | undefined): boolean {
  if (!isMessagesApiEnabled()) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}

/**
 * Check if model supports thinking via Chat Completions (thinking_budget).
 * This is for models like Claude 4.5 that have max_thinking_budget but not adaptive_thinking.
 */
function supportsThinkingBudget(selectedModel: Model | undefined): boolean {
  return (selectedModel?.capabilities.supports?.max_thinking_budget ?? 0) > 0
}

/**
 * Get Anthropic effort level from model reasoning config
 */
function getAnthropicEffortForModel(
  model: string,
): "low" | "medium" | "high" | "max" {
  const reasoningEffort = getReasoningEffortForModel(model)

  if (reasoningEffort === "xhigh") return "max"
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low"

  return reasoningEffort
}

/**
 * Merge tool_result and text blocks to avoid consuming premium requests
 */
function mergeToolResultForQuota(
  anthropicPayload: AnthropicMessagesPayload,
): void {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    // Merge text blocks into tool results
    if (toolResults.length === textBlocks.length) {
      msg.content = toolResults.map((tr, i) => ({
        ...tr,
        content:
          typeof tr.content === "string" ?
            `${tr.content}\n\n${textBlocks[i].text}`
          : [...tr.content, textBlocks[i]],
      }))
    } else {
      const lastIndex = toolResults.length - 1
      msg.content = toolResults.map((tr, i) =>
        i === lastIndex ?
          {
            ...tr,
            content:
              typeof tr.content === "string" ?
                `${tr.content}\n\n${textBlocks.map((tb) => tb.text).join("\n\n")}`
              : [...tr.content, ...textBlocks],
          }
        : tr,
      )
    }
  }
}

/* eslint-disable max-lines-per-function, complexity */
/**
 * Handle request via Messages API with extended thinking support
 */
async function handleWithMessagesApi(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    anthropicBetaHeader?: string
    subagentMarker?: SubagentMarker | null
    selectedModel?: Model
    requestId: string
    sessionId?: string
    isCompact?: boolean
    accountInfo?: string
    startTime: number
  },
): Promise<Response> {
  const {
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    isCompact,
    accountInfo,
    startTime,
  } = options

  // Truncate messages: Anthropic → OpenAI → truncate → back to Anthropic
  const openaiPayload = translateToOpenAI(anthropicPayload)
  const truncatedOpenAI = await truncateMessages(openaiPayload)
  const truncatedPayload = translateOpenAIPayloadToAnthropic(
    truncatedOpenAI,
    anthropicPayload,
  )

  // Filter thinking blocks to keep only valid ones
  const filteredPayload = filterThinkingBlocks(truncatedPayload)

  // Check if tool_choice is incompatible with extended thinking
  const toolChoice = filteredPayload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"

  // Inject adaptive thinking ONLY if model explicitly supports it
  // Model versions: 4.6+ support adaptive_thinking, 4.5 does NOT
  // We must check the explicit flag from model capabilities
  const hasAdaptiveThinking =
    selectedModel?.capabilities.supports?.adaptive_thinking === true

  // For Claude 4.5 models without adaptive_thinking, inject enabled thinking with budget
  // This enables extended thinking output even without adaptive_thinking capability
  const isClaudeModel = filteredPayload.model.startsWith("claude")

  if (hasAdaptiveThinking && !disableThink) {
    filteredPayload.thinking = {
      type: "adaptive",
    }
    filteredPayload.output_config = {
      effort: getAnthropicEffortForModel(filteredPayload.model),
    }
    consola.debug("Injected adaptive thinking:", {
      thinking: filteredPayload.thinking,
      output_config: filteredPayload.output_config,
    })
  } else if (
    isClaudeModel
    && !hasAdaptiveThinking
    && !disableThink
    && !filteredPayload.thinking
  ) {
    // Auto-inject enabled thinking for Claude 4.5 models
    // Use max budget from capabilities or default to 32000 (typical for Claude 4.5)
    const maxBudget =
      selectedModel?.capabilities.supports?.max_thinking_budget ?? 32000
    const minBudget =
      selectedModel?.capabilities.supports?.min_thinking_budget ?? 1024
    filteredPayload.thinking = {
      type: "enabled",
      budget_tokens: Math.max(maxBudget, minBudget),
    }
    consola.debug("Injected enabled thinking for Claude 4.5:", {
      thinking: filteredPayload.thinking,
      model: filteredPayload.model,
    })
  }

  consola.debug("Messages API payload:", JSON.stringify(filteredPayload))

  logRequestStart(filteredPayload, accountInfo, "messages-api")

  const response = await createMessages(filteredPayload, anthropicBetaHeader, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })

  if (isAsyncIterable(response)) {
    return handleMessagesApiStreamingResponse({
      c,
      anthropicPayload: filteredPayload,
      response: response,
      accountInfo,
      startTime,
    })
  }

  // Non-streaming response
  consola.debug(
    "Non-streaming Messages API response:",
    JSON.stringify(response).slice(-400),
  )

  requestHistory.record({
    type: "message",
    model: filteredPayload.model,
    accountId: accountInfo,
    tokens: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
    cost: 0,
    duration: Date.now() - startTime,
    status: "success",
  })

  logEmitter.log(
    "success",
    `Messages API done: model=${filteredPayload.model}${accountInfo ? `, account=${accountInfo}` : ""}`,
  )

  return c.json(response)
}

/**
 * Handle request via Chat Completions API.
 * Supports extended thinking via thinking_budget for models like Claude 4.5.
 */
async function handleWithChatCompletions(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    quotaContext: QuotaContext
    selectedModel?: Model
    accountInfo?: string
    startTime: number
    tokenState: TokenState
  },
): Promise<Response> {
  const { quotaContext, selectedModel, accountInfo, startTime, tokenState } =
    options

  // Strip thinking blocks for Chat Completions API
  // (reasoning will come back via reasoning_text in response)
  const strippedPayload = stripThinkingBlocks(anthropicPayload)

  // Pass selectedModel to enable thinking_budget calculation
  const translatedPayload = translateToOpenAI(strippedPayload, selectedModel)
  const openAIPayload = await truncateMessages(translatedPayload)

  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  // Log if thinking_budget is enabled
  if (openAIPayload.thinking_budget) {
    consola.debug(
      `Thinking budget enabled: ${openAIPayload.thinking_budget} tokens`,
    )
  }

  tokenState.input = estimateInputTokens(openAIPayload.messages)

  logRequestStart(strippedPayload, accountInfo, "chat-completions")

  // Check for responses API bridge
  if (
    modelRequiresResponsesApi(openAIPayload.model)
    || isCodexModel(openAIPayload.model)
  ) {
    const bridgeMessage = `Messages route auto-bridging model=${openAIPayload.model} to /responses API`
    consola.info(bridgeMessage)
    logEmitter.log("info", bridgeMessage)
    const response = await executeViaResponsesBridge(
      openAIPayload,
      c.req.raw.signal,
    )

    usageStats.recordRequest(openAIPayload.model)

    if (isAsyncIterable(response)) {
      return handleStreamingResponse({
        c,
        anthropicPayload: strippedPayload,
        openAIPayload,
        response,
        accountInfo,
        startTime,
        tokenState,
      })
    }

    return handleNonStreamingResponse({
      c,
      anthropicPayload: strippedPayload,
      openAIPayload,
      response,
      accountInfo,
      startTime,
      tokenState,
    })
  }

  const response = await createChatCompletions(openAIPayload, {
    signal: c.req.raw.signal,
    isSubagent: quotaContext.optimization.isSubagent,
    sessionId: quotaContext.optimization.sessionId,
  })

  usageStats.recordRequest(openAIPayload.model)

  if (!openAIPayload.stream && !isAsyncIterable(response)) {
    return handleNonStreamingResponse({
      c,
      anthropicPayload: strippedPayload,
      openAIPayload,
      response,
      accountInfo,
      startTime,
      tokenState,
    })
  }

  return handleStreamingResponse({
    c,
    anthropicPayload: strippedPayload,
    openAIPayload,
    response: response as AsyncIterable<{ data?: string; event?: string }>,
    accountInfo,
    startTime,
    tokenState,
  })
}

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  let queueRequestId: string | undefined
  const tokenState: TokenState = { input: 0, output: 0 }

  await checkRateLimit(state)

  let anthropicPayload = await readAndNormalizeAnthropicPayload(c)
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Get anthropic-beta header from client
  const anthropicBetaHeader = c.req.header("anthropic-beta")
  consola.debug("Anthropic Beta header:", anthropicBetaHeader)

  // Detect compact request
  const isCompact = isCompactRequest(anthropicPayload)
  if (isCompact) {
    consola.debug("Detected compact request")
  }

  // Normalize model with effort level
  anthropicPayload = normalizeModelWithEffort(anthropicPayload)

  // Sanitize orphan tool results
  anthropicPayload = sanitizeOrphanToolResults(anthropicPayload)

  // Apply model mapping from config
  const requestedModel = anthropicPayload.model
  const mappedModel = getConfig().modelMapping[requestedModel]
  if (mappedModel) {
    anthropicPayload.model = mappedModel
    consola.debug(`Model mapping applied: ${requestedModel} → ${mappedModel}`)
  }

  // Apply quota optimization
  const quotaContext = applyQuotaOptimization(anthropicPayload, c)
  const accountInfo = getAccountInfo()

  // Apply fallback if needed
  applyFallbackIfNeeded(anthropicPayload)

  // Merge tool_result for quota optimization (skip for compact requests)
  if (!isCompact) {
    mergeToolResultForQuota(anthropicPayload)
  }

  // Find the model to determine which API to use
  const selectedModel = findEndpointModel(anthropicPayload.model)
  consola.debug("Selected model:", selectedModel?.id, {
    adaptive_thinking: selectedModel?.capabilities.supports?.adaptive_thinking,
    supported_endpoints: selectedModel?.supported_endpoints,
  })

  if (state.manualApprove) {
    await awaitApproval()
  }

  const queueResult = await handleQueueIfNeeded(c, anthropicPayload)
  if (queueResult.response) {
    return queueResult.response
  }
  if (queueResult.requestId) {
    queueRequestId = queueResult.requestId
  }

  try {
    // Route to appropriate API based on model capabilities
    if (shouldUseMessagesApi(selectedModel)) {
      consola.info(
        `Using Messages API for model=${anthropicPayload.model} (supports extended thinking)`,
      )
      return await handleWithMessagesApi(c, anthropicPayload, {
        anthropicBetaHeader,
        subagentMarker: quotaContext.subagentMarker,
        selectedModel,
        requestId: quotaContext.requestId,
        sessionId: quotaContext.sessionId,
        isCompact,
        accountInfo,
        startTime,
      })
    }

    // Fallback to Chat Completions API
    // This path now supports thinking via thinking_budget for Claude 4.5
    const hasThinkingBudget = supportsThinkingBudget(selectedModel)
    consola.debug(
      `Using Chat Completions API for model=${anthropicPayload.model}${hasThinkingBudget ? " (with thinking_budget)" : ""}`,
    )
    return await handleWithChatCompletions(c, anthropicPayload, {
      quotaContext,
      selectedModel,
      accountInfo,
      startTime,
      tokenState,
    })
  } catch (error) {
    requestHistory.record({
      type: "message",
      model: anthropicPayload.model,
      accountId: accountInfo,
      tokens: { input: tokenState.input, output: 0 },
      cost: 0,
      duration: Date.now() - startTime,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    if (queueRequestId) {
      completeRequest(queueRequestId)
    }
  }
}
