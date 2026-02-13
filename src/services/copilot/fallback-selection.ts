import { getBestFallback, isFallbackEnabled } from "~/lib/fallback"

export interface CopilotErrorBody {
  error?: {
    code?: string
    message?: string
  }
}

const CAPACITY_ERROR_CODES = new Set([
  "resource_exhausted",
  "rate_limit_exceeded",
  "overloaded",
])

function extractErrorCode(
  errorBody: CopilotErrorBody | null,
): string | undefined {
  return errorBody?.error?.code?.toLowerCase()
}

function extractErrorMessage(errorBody: CopilotErrorBody | null): string {
  return errorBody?.error?.message?.toLowerCase() ?? ""
}

function isUnsupportedApiForModelError(params: {
  errorBody: CopilotErrorBody | null
  endpoint: string
}): boolean {
  const { errorBody, endpoint } = params
  const code = extractErrorCode(errorBody)
  const message = extractErrorMessage(errorBody)
  return (
    code === "unsupported_api_for_model"
    && message.includes(`${endpoint} endpoint`)
  )
}

function isCapacityOrRateLimitError(params: {
  response: Response
  errorBody: CopilotErrorBody | null
}): boolean {
  const { response, errorBody } = params
  if (response.status === 429) {
    return true
  }

  const code = extractErrorCode(errorBody)
  if (code && CAPACITY_ERROR_CODES.has(code)) {
    return true
  }

  const message = extractErrorMessage(errorBody)
  return (
    message.includes("resource exhausted")
    || message.includes("rate limit")
    || message.includes("overloaded")
  )
}

export function findFallbackModelForFailedResponse(params: {
  requestedModel: string
  response: Response
  errorBody: CopilotErrorBody | null
  endpoint: string
  findCompatibleFallback: (requestedModel: string) => string | null
}): { model: string; reason: "unsupported-endpoint" | "capacity" } | null {
  const {
    requestedModel,
    response,
    errorBody,
    endpoint,
    findCompatibleFallback,
  } = params

  if (isUnsupportedApiForModelError({ errorBody, endpoint })) {
    const model = findCompatibleFallback(requestedModel)
    return model ? { model, reason: "unsupported-endpoint" } : null
  }

  if (!isFallbackEnabled()) {
    return null
  }

  if (!isCapacityOrRateLimitError({ response, errorBody })) {
    return null
  }

  const model = getBestFallback(requestedModel)
  if (!model || model === requestedModel) {
    return null
  }

  return { model, reason: "capacity" }
}
