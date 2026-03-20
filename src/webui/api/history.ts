import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

export const historyRoutes = new Hono()
const SSE_HEARTBEAT_INTERVAL_MS = 5000

/**
 * GET /api/history - Get request history
 */
historyRoutes.get("/", async (c) => {
  try {
    const { requestHistory } = await import("~/lib/request-history")
    const limit = Number.parseInt(c.req.query("limit") || "50", 10)
    const offset = Number.parseInt(c.req.query("offset") || "0", 10)
    const model = c.req.query("model")
    const status = c.req.query("status") as
      | "success"
      | "error"
      | "cached"
      | undefined
    const accountId = c.req.query("account")

    const result = requestHistory.getHistory({
      limit,
      offset,
      model,
      status,
      accountId,
    })

    return c.json({ status: "ok", ...result })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * GET /api/history/stats - Get request history statistics
 */
historyRoutes.get("/stats", async (c) => {
  try {
    const { requestHistory } = await import("~/lib/request-history")
    const stats = requestHistory.getStats()
    return c.json({ status: "ok", stats })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * DELETE /api/history - Clear request history
 */
historyRoutes.delete("/", async (c) => {
  try {
    const { requestHistory } = await import("~/lib/request-history")
    requestHistory.clear()
    return c.json({ status: "ok", message: "History cleared" })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * GET /api/history/stream - Stream request history entries via SSE
 */
historyRoutes.get("/stream", async (c) => {
  const { historyEmitter, HISTORY_ENTRY_EVENT } = await import(
    "~/lib/request-history"
  )

  c.header("Cache-Control", "no-cache, no-transform")
  c.header("Connection", "keep-alive")
  c.header("X-Accel-Buffering", "no")

  return streamSSE(c, async (stream) => {
    let closed = false
    const streamTimers: {
      heartbeat: ReturnType<typeof setInterval> | null
    } = { heartbeat: null }

    const cleanup = () => {
      if (closed) return
      closed = true
      historyEmitter.removeEventListener(HISTORY_ENTRY_EVENT, sendHistoryEntry)
      if (streamTimers.heartbeat) {
        clearInterval(streamTimers.heartbeat)
        streamTimers.heartbeat = null
      }
    }

    const sendHistoryEntry = (event: Event) => {
      if (closed) return
      const { detail } = event as CustomEvent<unknown>
      stream
        .writeSSE({
          event: "history",
          data: JSON.stringify(detail),
        })
        .catch(() => {
          cleanup()
        })
    }

    historyEmitter.addEventListener(HISTORY_ENTRY_EVENT, sendHistoryEntry)

    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ message: "History stream connected" }),
    })

    streamTimers.heartbeat = setInterval(() => {
      if (closed) return
      stream
        .writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ timestamp: new Date().toISOString() }),
        })
        .catch(() => {
          cleanup()
        })
    }, SSE_HEARTBEAT_INTERVAL_MS)

    stream.onAbort(() => {
      cleanup()
    })

    await new Promise(() => {})
  })
})
