import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { cors } from "hono/cors"

import { logEmitter } from "./lib/logger"
import { createAuthMiddleware } from "./lib/request-auth"
import { accountLimitsRoute } from "./routes/account-limits/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { healthRoutes } from "./routes/health/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"
import { webuiRoutes } from "./webui/routes"

export const server = new Hono()

// Custom logger middleware that also emits to WebUI
server.use(async (c, next) => {
  const start = Date.now()
  const method = c.req.method
  const path = c.req.path

  // Skip logging for static files, frequent polling endpoints, and telemetry
  const skipLog =
    path.startsWith("/js/")
    || path.startsWith("/css/")
    || path === "/favicon.svg"
    || path === "/api/logs/stream"
    || path === "/api/notifications/stream"
    || path === "/api/event_logging/batch"

  if (!skipLog) {
    logEmitter.log("debug", `<-- ${method} ${path}`)
  }

  await next()

  if (!skipLog) {
    const duration = Date.now() - start
    const status = c.res.status

    // Determine log level based on status code
    let level: string
    if (status >= 500) {
      level = "error"
    } else if (status >= 400) {
      level = "warn"
    } else if (status >= 200 && status < 300) {
      level = "success"
    } else {
      level = "info"
    }

    logEmitter.log(level, `--> ${method} ${path} ${status} ${duration}ms`)
  }
})

server.use(cors())

const apiAuthMiddleware = createAuthMiddleware()
server.use("/chat/*", apiAuthMiddleware)
server.use("/models", apiAuthMiddleware)
server.use("/embeddings", apiAuthMiddleware)
server.use("/usage", apiAuthMiddleware)
server.use("/token", apiAuthMiddleware)
server.use("/account-limits", apiAuthMiddleware)
server.use("/responses", apiAuthMiddleware)
server.use("/v1/*", apiAuthMiddleware)

// Health check routes (no auth required)
server.route("/health", healthRoutes)

// API Routes first
server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)
server.route("/account-limits", accountLimitsRoute)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// WebUI API routes
server.route("/", webuiRoutes)

// Serve static files for WebUI
server.use("/js/*", serveStatic({ root: "./public" }))
server.use("/css/*", serveStatic({ root: "./public" }))
server.use("/favicon.svg", serveStatic({ path: "./public/favicon.svg" }))

// Serve index.html for WebUI root
server.get("/", async (c) => {
  const file = Bun.file("./public/index.html")
  if (await file.exists()) {
    return c.html(await file.text())
  }
  return c.text("Copilot API Server Running")
})
