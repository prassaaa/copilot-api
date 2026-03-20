import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  getModelLevelsForModel,
  parseModelNameWithLevel,
} from "~/lib/model-level"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

const CUS_PREFIX = "cus-"

function toModelEntry(id: string, vendor: string, name: string) {
  return {
    id,
    object: "model",
    type: "model",
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: vendor,
    display_name: name,
  }
}

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models: Array<ReturnType<typeof toModelEntry>> = []

    for (const model of state.models?.data ?? []) {
      // Add base model and cus- prefixed variant
      models.push(
        toModelEntry(model.id, model.vendor, model.name),
        toModelEntry(`${CUS_PREFIX}${model.id}`, model.vendor, model.name),
      )

      // Add level-suffixed variants for models that support effort levels
      const levels = getModelLevelsForModel(model.id)
      if (levels) {
        for (const level of levels) {
          models.push(
            toModelEntry(
              `${model.id}(${level})`,
              model.vendor,
              `${model.name} (${level})`,
            ),
            toModelEntry(
              `${CUS_PREFIX}${model.id}(${level})`,
              model.vendor,
              `${model.name} (${level})`,
            ),
          )
        }
      }
    }

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

    const rawId = c.req.param("id")
    let modelId =
      rawId.startsWith(CUS_PREFIX) ? rawId.slice(CUS_PREFIX.length) : rawId

    // Parse level suffix if present (e.g., claude-opus-4.6(high) -> claude-opus-4.6)
    const { baseModel } = parseModelNameWithLevel(modelId)
    modelId = baseModel

    const model = state.models?.data.find((m) => m.id === modelId)

    if (!model) {
      return c.json(
        {
          error: {
            message: `Model '${rawId}' not found`,
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    return c.json(toModelEntry(rawId, model.vendor, model.name))
  } catch (error) {
    return await forwardError(c, error)
  }
})
