import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { logEmitter } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import { getResponsesRequestOptions } from "./utils"

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(-400),
  )

  // Convert custom apply_patch tool to function tool format
  convertApplyPatchTool(payload)

  // Remove web_search tool as it's not supported by GitHub Copilot
  removeWebSearchTool(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    consola.warn(
      `Model "${payload.model}" does not support the responses endpoint. supported_endpoints=${JSON.stringify(selectedModel?.supported_endpoints)}`,
    )
    return c.json(
      {
        error: {
          message: `Model "${payload.model}" does not support the responses endpoint. Please choose a model that supports it (e.g., codex models).`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  logEmitter.log(
    "info",
    `Responses request: model=${payload.model}, stream=${payload.stream ?? false}`,
  )

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, {
    vision,
    initiator,
    signal: c.req.raw.signal,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    consola.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()

      for await (const chunk of response) {
        consola.debug("Responses stream chunk:", JSON.stringify(chunk))

        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }
    })
  }

  consola.debug(
    "Forwarding native Responses result:",
    JSON.stringify(response).slice(-400),
  )

  logEmitter.log("success", `Responses done: model=${payload.model}`)

  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

/**
 * Convert custom apply_patch tool to function tool format.
 * Some clients (e.g., Claude Code) send apply_patch as a custom tool type,
 * but the Copilot Responses API expects function tools.
 */
const convertApplyPatchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools)) return

  for (let i = 0; i < payload.tools.length; i++) {
    const t = payload.tools[i]
    if (t.type === "custom" && t.name === "apply_patch") {
      payload.tools[i] = {
        type: "function",
        name: t.name as string,
        description: "Use the `apply_patch` tool to edit files",
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "The entire contents of the apply_patch command",
            },
          },
          required: ["input"],
        },
        strict: false,
      }
    }
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}
