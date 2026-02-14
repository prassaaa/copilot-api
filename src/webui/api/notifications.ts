import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

export const notificationRoutes = new Hono()

/**
 * GET /api/notifications - Get all notifications
 */
notificationRoutes.get("/", async (c) => {
  try {
    const { notificationCenter } = await import("~/lib/notification-center")
    const notifications = notificationCenter.getAll()
    const unreadCount = notificationCenter.getUnreadCount()
    return c.json({ status: "ok", notifications, unreadCount })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/notifications/:id/read - Mark notification as read
 */
notificationRoutes.post("/:id/read", async (c) => {
  try {
    const { notificationCenter } = await import("~/lib/notification-center")
    const id = c.req.param("id")
    const success = notificationCenter.markAsRead(id)
    if (!success) {
      return c.json({ status: "error", error: "Notification not found" }, 404)
    }
    return c.json({ status: "ok", message: "Notification marked as read" })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * POST /api/notifications/read-all - Mark all notifications as read
 */
notificationRoutes.post("/read-all", async (c) => {
  try {
    const { notificationCenter } = await import("~/lib/notification-center")
    const count = notificationCenter.markAllAsRead()
    return c.json({
      status: "ok",
      message: `Marked ${count} notifications as read`,
    })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * DELETE /api/notifications/:id - Delete a notification
 */
notificationRoutes.delete("/:id", async (c) => {
  try {
    const { notificationCenter } = await import("~/lib/notification-center")
    const id = c.req.param("id")
    const success = notificationCenter.delete(id)
    if (!success) {
      return c.json({ status: "error", error: "Notification not found" }, 404)
    }
    return c.json({ status: "ok", message: "Notification deleted" })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * DELETE /api/notifications - Clear all notifications
 */
notificationRoutes.delete("/", async (c) => {
  try {
    const { notificationCenter } = await import("~/lib/notification-center")
    const count = notificationCenter.clear()
    return c.json({ status: "ok", message: `Cleared ${count} notifications` })
  } catch (error) {
    return c.json({ status: "error", error: (error as Error).message }, 400)
  }
})

/**
 * GET /api/notifications/stream - Stream notifications via SSE
 */
notificationRoutes.get("/stream", async (c) => {
  const { notificationEmitter, NOTIFICATION_EVENT } = await import(
    "~/lib/notification-center"
  )

  return streamSSE(c, async (stream) => {
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true
      notificationEmitter.removeEventListener(
        NOTIFICATION_EVENT,
        sendNotification,
      )
      clearInterval(heartbeat)
    }

    const sendNotification = (event: Event) => {
      if (closed) return
      const { detail } = event as CustomEvent<unknown>
      stream
        .writeSSE({
          event: "notification",
          data: JSON.stringify(detail),
        })
        .catch(() => {
          cleanup()
        })
    }

    notificationEmitter.addEventListener(NOTIFICATION_EVENT, sendNotification)

    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ message: "Notification stream connected" }),
    })

    const heartbeat = setInterval(() => {
      if (closed) return
      stream
        .writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ timestamp: new Date().toISOString() }),
        })
        .catch(() => {
          cleanup()
        })
    }, 15000)

    stream.onAbort(() => {
      cleanup()
    })

    await new Promise(() => {})
  })
})
