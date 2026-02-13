import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { getCurrentAccount, isPoolEnabledSync } from "~/lib/account-pool"
import { awaitApproval } from "~/lib/approval"
import { costCalculator } from "~/lib/cost-calculator"
import { applyFallback } from "~/lib/fallback"
import { logEmitter } from "~/lib/logger"
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
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { readAndNormalizeAnthropicPayload } from "./request-payload"
import { translateChunkToAnthropicEvents } from "./stream-translation"

type OpenAIPayload = ReturnType<typeof translateToOpenAI>
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

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  let requestId: string | undefined
  const tokenState: TokenState = { input: 0, output: 0 }

  await checkRateLimit(state)

  const anthropicPayload = await readAndNormalizeAnthropicPayload(c)
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const accountInfo = getAccountInfo()
  applyFallbackIfNeeded(anthropicPayload)
  logRequestStart(anthropicPayload, accountInfo)

  const openAIPayload = translateToOpenAI(anthropicPayload)
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
    const response = await createChatCompletions(openAIPayload)

    // Record usage stats
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
    // Record error in history
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
    // Complete queue request
    if (requestId) {
      completeRequest(requestId)
    }
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
