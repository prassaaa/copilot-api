import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Error classes
export class FunctionCallArgumentsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FunctionCallArgumentsValidationError"
  }
}

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

function calculateInputTokens(chunk: ChatCompletionChunk): number {
  return (
    (chunk.usage?.prompt_tokens ?? 0)
    - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0)
  )
}

function getCacheReadTokens(
  chunk: ChatCompletionChunk,
): { cache_read_input_tokens: number } | Record<string, never> {
  const cachedTokens = chunk.usage?.prompt_tokens_details?.cached_tokens
  return cachedTokens !== undefined ?
      { cache_read_input_tokens: cachedTokens }
    : {}
}

function createMessageStartEvent(
  chunk: ChatCompletionChunk,
): AnthropicStreamEventData {
  return {
    type: "message_start",
    message: {
      id: chunk.id,
      type: "message",
      role: "assistant",
      content: [],
      model: chunk.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: calculateInputTokens(chunk),
        output_tokens: 0,
        ...getCacheReadTokens(chunk),
      },
    },
  }
}

function closeContentBlock(
  state: AnthropicStreamState,
): AnthropicStreamEventData {
  const event: AnthropicStreamEventData = {
    type: "content_block_stop",
    index: state.contentBlockIndex,
  }
  state.contentBlockIndex++
  state.contentBlockOpen = false
  return event
}

function handleTextContent(
  state: AnthropicStreamState,
  content: string,
  events: Array<AnthropicStreamEventData>,
): void {
  if (isToolBlockOpen(state)) {
    events.push(closeContentBlock(state))
  }

  if (!state.contentBlockOpen) {
    events.push({
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: { type: "text", text: "" },
    })
    state.contentBlockOpen = true
  }

  events.push({
    type: "content_block_delta",
    index: state.contentBlockIndex,
    delta: { type: "text_delta", text: content },
  })
}

interface NewToolCallContext {
  state: AnthropicStreamState
  toolCallIndex: number
  toolCallId: string
  toolCallName: string
}

function handleNewToolCall(
  ctx: NewToolCallContext,
  events: Array<AnthropicStreamEventData>,
): void {
  const { state, toolCallIndex, toolCallId, toolCallName } = ctx
  if (state.contentBlockOpen) {
    events.push(closeContentBlock(state))
  }

  const anthropicBlockIndex = state.contentBlockIndex
  state.toolCalls[toolCallIndex] = {
    id: toolCallId,
    name: toolCallName,
    anthropicBlockIndex,
  }

  events.push({
    type: "content_block_start",
    index: anthropicBlockIndex,
    content_block: {
      type: "tool_use",
      id: toolCallId,
      name: toolCallName,
      input: {},
    },
  })
  state.contentBlockOpen = true
}

interface ToolCallArgumentsContext {
  state: AnthropicStreamState
  toolCallIndex: number
  args: string
}

function handleToolCallArguments(
  ctx: ToolCallArgumentsContext,
  events: Array<AnthropicStreamEventData>,
): void {
  const { state, toolCallIndex, args } = ctx
  const toolCallInfo = state.toolCalls[toolCallIndex] as
    | { id: string; name: string; anthropicBlockIndex: number }
    | undefined
  if (toolCallInfo === undefined) return
  events.push({
    type: "content_block_delta",
    index: toolCallInfo.anthropicBlockIndex,
    delta: {
      type: "input_json_delta",
      partial_json: args,
    },
  })
}

interface FinishReasonContext {
  chunk: ChatCompletionChunk
  state: AnthropicStreamState
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

function handleFinishReason(
  ctx: FinishReasonContext,
  events: Array<AnthropicStreamEventData>,
): void {
  const { chunk, state, finishReason } = ctx
  if (state.contentBlockOpen) {
    events.push({
      type: "content_block_stop",
      index: state.contentBlockIndex,
    })
    state.contentBlockOpen = false
  }

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: mapOpenAIStopReasonToAnthropic(finishReason),
        stop_sequence: null,
      },
      usage: {
        input_tokens: calculateInputTokens(chunk),
        output_tokens: chunk.usage?.completion_tokens ?? 0,
        ...getCacheReadTokens(chunk),
      },
    },
    { type: "message_stop" },
  )
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) return events

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    events.push(createMessageStartEvent(chunk))
    state.messageStartSent = true
  }

  if (delta.content) {
    handleTextContent(state, delta.content, events)
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        handleNewToolCall(
          {
            state,
            toolCallIndex: toolCall.index,
            toolCallId: toolCall.id,
            toolCallName: toolCall.function.name,
          },
          events,
        )
      }
      if (toolCall.function?.arguments) {
        handleToolCallArguments(
          {
            state,
            toolCallIndex: toolCall.index,
            args: toolCall.function.arguments,
          },
          events,
        )
      }
    }
  }

  if (choice.finish_reason) {
    handleFinishReason(
      { chunk, state, finishReason: choice.finish_reason },
      events,
    )
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
