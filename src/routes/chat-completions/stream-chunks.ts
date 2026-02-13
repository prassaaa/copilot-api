import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

const TOOL_CALL_ARGS_CHUNK_SIZE = 512

function appendToolCallStreamChunks(
  chunks: Array<ChatCompletionChunk>,
  base: Pick<
    ChatCompletionChunk,
    "id" | "object" | "created" | "model" | "system_fingerprint"
  >,
  options: { choiceIndex: number; toolCalls: Array<ToolCall> },
): void {
  const { choiceIndex, toolCalls } = options
  for (const [tcIndex, tc] of toolCalls.entries()) {
    // Header chunk: introduces the tool call with id, type, and name
    chunks.push({
      ...base,
      choices: [
        {
          index: choiceIndex,
          delta: {
            tool_calls: [
              {
                index: tcIndex,
                id: tc.id,
                type: tc.type,
                function: { name: tc.function.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    })

    // Stream arguments incrementally to match real OpenAI streaming behavior
    const args = tc.function.arguments
    for (
      let offset = 0;
      offset < args.length;
      offset += TOOL_CALL_ARGS_CHUNK_SIZE
    ) {
      chunks.push({
        ...base,
        choices: [
          {
            index: choiceIndex,
            delta: {
              tool_calls: [
                {
                  index: tcIndex,
                  function: {
                    arguments: args.slice(
                      offset,
                      offset + TOOL_CALL_ARGS_CHUNK_SIZE,
                    ),
                  },
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

export function convertToStreamChunks(
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

  chunks.push({
    ...base,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      delta: { role: choice.message.role },
      finish_reason: null,
      logprobs: null,
    })),
  })

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
      appendToolCallStreamChunks(chunks, base, {
        choiceIndex: choice.index,
        toolCalls: choice.message.tool_calls,
      })
    }
  }

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
