import consola from "consola"

import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { sleep } from "~/lib/retry"

import type { DeviceCodeResponse } from "./get-device-code"

// Safety limit for maximum polling attempts (about 15 minutes at 5s intervals)
const MAX_POLL_ATTEMPTS = 180

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)
  const startedAt = Date.now()
  const expiresAt = startedAt + deviceCode.expires_in * 1000

  let attempts = 0

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++

    if (Date.now() > expiresAt) {
      throw new Error("Device code expired")
    }

    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      await sleep(sleepDuration)
      consola.error("Failed to poll access token:", await response.text())

      continue
    }

    const json = await response.json()
    consola.debug("Polling access token response:", json)

    const { access_token } = json as AccessTokenResponse

    if (access_token) {
      return access_token
    } else {
      await sleep(sleepDuration)
    }
  }

  throw new Error("Maximum polling attempts exceeded")
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
