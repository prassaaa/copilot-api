import type {
  Message,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

export function normalizeToolCallArguments(argumentsLike: unknown): string {
  if (typeof argumentsLike === "string") {
    const trimmed = argumentsLike.trim()
    if (trimmed.length === 0) return "{}"

    try {
      JSON.parse(trimmed)
      return trimmed
    } catch {
      const repaired = trimmed.replaceAll(/\\(?!["\\/bfnrtu])/g, "\\\\")
      try {
        JSON.parse(repaired)
        return repaired
      } catch {
        // Return the original string instead of discarding it as "{}".
        // Silently replacing with "{}" corrupts the conversation history and
        // causes model confusion / tool-call loops in agentic clients like
        // Cursor when the model sees empty arguments for a tool call that
        // previously had valid parameters.
        return trimmed
      }
    }
  }

  if (argumentsLike === undefined) return "{}"
  try {
    return JSON.stringify(argumentsLike)
  } catch {
    return "{}"
  }
}

export function normalizeAssistantToolCalls(
  message: Message,
): Array<ToolCall> | undefined {
  if (message.role !== "assistant") return message.tool_calls

  const toolCalls = message.tool_calls
  if (!toolCalls || toolCalls.length === 0) {
    return toolCalls
  }

  const normalizedToolCalls = toolCalls.map((toolCall) => {
    const normalizedArguments = normalizeToolCallArguments(
      toolCall.function.arguments,
    )
    if (normalizedArguments === toolCall.function.arguments) {
      return toolCall
    }
    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: normalizedArguments,
      },
    }
  })

  const hasChanges = normalizedToolCalls.some(
    (toolCall, index) => toolCall !== toolCalls[index],
  )
  return hasChanges ? normalizedToolCalls : toolCalls
}
