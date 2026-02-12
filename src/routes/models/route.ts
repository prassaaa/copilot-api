import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
    }))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

modelRoutes.get("/:id", async (c) => {
  try {
    if (!state.models) {
      await cacheModels()
    }

    const modelId = c.req.param("id")
    const model = state.models?.data.find((m) => m.id === modelId)

    if (!model) {
      return c.json(
        {
          error: {
            message: `Model '${modelId}' not found`,
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    return c.json({
      id: model.id,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: model.vendor,
      display_name: model.name,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
