import type { Context } from "hono"

import { HTTPError } from "~/lib/error"

import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
  AnthropicTextBlock,
} from "./anthropic-types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createInvalidPayloadError(message: string): HTTPError {
  return new HTTPError(
    "Invalid messages payload",
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

function normalizeToString(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item
        if (isRecord(item) && typeof item.text === "string") return item.text
        return ""
      })
      .filter((part) => part.length > 0)
      .join("\n\n")
  }
  if (isRecord(value) && typeof value.text === "string") {
    return value.text
  }
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return "[unsupported content]"
  }
}

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

function isImageMediaType(
  value: unknown,
): value is AnthropicImageBlock["source"]["media_type"] {
  return typeof value === "string" && IMAGE_MEDIA_TYPES.has(value)
}

function parseUserContentBlock(
  block: unknown,
): AnthropicUserContentBlock | null {
  if (!isRecord(block)) return null

  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text }
  }

  if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
    const toolResult: AnthropicUserContentBlock = {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: normalizeToString(block.content),
    }
    if (typeof block.is_error === "boolean") {
      toolResult.is_error = block.is_error
    }
    return {
      ...toolResult,
    }
  }

  if (block.type === "image" && isRecord(block.source)) {
    const source = block.source
    if (
      source.type === "base64"
      && typeof source.data === "string"
      && isImageMediaType(source.media_type)
    ) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: source.media_type,
          data: source.data,
        },
      }
    }
  }

  return null
}

function parseAssistantContentBlock(
  block: unknown,
): AnthropicAssistantContentBlock | null {
  if (!isRecord(block)) return null

  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text }
  }

  if (
    block.type === "tool_use"
    && typeof block.id === "string"
    && typeof block.name === "string"
  ) {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: isRecord(block.input) ? block.input : {},
    }
  }

  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { type: "thinking", thinking: block.thinking }
  }

  return null
}

function normalizeUserContent(
  content: unknown,
): string | Array<AnthropicUserContentBlock> {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const blocks = content
      .map((block) => parseUserContentBlock(block))
      .filter((block): block is AnthropicUserContentBlock => block !== null)
    return blocks.length > 0 ? blocks : normalizeToString(content)
  }
  if (content === null || content === undefined) return ""
  if (isRecord(content) && typeof content.text === "string") {
    return content.text
  }
  return normalizeToString(content)
}

function normalizeAssistantContent(
  content: unknown,
): string | Array<AnthropicAssistantContentBlock> {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const blocks = content
      .map((block) => parseAssistantContentBlock(block))
      .filter(
        (block): block is AnthropicAssistantContentBlock => block !== null,
      )
    return blocks.length > 0 ? blocks : normalizeToString(content)
  }
  if (content === null || content === undefined) return ""
  if (isRecord(content) && typeof content.text === "string") {
    return content.text
  }
  return normalizeToString(content)
}

function mapMessageRole(
  role: unknown,
): "user" | "assistant" | "system" | "developer" | "tool" | null {
  if (role === "function") return "tool"
  if (
    role === "user"
    || role === "assistant"
    || role === "system"
    || role === "developer"
    || role === "tool"
  ) {
    return role
  }
  return null
}

function parseMessageLike(messageLike: unknown): {
  message: AnthropicMessage | null
  systemText: string | null
  invalid: boolean
} {
  if (typeof messageLike === "string") {
    return {
      message: { role: "user", content: messageLike },
      systemText: null,
      invalid: false,
    }
  }
  if (!isRecord(messageLike)) {
    return { message: null, systemText: null, invalid: true }
  }

  const role = mapMessageRole(messageLike.role)
  if (!role) {
    return { message: null, systemText: null, invalid: true }
  }

  const rawContent = messageLike.content
  if (role === "system" || role === "developer") {
    const text = normalizeToString(rawContent)
    return {
      message: null,
      systemText: text.length > 0 ? text : null,
      invalid: false,
    }
  }

  if (role === "tool") {
    return {
      message: { role: "user", content: normalizeToString(rawContent) },
      systemText: null,
      invalid: false,
    }
  }

  if (role === "user") {
    return {
      message: { role: "user", content: normalizeUserContent(rawContent) },
      systemText: null,
      invalid: false,
    }
  }

  return {
    message: {
      role: "assistant",
      content: normalizeAssistantContent(rawContent),
    },
    systemText: null,
    invalid: false,
  }
}

function parseInputItem(item: unknown): AnthropicMessage | null {
  if (isRecord(item) && item.type === "input_text" && item.text) {
    return { role: "user", content: normalizeToString(item.text) }
  }
  if (isRecord(item) && item.type === "message" && isRecord(item.message)) {
    const parsed = parseMessageLike(item.message)
    return parsed.message
  }
  const parsed = parseMessageLike(item)
  return parsed.message
}

function parseInputField(inputField: unknown): Array<AnthropicMessage> | null {
  if (inputField === undefined || inputField === null) return null

  if (typeof inputField === "string") {
    return [{ role: "user", content: inputField }]
  }

  if (isRecord(inputField)) {
    const parsed = parseMessageLike(inputField)
    if (!parsed.invalid && parsed.message) return [parsed.message]
    return null
  }

  if (!Array.isArray(inputField)) return null

  const messages = inputField
    .map((item) => parseInputItem(item))
    .filter((msg): msg is AnthropicMessage => msg !== null)

  return messages.length > 0 ? messages : null
}

function normalizeSystem(
  baseSystem: unknown,
  appendedSystemLines: Array<string>,
): string | Array<AnthropicTextBlock> | undefined {
  const extraSystem = appendedSystemLines.filter((line) => line.length > 0)
  if (typeof baseSystem === "string") {
    if (extraSystem.length === 0) return baseSystem
    return `${baseSystem}\n\n${extraSystem.join("\n\n")}`
  }
  if (Array.isArray(baseSystem)) {
    const base = baseSystem.filter(
      (block): block is AnthropicTextBlock =>
        isRecord(block)
        && block.type === "text"
        && typeof block.text === "string",
    )
    if (extraSystem.length === 0) return base
    return [
      ...base,
      ...extraSystem.map(
        (text): AnthropicTextBlock => ({ type: "text", text }),
      ),
    ]
  }
  if (extraSystem.length === 0) return undefined
  return extraSystem.join("\n\n")
}

function collectMessages(rawMessages: unknown): {
  messages: Array<AnthropicMessage>
  systemLines: Array<string>
} {
  if (rawMessages === undefined || rawMessages === null) {
    return { messages: [], systemLines: [] }
  }
  if (!Array.isArray(rawMessages)) {
    throw createInvalidPayloadError("Field `messages` must be an array.")
  }

  const messages: Array<AnthropicMessage> = []
  const systemLines: Array<string> = []

  for (const messageLike of rawMessages) {
    const parsed = parseMessageLike(messageLike)
    if (parsed.invalid) {
      throw createInvalidPayloadError(
        "Field `messages` must contain valid message objects.",
      )
    }
    if (parsed.message) messages.push(parsed.message)
    if (parsed.systemText) systemLines.push(parsed.systemText)
  }

  return { messages, systemLines }
}

function resolveMessages(
  collectedMessages: Array<AnthropicMessage>,
  rawPayload: Record<string, unknown>,
): Array<AnthropicMessage> | null {
  if (collectedMessages.length > 0) return collectedMessages
  if (typeof rawPayload.prompt === "string") {
    return [{ role: "user", content: rawPayload.prompt }]
  }
  return parseInputField(rawPayload.input)
}

function resolveMaxTokens(rawMaxTokens: unknown): number {
  if (typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens)) {
    return rawMaxTokens
  }
  return 4096
}

function assignSamplingFields(
  rawPayload: Record<string, unknown>,
  normalizedPayload: AnthropicMessagesPayload,
): void {
  if (typeof rawPayload.stream === "boolean") {
    normalizedPayload.stream = rawPayload.stream
  }
  if (typeof rawPayload.temperature === "number") {
    normalizedPayload.temperature = rawPayload.temperature
  }
  if (typeof rawPayload.top_p === "number") {
    normalizedPayload.top_p = rawPayload.top_p
  }
  if (typeof rawPayload.top_k === "number") {
    normalizedPayload.top_k = rawPayload.top_k
  }
}

function assignToolFields(
  rawPayload: Record<string, unknown>,
  normalizedPayload: AnthropicMessagesPayload,
): void {
  if (Array.isArray(rawPayload.stop_sequences)) {
    normalizedPayload.stop_sequences = rawPayload.stop_sequences.filter(
      (item): item is string => typeof item === "string",
    )
  }
  if (Array.isArray(rawPayload.tools)) {
    normalizedPayload.tools =
      rawPayload.tools as AnthropicMessagesPayload["tools"]
  }
  if (
    isRecord(rawPayload.tool_choice)
    && typeof rawPayload.tool_choice.type === "string"
  ) {
    normalizedPayload.tool_choice =
      rawPayload.tool_choice as AnthropicMessagesPayload["tool_choice"]
  }
}

function assignMetadataFields(
  rawPayload: Record<string, unknown>,
  normalizedPayload: AnthropicMessagesPayload,
): void {
  if (isRecord(rawPayload.metadata)) {
    const userId =
      typeof rawPayload.metadata.user_id === "string" ?
        rawPayload.metadata.user_id
      : undefined
    if (userId !== undefined) {
      normalizedPayload.metadata = { user_id: userId }
    }
  }
  if (isRecord(rawPayload.thinking) && rawPayload.thinking.type === "enabled") {
    normalizedPayload.thinking = rawPayload.thinking as NonNullable<
      AnthropicMessagesPayload["thinking"]
    >
  }
  if (
    rawPayload.service_tier === "auto"
    || rawPayload.service_tier === "standard_only"
  ) {
    normalizedPayload.service_tier = rawPayload.service_tier
  }
}

function assignOptionalFields(
  rawPayload: Record<string, unknown>,
  normalizedPayload: AnthropicMessagesPayload,
  systemLines: Array<string>,
): void {
  const system = normalizeSystem(rawPayload.system, systemLines)
  if (system !== undefined) normalizedPayload.system = system
  assignSamplingFields(rawPayload, normalizedPayload)
  assignToolFields(rawPayload, normalizedPayload)
  assignMetadataFields(rawPayload, normalizedPayload)
}

export function normalizeAnthropicMessagesPayload(
  rawPayload: unknown,
): AnthropicMessagesPayload {
  if (!isRecord(rawPayload)) {
    throw createInvalidPayloadError("Request body must be a JSON object.")
  }

  const model = rawPayload.model
  if (typeof model !== "string" || model.trim().length === 0) {
    throw createInvalidPayloadError(
      "Field `model` is required and must be a non-empty string.",
    )
  }

  const { messages: collectedMessages, systemLines } = collectMessages(
    rawPayload.messages,
  )
  const messages = resolveMessages(collectedMessages, rawPayload)
  if (!messages || messages.length === 0) {
    throw createInvalidPayloadError(
      "Field `messages` is required and must be a non-empty array.",
    )
  }

  const normalizedPayload: AnthropicMessagesPayload = {
    max_tokens: resolveMaxTokens(rawPayload.max_tokens),
    messages,
    model: model.trim(),
  }

  assignOptionalFields(rawPayload, normalizedPayload, systemLines)
  return normalizedPayload
}

export async function readAndNormalizeAnthropicPayload(
  c: Context,
): Promise<AnthropicMessagesPayload> {
  try {
    const rawPayload = await c.req.json<unknown>()
    return normalizeAnthropicMessagesPayload(rawPayload)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw createInvalidPayloadError("Request body must be valid JSON.")
    }
    throw error
  }
}
