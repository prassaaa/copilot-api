/**
 * Content Normalization Module
 * Handles normalization of message content for chat completions
 */

import { normalizeAssistantToolCalls } from "~/lib/tool-call-arguments"

import type {
  ChatCompletionsPayload,
  ContentPart,
  ImagePart,
  Message,
  TextPart,
} from "./chat-completion-types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isImageDetail(
  value: unknown,
): value is NonNullable<ImagePart["image_url"]["detail"]> {
  return value === "low" || value === "high" || value === "auto"
}

function toImageUrlPartFromImageUrl(
  imageUrlValue: unknown,
  includeDetail: boolean,
): ImagePart | null {
  if (typeof imageUrlValue === "string") {
    return { type: "image_url", image_url: { url: imageUrlValue } }
  }

  if (!isRecord(imageUrlValue) || typeof imageUrlValue.url !== "string") {
    return null
  }

  let detail: ImagePart["image_url"]["detail"] | undefined
  if (includeDetail && isImageDetail(imageUrlValue.detail)) {
    detail = imageUrlValue.detail
  }

  return {
    type: "image_url",
    image_url: {
      url: imageUrlValue.url,
      ...(detail ? { detail } : {}),
    },
  }
}

function toImageUrlPartFromSource(sourceValue: unknown): ImagePart | null {
  if (!isRecord(sourceValue)) {
    return null
  }

  if (
    sourceValue.type === "base64"
    && typeof sourceValue.media_type === "string"
    && typeof sourceValue.data === "string"
  ) {
    return {
      type: "image_url",
      image_url: {
        url: `data:${sourceValue.media_type};base64,${sourceValue.data}`,
      },
    }
  }

  if (sourceValue.type === "url" && typeof sourceValue.url === "string") {
    return { type: "image_url", image_url: { url: sourceValue.url } }
  }

  return null
}

function toImageUrlPart(part: Record<string, unknown>): ImagePart | null {
  if (part.type === "image_url") {
    return toImageUrlPartFromImageUrl(part.image_url, true)
  }

  if (part.type === "input_image") {
    return (
      toImageUrlPartFromImageUrl(part.image_url, false)
      ?? toImageUrlPartFromSource(part.source)
    )
  }

  if (part.type === "image") {
    return toImageUrlPartFromSource(part.source)
  }

  return null
}

function toTextPart(part: Record<string, unknown>): TextPart | null {
  const type = part.type

  if (
    (type === "text" || type === "input_text")
    && typeof part.text === "string"
  ) {
    return { type: "text", text: part.text }
  }

  if (type === "thinking" && typeof part.thinking === "string") {
    return { type: "text", text: part.thinking }
  }

  return null
}

function normalizeContentPart(part: unknown): ContentPart | null {
  if (typeof part === "string") {
    return { type: "text", text: part }
  }

  if (!isRecord(part)) {
    return null
  }

  return toTextPart(part) ?? toImageUrlPart(part)
}

function serializeUnknownContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }

  if (
    typeof content === "number"
    || typeof content === "boolean"
    || typeof content === "bigint"
  ) {
    return String(content)
  }

  if (content === null) {
    return "null"
  }

  try {
    return JSON.stringify(content)
  } catch {
    // Ignore serialization errors and fall back to empty string.
  }

  return ""
}

function normalizeMessageContent(content: unknown): Message["content"] {
  if (content === null || typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return serializeUnknownContent(content)
  }

  const normalizedContent = content
    .map((part) => normalizeContentPart(part))
    .filter((part): part is ContentPart => part !== null)

  if (normalizedContent.length === 0 && content.length > 0) {
    return JSON.stringify(content)
  }

  return normalizedContent
}

function normalizeToolMessageContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content
  }

  if (content === null) {
    return ""
  }

  const textParts = content.filter(
    (part): part is TextPart => part.type === "text",
  )
  if (textParts.length === content.length) {
    return textParts.map((part) => part.text).join("\n\n")
  }

  return JSON.stringify(content)
}

export function normalizePayloadContent(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return {
    ...payload,
    messages: payload.messages.map((message) => {
      const normalizedContent =
        message.role === "tool" ?
          normalizeToolMessageContent(normalizeMessageContent(message.content))
        : normalizeMessageContent(message.content)
      const normalizedToolCalls = normalizeAssistantToolCalls(message)

      if (
        normalizedContent === message.content
        && normalizedToolCalls === message.tool_calls
      ) {
        return message
      }

      return {
        ...message,
        content: normalizedContent,
        ...(normalizedToolCalls !== undefined ?
          { tool_calls: normalizedToolCalls }
        : {}),
      }
    }),
  }
}
