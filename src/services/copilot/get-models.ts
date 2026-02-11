import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithTimeout } from "~/lib/fetch-with-timeout"
import { state } from "~/lib/state"

// Timeout for models request (10 seconds)
const MODELS_TIMEOUT = 10000

export const getModels = async () => {
  const response = await fetchWithTimeout(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
    timeout: MODELS_TIMEOUT,
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
}

interface ModelCapabilities {
  family: string
  limits?: ModelLimits
  object: string
  supports?: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
}
