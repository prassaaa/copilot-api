import consola from "consola"
import { events } from "fetch-event-stream"

import { getCurrentAccount, isPoolEnabledSync } from "~/lib/account-pool"
import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithTimeout } from "~/lib/fetch-with-timeout"
import { logEmitter } from "~/lib/logger"
import { state } from "~/lib/state"
import { getActiveCopilotToken } from "~/lib/token"

// Timeout for chat completions (2 minutes for long streaming responses)
const CHAT_COMPLETION_TIMEOUT = 120000

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

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  // Get token from pool (with tracking) or fallback to state
  const token = await getActiveCopilotToken()

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision, token),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetchWithTimeout(
    `${copilotBaseUrl(state)}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      timeout: CHAT_COMPLETION_TIMEOUT,
    },
  )

  if (!response.ok) {
    // Get account info for error message
    const accountInfo = getAccountInfoForError()

    // Try to parse error response
    let errorBody: { error?: { code?: string; message?: string } } | null = null
    try {
      const parsed: unknown = await response.clone().json()
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        errorBody = parsed as { error?: { code?: string; message?: string } }
      }
    } catch {
      // Ignore parse errors
    }

    // Enhanced error logging
    consola.error("Failed to create chat completions", response)
    consola.error(`Account: ${accountInfo}`)
    consola.error(`Model requested: ${payload.model}`)

    // Log to WebUI
    logEmitter.log(
      "error",
      `API Error ${response.status}: ${errorBody?.error?.message || response.statusText} (model=${payload.model}, account=${accountInfo})`,
    )

    // Check for model_not_supported error
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

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
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
