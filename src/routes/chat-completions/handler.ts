import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { getCurrentAccount, isPoolEnabledSync } from "~/lib/account-pool"
import { awaitApproval } from "~/lib/approval"
import { costCalculator } from "~/lib/cost-calculator"
import { applyFallback } from "~/lib/fallback"
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

interface StreamUsageChunk {
  usage?: {
    completion_tokens?: number
  }
}

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

function normalizeToolCallId(id: string): string {
  if (id.startsWith("call_")) {
    return id
  }

  const safe = id.replaceAll(/[^\w-]/g, "_")
  return `call_${safe}`
}

function normalizeResponseToolCallIds(
  response: ChatCompletionResponse,
): ChatCompletionResponse {
  const normalizedChoices = response.choices.map((choice) => {
    const toolCalls = choice.message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      return choice
    }

    return {
      ...choice,
      message: {
        ...choice.message,
        tool_calls: toolCalls.map((toolCall) => ({
          ...toolCall,
          id: normalizeToolCallId(toolCall.id),
        })),
      },
    }
  })

  return {
    ...response,
    choices: normalizedChoices,
  }
}

function hasToolCallResponse(response: ChatCompletionResponse): boolean {
  return response.choices.some(
    (choice) => (choice.message.tool_calls?.length ?? 0) > 0,
  )
}

interface NormalizedStreamChunk {
  completionTokens: number | null
  data: string
}

function normalizeStreamChunkData(data: string): NormalizedStreamChunk {
  if (!data || data === "[DONE]") {
    return { completionTokens: null, data }
  }

  try {
    const parsed = JSON.parse(data) as ChatCompletionChunk
    for (const choice of parsed.choices) {
      if (!choice.delta.tool_calls) {
        continue
      }

      for (const toolCall of choice.delta.tool_calls) {
        if (!toolCall.id) {
          continue
        }

        const normalizedId = normalizeToolCallId(toolCall.id)
        toolCall.id = normalizedId
      }
    }

    return {
      completionTokens: parsed.usage?.completion_tokens ?? null,
      data: JSON.stringify(parsed),
    }
  } catch {
    return {
      completionTokens: tryParseStreamUsage(data),
      data,
    }
  }
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

function tryParseStreamUsage(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as StreamUsageChunk
    return parsed.usage?.completion_tokens ?? null
  } catch {
    return null
  }
}

function handleStreamingResponse(c: Context, ctx: CompletionContext): Response {
  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let doneSent = false
    let streamOutputTokens = 0

    try {
      const response = await createChatCompletions(ctx.payload)
      usageStats.recordRequest(ctx.payload.model)

      if (isNonStreaming(response)) {
        const data = JSON.stringify(response)
        await stream.writeSSE({ data })
        return
      }

      for await (const chunk of response) {
        consola.debug("Streaming chunk:", JSON.stringify(chunk))

        if (chunk.event === "ping") {
          // Ignore ping events for OpenAI compatibility.
          continue
        }

        const normalizedChunk = normalizeStreamChunkData(chunk.data ?? "")

        if (normalizedChunk.data === "[DONE]") {
          doneSent = true
        }

        const sseMessage: SSEMessage = {
          data: normalizedChunk.data,
          event: chunk.event,
          id: typeof chunk.id === "string" ? chunk.id : undefined,
        }
        await stream.writeSSE(sseMessage)

        if (normalizedChunk.completionTokens !== null) {
          streamOutputTokens = normalizedChunk.completionTokens
        }

        if (doneSent) {
          break
        }
      }

      if (!doneSent) {
        await stream.writeSSE({ data: "[DONE]" })
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
      consola.error("Streaming error:", error)

      recordHistoryEntry({
        ctx,
        outputTokens: streamOutputTokens,
        cost: 0,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })

      // Send error event to client
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          error: {
            message:
              error instanceof Error ? error.message : "Stream error occurred",
            type: "stream_error",
          },
        }),
      })
    }
  })
}

function sanitizeMessages(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const sanitizedMessages = payload.messages.map((msg) => {
    // Only sanitize system and developer role messages
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

/**
 * Normalize tools and tool_choice to OpenAI standard format.
 * Some clients (e.g. Cursor) send tools without the `type: "function"` wrapper.
 */
function normalizeTools(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  let tools = payload.tools
  let toolChoice = payload.tool_choice

  if (tools && tools.length > 0) {
    tools = tools.map((tool) => {
      const raw = tool as unknown as Record<string, unknown>

      // Already in correct format
      if (raw.type === "function" && raw.function) {
        return tool
      }

      // Tool sent without wrapper — has name/parameters at top level
      if (raw.name || raw.parameters) {
        return {
          type: "function" as const,
          function: {
            name: (raw.name as string) || "",
            description: raw.description as string | undefined,
            parameters:
              raw.parameters ? (raw.parameters as Record<string, unknown>) : {},
          },
        }
      }

      return tool
    })
  }

  if (
    toolChoice
    && typeof toolChoice === "object"
    && !("function" in toolChoice)
  ) {
    const raw = toolChoice as Record<string, unknown>
    if (raw.type === "auto" || raw.type === "none" || raw.type === "required") {
      toolChoice = raw.type
    } else if (raw.type === "function" && raw.name) {
      toolChoice = {
        type: "function" as const,
        function: { name: raw.name as string },
      }
    }
  }

  if (tools !== payload.tools || toolChoice !== payload.tool_choice) {
    return { ...payload, tools, tool_choice: toolChoice }
  }
  return payload
}

function preparePayload(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const fallbackResult = applyFallback(payload.model)
  if (fallbackResult.didFallback) {
    consola.info(
      `Model fallback: ${fallbackResult.originalModel} → ${fallbackResult.model}`,
    )
    logEmitter.log(
      "warn",
      `Model fallback: ${fallbackResult.originalModel} → ${fallbackResult.model}`,
    )
    return { ...payload, model: fallbackResult.model }
  }
  return payload
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

  const rawPayload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(rawPayload).slice(-400))

  const payload = applyMaxTokensIfNeeded(
    preparePayload(normalizeTools(sanitizeMessages(rawPayload))),
  )
  const accountInfo =
    isPoolEnabledSync() ? (getCurrentAccount()?.login ?? null) : null

  logEmitter.log(
    "info",
    `Chat completion request: model=${payload.model}, stream=${payload.stream ?? false}${accountInfo ? `, account=${accountInfo}` : ""}`,
  )

  const inputTokens = await calculateInputTokens(payload)
  const ctx: CompletionContext = {
    startTime,
    payload,
    accountInfo,
    inputTokens,
  }

  const cachedResponse = handleCachedResponse(c, ctx)
  if (cachedResponse) return cachedResponse

  if (state.manualApprove) await awaitApproval()

  if (!payload.stream) {
    try {
      requestId = await handleQueueEnqueue()
    } catch (error) {
      if (error instanceof QueueFullError) {
        return createQueueFullResponse(c)
      }
      throw error
    }
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
