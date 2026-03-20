import { Hono } from "hono"

import { getConfig, saveConfig } from "~/lib/config"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelMappingRoutes = new Hono()

/**
 * GET /api/model-mappings - Get all model mappings
 */
modelMappingRoutes.get("/", (c) => {
  try {
    const config = getConfig()
    const modelMapping = config.modelMapping

    return c.json({
      status: "ok",
      mappings: Object.entries(modelMapping).map(([from, to]) => ({
        from,
        to,
      })),
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 500)
  }
})

/**
 * PUT /api/model-mappings/:from - Add or update a model mapping
 */
modelMappingRoutes.put("/:from", async (c) => {
  try {
    const from = decodeURIComponent(c.req.param("from"))
    const body = await c.req.json<{ to: string }>()

    if (!from || !body.to) {
      return c.json(
        { status: "error", error: "Both 'from' and 'to' models are required" },
        400,
      )
    }

    // Validate that the 'to' model exists in available models
    if (!state.models) {
      await cacheModels()
    }

    if (state.models) {
      const modelExists = state.models.data.some(
        (model) => model.id === body.to,
      )
      if (!modelExists) {
        return c.json(
          {
            status: "error",
            error: `Target model '${body.to}' not found in available models`,
          },
          400,
        )
      }
    }

    // Get current config
    const config = getConfig()
    const modelMapping = { ...config.modelMapping }

    // Add or update mapping
    modelMapping[from] = body.to

    // Save to config
    await saveConfig({ modelMapping })

    return c.json({
      status: "ok",
      message: `Mapping '${from}' → '${body.to}' ${modelMapping[from] === body.to ? "updated" : "created"}`,
      mapping: { from, to: body.to },
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * DELETE /api/model-mappings/:from - Delete a model mapping
 */
modelMappingRoutes.delete("/:from", async (c) => {
  try {
    const from = decodeURIComponent(c.req.param("from"))

    if (!from) {
      return c.json({ status: "error", error: "'from' model is required" }, 400)
    }

    // Get current config
    const config = getConfig()
    const modelMapping = { ...config.modelMapping }

    // Check if mapping exists
    if (!(from in modelMapping)) {
      return c.json(
        { status: "error", error: `Mapping for '${from}' not found` },
        404,
      )
    }

    // Delete mapping using object rest destructuring
    const { [from]: _, ...remainingMappings } = modelMapping

    // Save to config
    await saveConfig({ modelMapping: remainingMappings })

    return c.json({
      status: "ok",
      message: `Mapping for '${from}' deleted`,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})
