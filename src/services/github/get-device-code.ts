import {
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithTimeout } from "~/lib/fetch-with-timeout"

// 10 second timeout for device code request
const DEVICE_CODE_TIMEOUT = 10000

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetchWithTimeout(
    `${GITHUB_BASE_URL}/login/device/code`,
    {
      method: "POST",
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_APP_SCOPES,
      }),
      timeout: DEVICE_CODE_TIMEOUT,
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get device code", response)

  return (await response.json()) as DeviceCodeResponse
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}
