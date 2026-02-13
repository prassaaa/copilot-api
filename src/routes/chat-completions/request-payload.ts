import type { Context } from "hono"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"

const VALID_MESSAGE_ROLES = new Set<Message["role"]>([
  "user",
  "assistant",
  "system",
  "tool",
  "developer",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createInvalidPayloadError(message: string): HTTPError {
  return new HTTPError(
    "Invalid chat completion payload",
    Response.json(
      {
        error: {
          message,
          type: "invalid_request_error",
          code: "invalid_request",
        },
      },
      { status: 400 },
    ),
  )
}

export async function readAndNormalizePayload(
  c: Context,
): Promise<ChatCompletionsPayload> {
  try {
    const rawPayload = await c.req.json<unknown>()
    return normalizeChatCompletionsPayload(rawPayload)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw createInvalidPayloadError("Request body must be valid JSON.")
    }
    throw error
  }
}

function normalizeRole(role: unknown): Message["role"] | null {
  if (typeof role !== "string") return null
  if (role === "function") return "tool"
  if (VALID_MESSAGE_ROLES.has(role as Message["role"])) {
    return role as Message["role"]
  }
  return null
}

function normalizeContent(
  content: unknown,
  fallbackText: unknown,
): Message["content"] {
  if (
    typeof content === "string"
    || content === null
    || Array.isArray(content)
  ) {
    return content
  }
  if (typeof fallbackText === "string") {
    return fallbackText
  }
  if (content === undefined) {
    return null
  }
  if (isRecord(content) && typeof content.text === "string") {
    return content.text
  }
  try {
    return JSON.stringify(content)
  } catch {
    return "[unsupported content]"
  }
}

function coerceMessage(messageLike: unknown): Message | null {
  if (typeof messageLike === "string") {
    return { role: "user", content: messageLike }
  }
  if (!isRecord(messageLike)) return null

  const role = normalizeRole(messageLike.role)
  if (!role) return null

  const content = normalizeContent(messageLike.content, messageLike.text)
  const message: Message = { role, content }

  if (typeof messageLike.name === "string") {
    message.name = messageLike.name
  }
  if (typeof messageLike.tool_call_id === "string") {
    message.tool_call_id = messageLike.tool_call_id
  }
  if (Array.isArray(messageLike.tool_calls)) {
    message.tool_calls = messageLike.tool_calls as Message["tool_calls"]
  }

  return message
}

function parseMessagesField(messagesField: unknown): {
  messages: Array<Message> | null
  invalid: boolean
} {
  if (messagesField === undefined) return { messages: null, invalid: false }
  if (messagesField === null) return { messages: null, invalid: false }
  if (!Array.isArray(messagesField)) return { messages: null, invalid: true }

  const messages: Array<Message> = []
  for (const messageLike of messagesField) {
    const message = coerceMessage(messageLike)
    if (!message) return { messages: null, invalid: true }
    messages.push(message)
  }

  return { messages, invalid: false }
}

function coerceInputItem(item: unknown): Message | null {
  if (typeof item === "string") return { role: "user", content: item }
  if (!isRecord(item)) return null

  if (item.type === "input_text" && typeof item.text === "string") {
    return { role: "user", content: item.text }
  }
  if (item.type === "output_text" && typeof item.text === "string") {
    return { role: "assistant", content: item.text }
  }
  if (item.type === "message" && isRecord(item.message)) {
    return coerceMessage(item.message)
  }

  const directMessage = coerceMessage(item)
  if (directMessage) return directMessage

  if (typeof item.text === "string") {
    return { role: "user", content: item.text }
  }
  return null
}

function parseInputField(inputField: unknown): Array<Message> | null {
  if (inputField === undefined) return null
  if (typeof inputField === "string") {
    return [{ role: "user", content: inputField }]
  }
  if (Array.isArray(inputField)) {
    const messages = inputField
      .map((item) => coerceInputItem(item))
      .filter((message): message is Message => message !== null)
    return messages.length > 0 ? messages : null
  }
  if (isRecord(inputField)) {
    const message = coerceInputItem(inputField)
    return message ? [message] : null
  }
  return null
}

export function normalizeChatCompletionsPayload(
  rawPayload: unknown,
): ChatCompletionsPayload {
  if (!isRecord(rawPayload)) {
    throw createInvalidPayloadError("Request body must be a JSON object.")
  }

  const model = rawPayload.model
  if (typeof model !== "string" || model.trim().length === 0) {
    throw createInvalidPayloadError(
      "Field `model` is required and must be a non-empty string.",
    )
  }

  const parsedMessages = parseMessagesField(rawPayload.messages)
  if (parsedMessages.invalid) {
    throw createInvalidPayloadError(
      "Field `messages` must be an array of chat message objects.",
    )
  }

  let messages: Array<Message> | null
  if (parsedMessages.messages && parsedMessages.messages.length > 0) {
    messages = parsedMessages.messages
  } else if (typeof rawPayload.prompt === "string") {
    messages = [{ role: "user", content: rawPayload.prompt }]
  } else {
    messages = parseInputField(rawPayload.input)
  }

  if (!messages || messages.length === 0) {
    throw createInvalidPayloadError(
      "Field `messages` is required and must be a non-empty array.",
    )
  }

  const normalizedPayload: Record<string, unknown> = {
    ...rawPayload,
    model: model.trim(),
    messages,
  }
  delete normalizedPayload.input
  delete normalizedPayload.prompt

  return normalizedPayload as unknown as ChatCompletionsPayload
}
