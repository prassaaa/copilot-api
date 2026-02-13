import consola from "consola"

import { HTTPError } from "./error"

export const awaitApproval = async () => {
  const response = await consola.prompt(`Accept incoming request?`, {
    type: "confirm",
  })

  if (!response)
    throw new HTTPError(
      "Request rejected",
      Response.json(
        {
          error: {
            message: "Request rejected",
            type: "invalid_request_error",
            code: "request_rejected",
          },
        },
        { status: 403 },
      ),
    )
}
