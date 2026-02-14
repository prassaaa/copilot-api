import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"

const DEFAULT_MAX_CONSECUTIVE_TOOL_TURNS = 12

function resolveMaxConsecutiveToolTurns(): number {
  const raw = process.env.TOOL_LOOP_GUARD_MAX_TURNS
  if (!raw) return DEFAULT_MAX_CONSECUTIVE_TOOL_TURNS

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_CONSECUTIVE_TOOL_TURNS
  }

  return parsed
}

export function countTrailingToolCallTurns(messages: Array<Message>): number {
  let trailingTurns = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message.role === "user") {
      break
    }

    if (message.role === "assistant") {
      if (message.tool_calls?.length) {
        trailingTurns++
        continue
      }
      break
    }

    if (message.role === "tool") {
      continue
    }
  }

  return trailingTurns
}

export function applyToolLoopGuard(payload: ChatCompletionsPayload): {
  payload: ChatCompletionsPayload
  applied: boolean
  trailingTurns: number
  threshold: number
} {
  const threshold = resolveMaxConsecutiveToolTurns()
  const trailingTurns = countTrailingToolCallTurns(payload.messages)

  if (trailingTurns < threshold) {
    return {
      payload,
      applied: false,
      trailingTurns,
      threshold,
    }
  }

  const guardMessage: Message = {
    role: "developer",
    content:
      `Tool-loop guard active after ${trailingTurns} consecutive tool-call turns. `
      + "Do not call tools again. Use existing tool results and provide a final answer.",
  }

  return {
    payload: {
      ...payload,
      tool_choice: "none",
      tools: null,
      messages: [...payload.messages, guardMessage],
    },
    applied: true,
    trailingTurns,
    threshold,
  }
}
