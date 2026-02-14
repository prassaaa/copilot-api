/**
 * Responses API Bridge for Chat Completions
 *
 * Automatically converts chat completions requests to the Responses API
 * format when the requested model only supports the /responses endpoint
 * (e.g., codex models like gpt-5.2-codex, gpt-5.3-codex).
 *
 * This allows clients that only speak the /v1/chat/completions protocol
 * to transparently use codex models.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  Tool as ChatTool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  FunctionTool,
  ResponsesResult,
  Tool as ResponseTool,
} from "~/services/copilot/create-responses"

import { logEmitter } from "~/lib/logger"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponseFunctionCallOutputItem,
  type ResponseFunctionToolCallItem,
  type ResponseInputItem,
  type ResponseInputMessage,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const RESPONSES_ENDPOINT = "/responses"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

/**
 * Check if a model requires the Responses API instead of Chat Completions.
 */
export function modelRequiresResponsesApi(modelId: string): boolean {
  const model = state.models?.data.find((m) => m.id === modelId)
  if (!model) return false

  const endpoints = model.supported_endpoints
  if (!endpoints || endpoints.length === 0) return false

  return (
    endpoints.includes(RESPONSES_ENDPOINT)
    && !endpoints.includes(CHAT_COMPLETIONS_ENDPOINT)
  )
}

// ==========================================
// Message Conversion Helpers
// ==========================================

function extractTextContent(msg: Message): string {
  if (typeof msg.content === "string") return msg.content
  if (!Array.isArray(msg.content)) return ""
  return msg.content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
}

function convertSystemMessage(
  msg: Message,
  currentInstructions: string | null,
): string | null {
  const text = extractTextContent(msg)
  if (!text) return currentInstructions
  return currentInstructions ? `${currentInstructions}\n\n${text}` : text
}

function convertAssistantContent(
  msg: Message,
): Array<Record<string, unknown>> | string | undefined {
  if (typeof msg.content === "string") return msg.content
  if (!Array.isArray(msg.content)) return undefined
  return msg.content.map((p) => {
    if (p.type === "text") {
      return { type: "output_text", text: p.text }
    }
    return p as unknown as Record<string, unknown>
  })
}

function convertUserContent(
  msg: Message,
): Array<Record<string, unknown>> | string | undefined {
  if (typeof msg.content === "string") return msg.content
  if (!Array.isArray(msg.content)) return undefined
  return msg.content.map((p) => {
    if (p.type === "text") {
      return { type: "input_text", text: p.text }
    }
    return {
      type: "input_image",
      image_url: p.image_url.url,
      detail: p.image_url.detail || "auto",
    }
  })
}

function convertToolMessage(msg: Message): ResponseFunctionCallOutputItem {
  return {
    type: "function_call_output",
    call_id: msg.tool_call_id || "",
    output: typeof msg.content === "string" ? msg.content : "",
  }
}

function convertAssistantToolCalls(
  msg: Message,
  input: Array<ResponseInputItem>,
): void {
  if (msg.content) {
    const assistantMsg: ResponseInputMessage = {
      type: "message",
      role: "assistant",
      content: convertAssistantContent(msg),
    }
    input.push(assistantMsg)
  }
  for (const tc of msg.tool_calls ?? []) {
    const toolCall: ResponseFunctionToolCallItem = {
      type: "function_call",
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }
    input.push(toolCall)
  }
}

function convertMessagesToInput(messages: Array<Message>): {
  instructions: string | null
  input: Array<ResponseInputItem>
} {
  let instructions: string | null = null
  const input: Array<ResponseInputItem> = []

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer": {
        instructions = convertSystemMessage(msg, instructions)
        break
      }
      case "tool": {
        input.push(convertToolMessage(msg))
        break
      }
      case "assistant": {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          convertAssistantToolCalls(msg, input)
        } else {
          input.push({
            type: "message",
            role: "assistant",
            content: convertAssistantContent(msg),
          } as ResponseInputMessage)
        }
        break
      }
      default: {
        input.push({
          type: "message",
          role: msg.role as "user",
          content: convertUserContent(msg),
        } as ResponseInputMessage)
        break
      }
    }
  }

  return { instructions, input }
}

// ==========================================
// Tool Conversion
// ==========================================

function convertTools(
  tools: Array<ChatTool> | null | undefined,
): Array<ResponseTool> | null {
  if (!tools || tools.length === 0) return null

  return tools.map(
    (tool): FunctionTool => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description ?? null,
      parameters: tool.function.parameters,
      strict: null,
    }),
  )
}

// ==========================================
// Payload Conversion
// ==========================================

function convertToolChoice(
  toolChoice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): ResponsesPayload["tool_choice"] {
  if (typeof toolChoice === "string") {
    return toolChoice
  }
  return { type: "function", name: toolChoice.function.name }
}

function convertToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const { instructions, input } = convertMessagesToInput(payload.messages)

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    stream: payload.stream,
    input,
  }

  if (instructions) {
    responsesPayload.instructions = instructions
  }

  const tools = convertTools(payload.tools)
  if (tools) {
    responsesPayload.tools = tools
  }

  if (payload.tool_choice) {
    responsesPayload.tool_choice = convertToolChoice(payload.tool_choice)
  }

  if (payload.temperature !== null && payload.temperature !== undefined) {
    responsesPayload.temperature = payload.temperature
  }
  if (payload.top_p !== null && payload.top_p !== undefined) {
    responsesPayload.top_p = payload.top_p
  }
  if (payload.max_tokens !== null && payload.max_tokens !== undefined) {
    responsesPayload.max_output_tokens = payload.max_tokens
  }

  return responsesPayload
}

// ==========================================
// Response Conversion (non-streaming)
// ==========================================

function extractOutputText(result: ResponsesResult): string {
  let text = ""
  for (const item of result.output) {
    if (item.type !== "message") continue
    const msg = item
    if (!msg.content) continue
    for (const block of msg.content) {
      if (
        "type" in block
        && block.type === "output_text"
        && "text" in block
        && typeof block.text === "string"
      ) {
        text += block.text
      }
    }
  }
  return text
}

function extractToolCalls(result: ResponsesResult): Array<ToolCall> {
  const toolCalls: Array<ToolCall> = []
  for (const item of result.output) {
    if (item.type !== "function_call") continue
    const fc = item
    toolCalls.push({
      id: fc.call_id,
      type: "function",
      function: { name: fc.name, arguments: fc.arguments },
    })
  }
  return toolCalls
}

function convertUsage(
  result: ResponsesResult,
): ChatCompletionResponse["usage"] {
  if (!result.usage) return undefined

  const usage: NonNullable<ChatCompletionResponse["usage"]> = {
    prompt_tokens: result.usage.input_tokens,
    completion_tokens: result.usage.output_tokens ?? 0,
    total_tokens: result.usage.total_tokens,
  }

  if (result.usage.input_tokens_details) {
    usage.prompt_tokens_details = {
      cached_tokens: result.usage.input_tokens_details.cached_tokens,
    }
  }

  return usage
}

function convertResponseToCompletion(
  result: ResponsesResult,
): ChatCompletionResponse {
  const textContent = extractOutputText(result)
  const toolCalls = extractToolCalls(result)
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop"

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: convertUsage(result),
  }
}

// ==========================================
// Stream Conversion
// ==========================================

interface StreamConversionState {
  responseId: string
  model: string
  created: number
  currentToolCallIndex: number
  toolCallIds: Map<string, number>
}

interface ChunkOptions {
  delta: ChatCompletionChunk["choices"][0]["delta"]
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
}

function getStringField(parsed: Record<string, unknown>, key: string): string {
  const value = parsed[key]
  if (typeof value === "string") return value
  if (
    typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
  ) {
    return String(value)
  }
  return ""
}

function makeChunk(
  ss: StreamConversionState,
  opts: ChunkOptions,
): ChatCompletionChunk {
  const chunk: ChatCompletionChunk = {
    id: ss.responseId,
    object: "chat.completion.chunk",
    created: ss.created,
    model: ss.model,
    choices: [
      {
        index: 0,
        delta: opts.delta,
        finish_reason: opts.finishReason,
        logprobs: null,
      },
    ],
  }
  if (opts.usage) chunk.usage = opts.usage
  return chunk
}

function handleCreatedEvent(
  parsed: Record<string, unknown>,
  ss: StreamConversionState,
): Array<ChatCompletionChunk> {
  const resp = parsed.response as ResponsesResult | undefined
  if (resp) {
    ss.responseId = resp.id
    ss.model = resp.model
    ss.created = resp.created_at
  }
  return [
    makeChunk(ss, {
      delta: { role: "assistant", content: "" },
      finishReason: null,
    }),
  ]
}

function handleTextDelta(
  parsed: Record<string, unknown>,
  ss: StreamConversionState,
): Array<ChatCompletionChunk> {
  const delta = getStringField(parsed, "delta")
  return [makeChunk(ss, { delta: { content: delta }, finishReason: null })]
}

function handleFunctionArgumentsDelta(
  parsed: Record<string, unknown>,
  ss: StreamConversionState,
): Array<ChatCompletionChunk> {
  const itemId = getStringField(parsed, "item_id")
  const delta = getStringField(parsed, "delta")

  const existingIndex = ss.toolCallIds.get(itemId)
  const isNewTool = existingIndex === undefined
  let toolIndex: number

  if (isNewTool) {
    ss.currentToolCallIndex++
    toolIndex = ss.currentToolCallIndex
    ss.toolCallIds.set(itemId, toolIndex)
  } else {
    toolIndex = existingIndex
  }

  return [
    makeChunk(ss, {
      delta: {
        tool_calls: [
          {
            index: toolIndex,
            ...(isNewTool ? { id: itemId, type: "function" as const } : {}),
            function: {
              ...(isNewTool ? { name: "" } : {}),
              arguments: delta,
            },
          },
        ],
      },
      finishReason: null,
    }),
  ]
}

function handleFunctionArgumentsDone(
  parsed: Record<string, unknown>,
  ss: StreamConversionState,
): Array<ChatCompletionChunk> {
  const name = getStringField(parsed, "name")
  const itemId = getStringField(parsed, "item_id")
  const toolIndex = ss.toolCallIds.get(itemId)
  if (toolIndex === undefined) return []

  return [
    makeChunk(ss, {
      delta: { tool_calls: [{ index: toolIndex, function: { name } }] },
      finishReason: null,
    }),
  ]
}

function handleCompletedEvent(
  parsed: Record<string, unknown>,
  ss: StreamConversionState,
): Array<ChatCompletionChunk> {
  const resp = parsed.response as ResponsesResult | undefined
  const hasToolCalls = ss.currentToolCallIndex >= 0
  const finishReason = hasToolCalls ? "tool_calls" : "stop"

  let usage: ChatCompletionChunk["usage"]
  if (resp?.usage) {
    usage = {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens ?? 0,
      total_tokens: resp.usage.total_tokens,
    }
  }

  return [
    makeChunk(ss, {
      delta: {},
      finishReason,
      usage,
    }),
  ]
}

function convertStreamEvent(
  event: string | undefined,
  data: string,
  ss: StreamConversionState,
): Array<ChatCompletionChunk> {
  if (!data) return []

  const parsed = JSON.parse(data) as Record<string, unknown>

  switch (event) {
    case "response.created": {
      return handleCreatedEvent(parsed, ss)
    }
    case "response.output_text.delta": {
      return handleTextDelta(parsed, ss)
    }
    case "response.function_call_arguments.delta": {
      return handleFunctionArgumentsDelta(parsed, ss)
    }
    case "response.function_call_arguments.done": {
      return handleFunctionArgumentsDone(parsed, ss)
    }
    case "response.completed": {
      return handleCompletedEvent(parsed, ss)
    }
    case "response.failed":
    case "response.incomplete": {
      return [makeChunk(ss, { delta: {}, finishReason: "stop" })]
    }
    default: {
      return []
    }
  }
}

// ==========================================
// Public Entry Point
// ==========================================

/**
 * Execute a chat completions request via the Responses API bridge.
 * Returns a Hono Response in the chat completions format.
 */
export async function executeThroughResponsesBridge(
  c: Context,
  payload: ChatCompletionsPayload,
): Promise<Response> {
  const responsesPayload = convertToResponsesPayload(payload)

  consola.debug(
    "Responses bridge: converting chat completions to responses API",
    JSON.stringify(responsesPayload).slice(-400),
  )
  logEmitter.log(
    "info",
    `Responses bridge: model=${payload.model} routed to /responses API`,
  )

  const hasVision = payload.messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
  )
  const lastMessage = payload.messages.at(-1)
  const isAgent =
    lastMessage?.role === "assistant" || lastMessage?.role === "tool"

  const response = await createResponses(responsesPayload, {
    vision: hasVision,
    initiator: isAgent ? "agent" : "user",
    signal: c.req.raw.signal,
  })

  // Non-streaming
  if (!payload.stream) {
    const completion = convertResponseToCompletion(response as ResponsesResult)
    return c.json(completion)
  }

  // Streaming
  const streamResponse = response as AsyncIterable<{
    event?: string
    data?: string
    id?: unknown
  }>

  return streamSSE(
    c,
    async (stream: { writeSSE: (msg: SSEMessage) => Promise<void> }) => {
      const ss: StreamConversionState = {
        responseId: "",
        model: payload.model,
        created: Math.floor(Date.now() / 1000),
        currentToolCallIndex: -1,
        toolCallIds: new Map(),
      }

      for await (const chunk of streamResponse) {
        const chatChunks = convertStreamEvent(chunk.event, chunk.data ?? "", ss)
        for (const chatChunk of chatChunks) {
          await stream.writeSSE({ data: JSON.stringify(chatChunk) })
        }
      }

      await stream.writeSSE({ data: "[DONE]" })
    },
  )
}
