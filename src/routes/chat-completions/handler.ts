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
  type Message,
} from "~/services/copilot/create-chat-completions"

import { normalizeTools, preparePayload } from "./normalize-payload"
import {
  denormalizeRequestToolCallIds,
  normalizeResponseToolCallIds,
  normalizeStreamChunkData,
  extractChunkInfo,
} from "./tool-call-ids"

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

async function processStreamChunks(
  response: AsyncIterable<{ event?: string; data?: string; id?: unknown }>,
  stream: { writeSSE: (msg: SSEMessage) => Promise<void> },
): Promise<StreamState> {
  let doneSent = false
  let outputTokens = 0
  let hasToolCalls = false
  let lastFinishReason: string | null = null

  for await (const chunk of response) {
    consola.debug("Streaming chunk:", JSON.stringify(chunk))

    if (chunk.event === "ping") {
      continue
    }

    // Track tool_calls and finish_reason for summary logging
    if (chunk.data && chunk.data !== "[DONE]") {
      const info = extractChunkInfo(chunk.data)
      if (info.hasToolCalls) hasToolCalls = true
      if (info.finishReason) lastFinishReason = info.finishReason
    }

    const normalizedChunk = normalizeStreamChunkData(chunk.data ?? "")

    if (normalizedChunk.data === "[DONE]") {
      doneSent = true
    }

    // OpenAI SSE spec for chat completions does NOT use named events.
    // Forwarding non-standard event names (e.g. from Copilot API) causes
    // clients like Cursor to silently ignore all chunks.
    await stream.writeSSE({
      data: normalizedChunk.data,
      id: typeof chunk.id === "string" ? chunk.id : undefined,
    })

    if (normalizedChunk.completionTokens !== null) {
      outputTokens = normalizedChunk.completionTokens
    }

    if (doneSent) {
      break
    }
  }

  // Summary log — critical for debugging tool call issues
  logEmitter.log(
    "debug",
    `Stream summary: finish_reason=${lastFinishReason}, has_tool_calls=${hasToolCalls}`,
  )

  return { doneSent, outputTokens }
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
        // Convert non-streaming response to properly sequenced streaming chunks
        // so clients like Cursor can parse it correctly.
        const chunks = convertToStreamChunks(response)
        for (const chunk of chunks) {
          const normalizedChunk = normalizeStreamChunkData(
            JSON.stringify(chunk),
          )
          await stream.writeSSE({ data: normalizedChunk.data })
          if (normalizedChunk.completionTokens !== null) {
            streamOutputTokens = normalizedChunk.completionTokens
          }
        }
        await stream.writeSSE({ data: "[DONE]" })
        return
      }

      const result = await processStreamChunks(response, stream)
      doneSent = result.doneSent
      streamOutputTokens = result.outputTokens

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

      // Send a valid ChatCompletionChunk with finish_reason so clients like
      // Cursor properly terminate instead of retrying. Non-standard error
      // JSON (without id/object/choices) causes clients to misparse and loop.
      if (!doneSent) {
        const errorChunk: ChatCompletionChunk = {
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
        await stream.writeSSE({ data: JSON.stringify(errorChunk) })
        await stream.writeSSE({ data: "[DONE]" })
      }
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

function isSystemOrDeveloper(msg: Message): boolean {
  return msg.role === "system" || msg.role === "developer"
}

/**
 * Remove the oldest non-system message from the list, along with any
 * orphaned tool response messages if the removed message was an assistant
 * message with tool_calls.
 */
function removeOldestWithToolCleanup(messages: Array<Message>): Array<Message> {
  const [removed, ...rest] = messages
  if (removed.role !== "assistant" || !removed.tool_calls?.length) {
    return rest
  }

  // Remove tool responses that belong to the removed assistant's tool_calls
  const toolCallIds = new Set(removed.tool_calls.map((tc) => tc.id))
  const firstNonTool = rest.findIndex(
    (msg) =>
      msg.role !== "tool"
      || !msg.tool_call_id
      || !toolCallIds.has(msg.tool_call_id),
  )
  return firstNonTool === -1 ? [] : rest.slice(firstNonTool)
}

async function computeInputTokens(
  payload: ChatCompletionsPayload,
  model: import("~/services/copilot/get-models").Model,
): Promise<number | null> {
  try {
    const count = await getTokenCount(payload, model)
    return count.input
  } catch {
    return null
  }
}

/**
 * Truncate conversation messages when total token count exceeds the model's
 * prompt token limit. Uses max_prompt_tokens when available, otherwise falls
 * back to max_context_window_tokens (minus an output reserve). Preserves
 * system/developer messages and the most recent messages, removing oldest
 * non-system messages first.
 */
/**
 * Resolve the effective prompt token limit for a model.
 *
 * Priority:
 * 1. `max_prompt_tokens` — explicit prompt limit from the API
 * 2. `max_context_window_tokens` minus a reserve for output tokens
 *
 * A 10 % reserve (min 4 096 tokens) is subtracted from the context window so
 * the model still has room to generate a response.
 */
function resolvePromptTokenLimit(
  limits:
    | {
        max_prompt_tokens?: number
        max_context_window_tokens?: number
        max_output_tokens?: number
      }
    | undefined,
): number | null {
  if (limits?.max_prompt_tokens) return limits.max_prompt_tokens

  if (limits?.max_context_window_tokens) {
    const contextWindow = limits.max_context_window_tokens
    const outputReserve =
      limits.max_output_tokens ?
        Math.min(limits.max_output_tokens, Math.floor(contextWindow * 0.1))
      : Math.max(4096, Math.floor(contextWindow * 0.1))
    return contextWindow - outputReserve
  }

  return null
}

async function truncateMessages(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionsPayload> {
  const selectedModel = state.models?.data.find((m) => m.id === payload.model)
  if (!selectedModel) return payload

  const maxPromptTokens = resolvePromptTokenLimit(
    selectedModel.capabilities.limits,
  )
  if (!maxPromptTokens) return payload

  const initialInput = await computeInputTokens(payload, selectedModel)
  if (initialInput === null || initialInput <= maxPromptTokens) return payload

  const systemMessages = payload.messages.filter((m) => isSystemOrDeveloper(m))
  let nonSystemMessages = payload.messages.filter(
    (m) => !isSystemOrDeveloper(m),
  )

  const originalCount = nonSystemMessages.length
  let currentInput = initialInput

  // Iteratively remove the oldest non-system messages until under limit
  // Keep at least the last 2 messages for context
  while (currentInput > maxPromptTokens && nonSystemMessages.length > 2) {
    nonSystemMessages = removeOldestWithToolCleanup(nonSystemMessages)

    const truncatedPayload = {
      ...payload,
      messages: [...systemMessages, ...nonSystemMessages],
    }
    const newInput = await computeInputTokens(truncatedPayload, selectedModel)
    if (newInput === null) break
    currentInput = newInput
  }

  const removedCount = originalCount - nonSystemMessages.length
  if (removedCount > 0) {
    consola.warn(
      `Truncated ${removedCount} messages to fit within ${maxPromptTokens} prompt token limit (${initialInput} → ${currentInput} tokens)`,
    )
    logEmitter.log(
      "warn",
      `Truncated ${removedCount} messages: ${initialInput} → ${currentInput} tokens (limit: ${maxPromptTokens})`,
    )
    return { ...payload, messages: [...systemMessages, ...nonSystemMessages] }
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

/**
 * Inject a developer message instructing the model to use tools via tool_calls,
 * not plain text. Needed because Copilot API may inject a system prompt that
 * steers the model toward conversational responses.
 */
function injectToolUseInstruction(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (!payload.tools || payload.tools.length === 0) {
    return payload
  }

  const toolNames = payload.tools.map((t) => t.function.name).join(", ")
  const instruction: Message = {
    role: "developer",
    content:
      `You have access to the following tools: ${toolNames}. `
      + "When you need to perform an action that matches a tool, you MUST use "
      + "the tool by emitting a tool_calls response. Do NOT describe the action "
      + "in plain text. Always prefer calling tools over describing what you "
      + "would do.",
  }

  // Insert after system/developer messages, before user messages
  const systemMessages = payload.messages.filter((m) => isSystemOrDeveloper(m))
  const otherMessages = payload.messages.filter((m) => !isSystemOrDeveloper(m))

  return {
    ...payload,
    messages: [...systemMessages, instruction, ...otherMessages],
  }
}

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  let requestId: string | undefined

  await checkRateLimit(state)

  const rawPayload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(rawPayload).slice(-400))

  const payload = await truncateMessages(
    applyMaxTokensIfNeeded(
      preparePayload(
        injectToolUseInstruction(
          normalizeTools(
            denormalizeRequestToolCallIds(sanitizeMessages(rawPayload)),
          ),
        ),
      ),
    ),
  )
  const accountInfo =
    isPoolEnabledSync() ? (getCurrentAccount()?.login ?? null) : null

  const toolChoiceLabel = getToolChoiceLabel(payload.tool_choice)
  logEmitter.log(
    "info",
    `Chat completion request: model=${payload.model}, stream=${payload.stream ?? false}, tools=${payload.tools?.length ?? 0}, tool_choice=${toolChoiceLabel}${accountInfo ? `, account=${accountInfo}` : ""}`,
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

/**
 * Convert a non-streaming ChatCompletionResponse to multiple streaming chunks
 * that follow the OpenAI SSE spec. The spec requires:
 * 1. First chunk: role only in delta, finish_reason: null
 * 2. Content/tool_calls chunks: content or tool_call data, finish_reason: null
 * 3. Final chunk: empty delta, finish_reason set, usage data
 *
 * This is needed when the client requests stream=true but the upstream API
 * returns a non-streaming response. Clients like Cursor expect properly
 * sequenced `chat.completion.chunk` objects.
 */
function convertToStreamChunks(
  response: ChatCompletionResponse,
): Array<ChatCompletionChunk> {
  const chunks: Array<ChatCompletionChunk> = []
  const base = {
    id: response.id,
    object: "chat.completion.chunk" as const,
    created: response.created,
    model: response.model,
    system_fingerprint: response.system_fingerprint,
  }

  // Chunk 1: role only
  chunks.push({
    ...base,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      delta: { role: choice.message.role },
      finish_reason: null,
      logprobs: null,
    })),
  })

  // Chunk 2: content and/or tool_calls
  for (const choice of response.choices) {
    if (choice.message.content) {
      chunks.push({
        ...base,
        choices: [
          {
            index: choice.index,
            delta: { content: choice.message.content },
            finish_reason: null,
            logprobs: choice.logprobs,
          },
        ],
      })
    }

    if (choice.message.tool_calls?.length) {
      for (const [tcIndex, tc] of choice.message.tool_calls.entries()) {
        chunks.push({
          ...base,
          choices: [
            {
              index: choice.index,
              delta: {
                tool_calls: [
                  {
                    index: tcIndex,
                    id: tc.id,
                    type: tc.type,
                    function: tc.function,
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        })
      }
    }
  }

  // Final chunk: empty delta with finish_reason and usage
  chunks.push({
    ...base,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      delta: {},
      finish_reason: choice.finish_reason,
      logprobs: null,
    })),
    usage:
      response.usage ?
        {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
          prompt_tokens_details: response.usage.prompt_tokens_details,
        }
      : undefined,
  })

  return chunks
}
