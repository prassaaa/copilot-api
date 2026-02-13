import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

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
