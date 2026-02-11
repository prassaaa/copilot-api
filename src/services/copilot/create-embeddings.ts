import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithTimeout } from "~/lib/fetch-with-timeout"
import { state } from "~/lib/state"
import { getActiveCopilotToken } from "~/lib/token"

// Timeout for embeddings (30 seconds)
const EMBEDDINGS_TIMEOUT = 30000

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  // Get token from pool (with tracking) or fallback to state
  const token = await getActiveCopilotToken()

  const response = await fetchWithTimeout(
    `${copilotBaseUrl(state)}/embeddings`,
    {
      method: "POST",
      headers: copilotHeaders(state, false, token),
      body: JSON.stringify(payload),
      timeout: EMBEDDINGS_TIMEOUT,
    },
  )

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
