import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { getCurrentAccount, isPoolEnabledSync } from "~/lib/account-pool"
import { awaitApproval } from "~/lib/approval"
import { costCalculator } from "~/lib/cost-calculator"
import { logEmitter } from "~/lib/logger"
import { notificationCenter } from "~/lib/notification-center"
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
import { getTokenCount } from "~/lib/tokenizer"
import { usageStats } from "~/lib/usage-stats"
import { isNullish, sanitizeBillingHeader } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  normalizeTools,
  preparePayload,
  sanitizeAnthropicFields,
} from "./normalize-payload"
import {
  createInvalidPayloadError,
  readAndNormalizePayload,
} from "./request-payload"
import {
  executeThroughResponsesBridge,
  modelRequiresResponsesApi,
} from "./responses-bridge"
import { convertToStreamChunks } from "./stream-chunks"
import {
  denormalizeRequestToolCallIds,
  extractChunkInfo,
  normalizeResponseToolCallIds,
  normalizeStreamChunkData,
} from "./tool-call-ids"
import { truncateMessages } from "./truncate-messages"

interface CompletionContext {
  startTime: number
  payload: ChatCompletionsPayload
  accountInfo: string | null
  inputTokens: number
}

interface HistoryEntryParams {
  ctx: CompletionContext
  outputTokens: number
  cost: number
  status: "success" | "error" | "cached"
  error?: string
}

function hasToolCallResponse(response: ChatCompletionResponse): boolean {
  return response.choices.some(
    (choice) => (choice.message.tool_calls?.length ?? 0) > 0,
  )
}

function getCacheKeyOptions(payload: ChatCompletionsPayload) {
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

function getToolChoiceLabel(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): string {
  if (typeof toolChoice === "string") return toolChoice
  if (toolChoice) return "function"
  return "none"
}

function recordHistoryEntry(params: HistoryEntryParams): void {
  const { ctx, outputTokens, cost, status, error } = params
  requestHistory.record({
    type: "chat",
    model: ctx.payload.model,
    accountId: ctx.accountInfo || undefined,
    tokens: { input: ctx.inputTokens, output: outputTokens },
    cost,
    duration: Date.now() - ctx.startTime,
    status,
    cached: status === "cached",
    error,
  })
}

function handleCachedResponse(
  c: Context,
  ctx: CompletionContext,
): Response | null {
  if (ctx.payload.stream || (ctx.payload.tools?.length ?? 0) > 0) return null

  const cacheKey = generateCacheKey(ctx.payload.model, ctx.payload.messages, {
    ...getCacheKeyOptions(ctx.payload),
    accountId: ctx.accountInfo ?? undefined,
  })

  const cached = requestCache.get(cacheKey)
  if (!cached) return null

  consola.debug("Cache hit for request")
  logEmitter.log(
    "success",
    `Chat completion (cached): model=${ctx.payload.model}${ctx.accountInfo ? `, account=${ctx.accountInfo}` : ""}`,
  )

  const cachedResponse = normalizeResponseToolCallIds(
    cached.response as ChatCompletionResponse,
  )

  recordHistoryEntry({
    ctx,
    outputTokens: cached.outputTokens,
    cost: 0,
    status: "cached",
  })
  return c.json(cachedResponse)
}

async function handleQueueEnqueue(): Promise<string | undefined> {
  if (!isQueueEnabled()) return undefined

  try {
    return await enqueueRequest("chat", 0)
  } catch (error) {
    if (error instanceof QueueFullError) {
      notificationCenter.queueFull(100)
      throw error
    }
    throw error
  }
}

function handleNonStreamingResponse(
  c: Context,
  ctx: CompletionContext,
  response: ChatCompletionResponse,
): Response {
  const normalizedResponse = normalizeResponseToolCallIds(response)
  consola.debug("Non-streaming response:", JSON.stringify(normalizedResponse))

  let outputTokens = 0
  let finalInputTokens = ctx.inputTokens
  if (normalizedResponse.usage) {
    outputTokens = normalizedResponse.usage.completion_tokens || 0
    finalInputTokens = normalizedResponse.usage.prompt_tokens || ctx.inputTokens
  }

  const cost = costCalculator.record(
    ctx.payload.model,
    finalInputTokens,
    outputTokens,
  )
  consola.debug(`Cost estimate: $${cost.totalCost.toFixed(6)}`)

  const shouldCacheResponse =
    (ctx.payload.tools?.length ?? 0) === 0
    && !hasToolCallResponse(normalizedResponse)
  if (shouldCacheResponse) {
    const cacheKey = generateCacheKey(ctx.payload.model, ctx.payload.messages, {
      ...getCacheKeyOptions(ctx.payload),
      accountId: ctx.accountInfo ?? undefined,
    })
    requestCache.set({
      key: cacheKey,
      response: normalizedResponse,
      model: ctx.payload.model,
      inputTokens: finalInputTokens,
      outputTokens,
    })
  }

  recordHistoryEntry({
    ctx: { ...ctx, inputTokens: finalInputTokens },
    outputTokens,
    cost: cost.totalCost,
    status: "success",
  })

  logEmitter.log(
    "success",
    `Chat completion done: model=${ctx.payload.model}${ctx.accountInfo ? `, account=${ctx.accountInfo}` : ""}`,
  )
  return c.json(normalizedResponse)
}

interface StreamState {
  doneSent: boolean
  outputTokens: number
}

async function writeKeepAlive(
  stream: { writeSSE: (msg: SSEMessage) => Promise<void> },
  responseId: string | null,
  model: string,
): Promise<boolean> {
  // Before any real data arrives, forward pings as SSE comment-style events
  // so the client connection stays alive. Without this, clients behind a
  // reverse proxy (VPS/HTTPS) may timeout waiting for the first byte during
  // long model processing times (10-30+ seconds).
  if (!responseId) {
    try {
      await stream.writeSSE({ event: "ping", data: "{}" })
      return true
    } catch {
      consola.warn(
        "Failed to write pre-data ping, client may have disconnected",
      )
      return false
    }
  }
  const chunk: ChatCompletionChunk = {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null, logprobs: null }],
  }
  try {
    await stream.writeSSE({ data: JSON.stringify(chunk) })
    return true
  } catch {
    consola.warn("Failed to write keep-alive, client may have disconnected")
    return false
  }
}

async function processStreamChunks(
  response: AsyncIterable<{ event?: string; data?: string; id?: unknown }>,
  stream: { writeSSE: (msg: SSEMessage) => Promise<void> },
  options: { model: string; progress: { hasToolCalls: boolean } },
): Promise<StreamState> {
  const { model, progress } = options
  let doneSent = false
  let outputTokens = 0
  let hasToolCalls = false
  let lastFinishReason: string | null = null
  let lastResponseId: string | null = null

  for await (const chunk of response) {
    consola.debug("Streaming chunk:", JSON.stringify(chunk))

    if (chunk.event === "ping") {
      // Keep-alive skips itself when responseId is null (not yet seen).
      const ok = await writeKeepAlive(stream, lastResponseId, model)
      if (!ok) break
      continue
    }

    if (chunk.data && chunk.data !== "[DONE]") {
      const info = extractChunkInfo(chunk.data)
      if (info.hasToolCalls) {
        hasToolCalls = true
        progress.hasToolCalls = true
      }
      if (info.finishReason) lastFinishReason = info.finishReason
      lastResponseId ??= info.responseId
    }

    const normalizedChunk = normalizeStreamChunkData(chunk.data ?? "")

    if (normalizedChunk.data === "[DONE]") {
      doneSent = true
    }

    try {
      await stream.writeSSE({
        data: normalizedChunk.data,
        id: typeof chunk.id === "string" ? chunk.id : undefined,
      })
    } catch {
      consola.warn("Failed to write SSE chunk, client may have disconnected")
      break
    }

    if (normalizedChunk.completionTokens !== null) {
      outputTokens = normalizedChunk.completionTokens
    }

    if (doneSent) {
      break
    }
  }

  if (!doneSent) {
    consola.warn("Stream ended without [DONE] marker")
    logEmitter.log(
      "warn",
      `Stream ended without [DONE]: finish_reason=${lastFinishReason}, has_tool_calls=${hasToolCalls}`,
    )
  } else {
    logEmitter.log(
      "debug",
      `Stream summary: finish_reason=${lastFinishReason}, has_tool_calls=${hasToolCalls}`,
    )
  }

  return { doneSent, outputTokens }
}

async function sendConvertedStreamChunks(
  response: ChatCompletionResponse,
  stream: { writeSSE: (msg: SSEMessage) => Promise<void> },
  ctx: CompletionContext,
): Promise<void> {
  let streamOutputTokens = 0
  const chunks = convertToStreamChunks(response)
  for (const chunk of chunks) {
    const normalizedChunk = normalizeStreamChunkData(JSON.stringify(chunk))
    await stream.writeSSE({ data: normalizedChunk.data })
    if (normalizedChunk.completionTokens !== null) {
      streamOutputTokens = normalizedChunk.completionTokens
    }
  }
  await stream.writeSSE({ data: "[DONE]" })

  const outputTokens =
    response.usage?.completion_tokens || streamOutputTokens || 0
  const inputTokens = response.usage?.prompt_tokens || ctx.inputTokens
  const cost = costCalculator.record(
    ctx.payload.model,
    inputTokens,
    outputTokens,
  )
  recordHistoryEntry({
    ctx: { ...ctx, inputTokens },
    outputTokens,
    cost: cost.totalCost,
    status: "success",
  })
  logEmitter.log(
    "success",
    `Chat completion stream done (converted): model=${ctx.payload.model}${ctx.accountInfo ? `, account=${ctx.accountInfo}` : ""}`,
  )
}

async function writeStreamError(
  stream: { writeSSE: (msg: SSEMessage) => Promise<void> },
  ctx: CompletionContext,
  opts: { error: unknown; hasToolCalls?: boolean },
): Promise<void> {
  const errorMessage =
    opts.error instanceof Error ? opts.error.message : String(opts.error)

  // When tool calls were being streamed, injecting a content delta corrupts
  // the stream state — clients accumulating tool_call deltas would see an
  // unexpected content field and may treat the tool call as incomplete or
  // trigger invalid-argument errors and retry loops.
  if (!opts.hasToolCalls) {
    const errorContentChunk: ChatCompletionChunk = {
      id: "chatcmpl-error",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: ctx.payload.model,
      choices: [
        {
          index: 0,
          delta: { content: `\n\n[Error: ${errorMessage}]` },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    await stream.writeSSE({ data: JSON.stringify(errorContentChunk) })
  }

  // Always use "stop" for error scenarios, never "tool_calls". The client
  // may have received partial tool-call deltas with incomplete arguments;
  // sending "tool_calls" would tell the client to execute them, leading to
  // invalid-argument errors and agent loops.
  const errorStopChunk: ChatCompletionChunk = {
    id: "chatcmpl-error",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: ctx.payload.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  }
  await stream.writeSSE({ data: JSON.stringify(errorStopChunk) })
  await stream.writeSSE({ data: "[DONE]" })
}

function attachAbortFromRequest(
  requestSignal: AbortSignal,
  upstreamAbortController: AbortController,
): void {
  if (requestSignal.aborted) {
    upstreamAbortController.abort()
    return
  }
  requestSignal.addEventListener(
    "abort",
    () => upstreamAbortController.abort(),
    { once: true },
  )
}

function streamConvertedResponse(params: {
  c: Context
  ctx: CompletionContext
  response: ChatCompletionResponse
  upstreamAbortController: AbortController
}): Response {
  const { c, ctx, response, upstreamAbortController } = params
  return streamSSE(
    c,
    async (stream) => {
      stream.onAbort(() => upstreamAbortController.abort())
      try {
        await sendConvertedStreamChunks(response, stream, ctx)
      } catch (error) {
        if (upstreamAbortController.signal.aborted) {
          logEmitter.log(
            "debug",
            `Chat completion stream aborted by client: model=${ctx.payload.model}`,
          )
          // Send [DONE] for clean termination so the client can
          // immediately start a new request without "reconnecting".
          try {
            await stream.writeSSE({ data: "[DONE]" })
          } catch {
            // Expected — client already disconnected
          }
          return
        }
        consola.error(
          "Error in converted stream:",
          error instanceof Error ? error.message : String(error),
        )
        try {
          await writeStreamError(stream, ctx, {
            error,
            hasToolCalls: hasToolCallResponse(response),
          })
        } catch {
          // Client disconnected, nothing to do
        }
      }
    },
    async (error, stream) => {
      consola.error("Unhandled stream error (converted):", error.message)
      try {
        await writeStreamError(stream, ctx, {
          error,
          hasToolCalls: hasToolCallResponse(response),
        })
      } catch {
        // Client disconnected
      }
    },
  )
}

function streamUpstreamResponse(params: {
  c: Context
  ctx: CompletionContext
  response: AsyncIterable<{ event?: string; data?: string; id?: unknown }>
  upstreamAbortController: AbortController
}): Response {
  const { c, ctx, response, upstreamAbortController } = params
  const streamProgress = { hasToolCalls: false }
  return streamSSE(
    c,
    async (stream) => {
      let doneSent = false
      let streamOutputTokens = 0
      stream.onAbort(() => upstreamAbortController.abort())

      try {
        const result = await processStreamChunks(response, stream, {
          model: ctx.payload.model,
          progress: streamProgress,
        })
        doneSent = result.doneSent
        streamOutputTokens = result.outputTokens

        if (!doneSent) {
          try {
            await stream.writeSSE({ data: "[DONE]" })
            doneSent = true
          } catch {
            // Client disconnected — abort upstream to free resources
            upstreamAbortController.abort()
          }
        }

        const finalOutputTokens =
          streamOutputTokens || Math.round(ctx.inputTokens * 0.5)
        const cost = costCalculator.record(
          ctx.payload.model,
          ctx.inputTokens,
          finalOutputTokens,
        )

        recordHistoryEntry({
          ctx,
          outputTokens: finalOutputTokens,
          cost: cost.totalCost,
          status: "success",
        })

        logEmitter.log(
          "success",
          `Chat completion stream done: model=${ctx.payload.model}${ctx.accountInfo ? `, account=${ctx.accountInfo}` : ""}`,
        )
      } catch (error) {
        if (upstreamAbortController.signal.aborted) {
          logEmitter.log(
            "debug",
            `Chat completion stream aborted by client: model=${ctx.payload.model}`,
          )
          // Send [DONE] for clean termination so the client can
          // immediately start a new request without "reconnecting".
          if (!doneSent) {
            try {
              await stream.writeSSE({ data: "[DONE]" })
            } catch {
              // Expected — client already disconnected
            }
          }
          return
        }

        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.error("Mid-stream error:", errorMsg)
        logEmitter.log(
          "error",
          `Stream interrupted: model=${ctx.payload.model}, error=${errorMsg}`,
        )

        recordHistoryEntry({
          ctx,
          outputTokens: streamOutputTokens,
          cost: 0,
          status: "error",
          error: errorMsg,
        })

        if (!doneSent) {
          try {
            await writeStreamError(stream, ctx, {
              error,
              hasToolCalls: streamProgress.hasToolCalls,
            })
          } catch (writeErr) {
            consola.warn(
              "Failed to write stream error (client disconnected):",
              writeErr instanceof Error ? writeErr.message : String(writeErr),
            )
          }
        }
      }
    },
    async (error, stream) => {
      consola.error("Unhandled stream error (upstream):", error.message)
      try {
        await writeStreamError(stream, ctx, {
          error,
          hasToolCalls: streamProgress.hasToolCalls,
        })
      } catch {
        // Client disconnected
      }
    },
  )
}

async function handleStreamingResponse(
  c: Context,
  ctx: CompletionContext,
): Promise<Response> {
  consola.debug("Streaming response")
  const upstreamAbortController = new AbortController()
  attachAbortFromRequest(c.req.raw.signal, upstreamAbortController)

  const response = await createChatCompletions(ctx.payload, {
    signal: upstreamAbortController.signal,
  })
  usageStats.recordRequest(ctx.payload.model)

  if (isNonStreaming(response)) {
    return streamConvertedResponse({
      c,
      ctx,
      response,
      upstreamAbortController,
    })
  }
  return streamUpstreamResponse({
    c,
    ctx,
    response,
    upstreamAbortController,
  })
}

function sanitizeMessages(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (!Array.isArray(payload.messages)) {
    throw createInvalidPayloadError(
      "Field `messages` is required and must be a non-empty array.",
    )
  }
  const sanitizedMessages = payload.messages.map((msg) => {
    if (msg.role !== "system" && msg.role !== "developer") {
      return msg
    }

    // Handle string content
    if (typeof msg.content === "string") {
      return { ...msg, content: sanitizeBillingHeader(msg.content) }
    }

    // Handle array content (text parts)
    if (Array.isArray(msg.content)) {
      const sanitizedContent = msg.content.map((part) => {
        if (part.type === "text") {
          return { ...part, text: sanitizeBillingHeader(part.text) }
        }
        return part
      })
      return { ...msg, content: sanitizedContent }
    }

    return msg
  })

  return { ...payload, messages: sanitizedMessages }
}

async function calculateInputTokens(
  payload: ChatCompletionsPayload,
): Promise<number> {
  const selectedModel = state.models?.data.find((m) => m.id === payload.model)
  if (!selectedModel) return 0

  try {
    const tokenCount = await getTokenCount(payload, selectedModel)
    consola.info("Current token count:", tokenCount)
    logEmitter.log("debug", `Token count: ${JSON.stringify(tokenCount)}`)
    return tokenCount.input
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
    return 0
  }
}

function applyMaxTokensIfNeeded(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (!isNullish(payload.max_tokens)) return payload

  const selectedModel = state.models?.data.find((m) => m.id === payload.model)
  if (!selectedModel) return payload

  const maxTokens = selectedModel.capabilities.limits?.max_output_tokens
  if (maxTokens) {
    consola.debug("Set max_tokens to:", maxTokens)
    return { ...payload, max_tokens: maxTokens }
  }
  return payload
}

async function handleResponsesBridge(
  c: Context,
  ctx: CompletionContext,
): Promise<Response> {
  consola.info(
    `Model "${ctx.payload.model}" requires /responses API, bridging from /chat/completions`,
  )
  logEmitter.log(
    "info",
    `Auto-bridging model=${ctx.payload.model} from /chat/completions to /responses`,
  )

  try {
    return await executeThroughResponsesBridge(c, ctx.payload)
  } catch (error) {
    recordHistoryEntry({
      ctx,
      outputTokens: 0,
      cost: 0,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function createQueueFullResponse(c: Context): Response {
  return c.json(
    {
      error: {
        message: "Server busy, please try again later",
        type: "queue_full",
      },
    },
    503,
  )
}

async function maybeEnqueueRequest(
  c: Context,
  payload: ChatCompletionsPayload,
): Promise<{ requestId?: string; response?: Response }> {
  if (payload.stream) return {}

  try {
    return { requestId: await handleQueueEnqueue() }
  } catch (error) {
    if (error instanceof QueueFullError) {
      return { response: createQueueFullResponse(c) }
    }
    throw error
  }
}

async function executeCompletion(
  c: Context,
  ctx: CompletionContext,
): Promise<Response> {
  if (ctx.payload.stream) {
    return handleStreamingResponse(c, ctx)
  }

  const response = await createChatCompletions(ctx.payload)
  usageStats.recordRequest(ctx.payload.model)

  if (isNonStreaming(response)) {
    return handleNonStreamingResponse(c, ctx, response)
  }
  return handleStreamingResponse(c, ctx)
}

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  let requestId: string | undefined

  await checkRateLimit(state)

  const normalizedPayload = await readAndNormalizePayload(c)
  consola.debug(
    "Request payload:",
    JSON.stringify(normalizedPayload).slice(-400),
  )

  const payload = await truncateMessages(
    applyMaxTokensIfNeeded(
      preparePayload(
        normalizeTools(
          sanitizeAnthropicFields(
            denormalizeRequestToolCallIds(sanitizeMessages(normalizedPayload)),
          ),
        ),
      ),
    ),
  )
  const accountInfo =
    isPoolEnabledSync() ? (getCurrentAccount()?.login ?? null) : null

  const toolChoiceLabel = getToolChoiceLabel(payload.tool_choice)
  const msgRoleCounts = payload.messages.reduce<Record<string, number>>(
    (acc, m) => {
      acc[m.role] = (acc[m.role] || 0) + 1
      return acc
    },
    {},
  )
  const msgSummary = Object.entries(msgRoleCounts)
    .map(([role, count]) => `${role}=${count}`)
    .join(", ")
  logEmitter.log(
    "info",
    `Chat completion request: model=${payload.model}, stream=${payload.stream ?? false}, tools=${payload.tools?.length ?? 0}, tool_choice=${toolChoiceLabel}, messages=[${msgSummary}]${accountInfo ? `, account=${accountInfo}` : ""}`,
  )

  const inputTokens = await calculateInputTokens(payload)
  const ctx: CompletionContext = {
    startTime,
    payload,
    accountInfo,
    inputTokens,
  }

  // Check if model requires the Responses API (e.g., codex models)
  // If so, automatically bridge through the /responses endpoint
  if (modelRequiresResponsesApi(payload.model)) {
    return handleResponsesBridge(c, ctx)
  }

  const cachedResponse = handleCachedResponse(c, ctx)
  if (cachedResponse) return cachedResponse

  if (state.manualApprove) await awaitApproval()

  const queueResult = await maybeEnqueueRequest(c, payload)
  if (queueResult.response) return queueResult.response
  if (queueResult.requestId) {
    requestId = queueResult.requestId
  }

  try {
    return await executeCompletion(c, ctx)
  } catch (error) {
    recordHistoryEntry({
      ctx,
      outputTokens: 0,
      cost: 0,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    if (requestId) completeRequest(requestId)
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
