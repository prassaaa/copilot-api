import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { getCurrentAccount, isPoolEnabledSync } from "~/lib/account-pool"
import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config"
import { costCalculator } from "~/lib/cost-calculator"
import { applyFallback } from "~/lib/fallback"
import { logEmitter } from "~/lib/logger"
import {
  parseModelNameWithLevel,
  isClaudeThinkingModel,
} from "~/lib/model-level"
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
  createResponses,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
} from "./anthropic-types"

import {
  translateToAnthropic,
  translateToOpenAI,
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
} from "./subagent-marker"

type OpenAIPayload = ReturnType<typeof translateToOpenAI>
type CompletionResult =
  | ChatCompletionResponse
  | AsyncIterable<{ event?: string; data?: string }>
type TokenState = { input: number; output: number }

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

function handleCachedResponse(params: {
  c: Context
  cacheKey: string
  anthropicPayload: AnthropicMessagesPayload
  accountInfo?: string
  startTime: number
}): Response | null {
  const { c, cacheKey, anthropicPayload, accountInfo, startTime } = params
  const cached = requestCache.get(cacheKey)
  if (!cached) return null

  consola.debug("Cache hit for messages request")
  logEmitter.log(
    "success",
    `Messages (cached): model=${anthropicPayload.model}${accountInfo ? `, account=${accountInfo}` : ""}`,
  )

  requestHistory.record({
    type: "message",
    model: anthropicPayload.model,
    accountId: accountInfo,
    tokens: { input: cached.inputTokens, output: cached.outputTokens },
    cost: 0,
    duration: Date.now() - startTime,
    status: "cached",
    cached: true,
  })

  const anthropicResponse = translateToAnthropic(
    cached.response as ChatCompletionResponse,
  )
  return c.json(anthropicResponse)
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
  consola.debug("Streaming response from Copilot")
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
): void {
  logEmitter.log(
    "info",
    `Messages request: model=${payload.model}, stream=${payload.stream ?? false}${accountInfo ? `, account=${accountInfo}` : ""}`,
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
}

/**
 * Strip thinking blocks from assistant messages in payload.
 * Thinking blocks are used for extended thinking in Anthropic API,
 * but GitHub Copilot API doesn't support them, so we filter them out.
 */
function stripThinkingBlocks(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    messages: payload.messages.map((message) => {
      // Only process assistant messages with array content
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return message
      }

      // Filter out thinking blocks, keep all other blocks
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
 * Converts e.g., claude-opus-4.5(high) to base model and adds thinking config.
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

  // Add thinking configuration for Claude models with effort level
  if (isClaudeThinkingModel(baseModel)) {
    consola.debug(`Applying effort level "${level}" to model ${baseModel}`)
    // The thinking config will be handled by the chat-completions normalizer
  }

  return normalizedPayload
}

/**
 * Format tool result content to string for conversion to text block.
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
 * Orphan tool results are tool_result blocks that don't have a corresponding
 * tool_use block in the previous assistant message. These can cause errors
 * when sent to the Copilot API, so we convert them to text blocks.
 */
function sanitizeOrphanToolResults(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    messages: payload.messages.map((message, index) => {
      // Only process user messages with array content
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message
      }

      // Get tool_use IDs from previous assistant message
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

      // Convert orphan tool_result blocks to text blocks
      const newContent = message.content.map((block) => {
        if (block.type !== "tool_result") {
          return block
        }

        // Check if this tool_result has a corresponding tool_use
        if ("tool_use_id" in block && toolUseIds.has(block.tool_use_id)) {
          return block
        }

        // Convert orphan tool_result to text block
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

function applyQuotaOptimization(
  anthropicPayload: AnthropicMessagesPayload,
  c: Context,
): QuotaContext {
  // Detect subagent marker and session ID for quota optimization
  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const sessionId = getRootSessionId(anthropicPayload, c)
  if (subagentMarker) {
    consola.debug("Detected subagent marker:", JSON.stringify(subagentMarker))
  }

  // Apply quota optimization (warmup/compact detection, tool_result merging)
  const config = getConfig()
  const optimization = optimizeForQuota(anthropicPayload, {
    smallModel: config.smallModel,
    compactUseSmallModel: config.compactUseSmallModel,
    warmupUseSmallModel: config.warmupUseSmallModel,
    isSubagent: Boolean(subagentMarker),
    sessionId: subagentMarker?.session_id ?? sessionId,
  })

  // Apply optimized model if changed
  if (optimization.optimizedModel !== anthropicPayload.model) {
    const msg = `Quota optimization: ${anthropicPayload.model} → ${optimization.optimizedModel} (reason: ${optimization.reason})`
    consola.info(msg)
    logEmitter.log("info", msg)
    anthropicPayload.model = optimization.optimizedModel
  }

  return { subagentMarker, sessionId, optimization }
}

async function executeCompletion(
  openAIPayload: OpenAIPayload,
  quotaContext: QuotaContext,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  if (
    modelRequiresResponsesApi(openAIPayload.model)
    || isCodexModel(openAIPayload.model)
  ) {
    const bridgeMessage =
      `Messages route auto-bridging model=${openAIPayload.model} `
      + "to /responses API"
    consola.info(bridgeMessage)
    logEmitter.log("info", bridgeMessage)
    return executeViaResponsesBridge(openAIPayload, signal)
  }

  return createChatCompletions(openAIPayload, {
    signal,
    isSubagent: quotaContext.optimization.isSubagent,
    sessionId: quotaContext.optimization.sessionId,
  })
}

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  let requestId: string | undefined
  const tokenState: TokenState = { input: 0, output: 0 }

  await checkRateLimit(state)

  let anthropicPayload = await readAndNormalizeAnthropicPayload(c)
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Normalize model with effort level (e.g., claude-opus-4.5(high) -> claude-opus-4.5)
  anthropicPayload = normalizeModelWithEffort(anthropicPayload)

  // Strip thinking blocks from assistant messages before forwarding
  anthropicPayload = stripThinkingBlocks(anthropicPayload)

  // Sanitize orphan tool results (convert to text blocks)
  anthropicPayload = sanitizeOrphanToolResults(anthropicPayload)

  // Apply model mapping from config
  const requestedModel = anthropicPayload.model
  const mappedModel = getConfig().modelMapping[requestedModel]
  if (mappedModel) {
    anthropicPayload.model = mappedModel
    consola.debug(`Model mapping applied: ${requestedModel} → ${mappedModel}`)
  }

  const quotaContext = applyQuotaOptimization(anthropicPayload, c)

  const accountInfo = getAccountInfo()
  applyFallbackIfNeeded(anthropicPayload)
  logRequestStart(anthropicPayload, accountInfo)

  const translatedPayload = translateToOpenAI(anthropicPayload)

  // Apply truncation to fit within model's prompt token limit
  const openAIPayload = await truncateMessages(translatedPayload)

  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  tokenState.input = estimateInputTokens(openAIPayload.messages)

  if (!anthropicPayload.stream) {
    const cachedResponse = handleCachedResponse({
      c,
      cacheKey: getCacheKey(openAIPayload, accountInfo),
      anthropicPayload,
      accountInfo,
      startTime,
    })
    if (cachedResponse) {
      return cachedResponse
    }
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const queueResult = await handleQueueIfNeeded(c, anthropicPayload)
  if (queueResult.response) {
    return queueResult.response
  }
  if (queueResult.requestId) {
    requestId = queueResult.requestId
  }

  try {
    const response = await executeCompletion(
      openAIPayload,
      quotaContext,
      c.req.raw.signal,
    )

    usageStats.recordRequest(openAIPayload.model)

    if (isNonStreaming(response)) {
      return handleNonStreamingResponse({
        c,
        anthropicPayload,
        openAIPayload,
        response,
        accountInfo,
        startTime,
        tokenState,
      })
    }

    return handleStreamingResponse({
      c,
      anthropicPayload,
      openAIPayload,
      response,
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
    if (requestId) {
      completeRequest(requestId)
    }
  }
}

const isNonStreaming = (
  response: CompletionResult,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
