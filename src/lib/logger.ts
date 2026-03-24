/**
 * Logger Module with Event Emitter and File-based Logging
 * Extends consola with log streaming capability and persistent file logs
 */

import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { PATHS } from "./paths"
import { requestContext } from "./request-context"
import { state } from "./state"

// File logging constants
const LOG_RETENTION_DAYS = 7
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100

// File logging state
const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()

// ============================================================
// File-based Logging Functions
// ============================================================

const ensureLogDirectory = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

const cleanupOldLogs = () => {
  if (!fs.existsSync(LOG_DIR)) {
    return
  }

  const now = Date.now()

  for (const entry of fs.readdirSync(LOG_DIR)) {
    const filePath = path.join(LOG_DIR, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile()) {
      continue
    }

    if (now - stats.mtimeMs > LOG_RETENTION_MS) {
      try {
        fs.rmSync(filePath)
      } catch {
        continue
      }
    }
  }
}

const formatArgs = (args: Array<unknown>) =>
  args
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: null, colors: false })
      ),
    )
    .join(" ")

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const getLogStream = (filePath: string): fs.WriteStream => {
  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    stream = fs.createWriteStream(filePath, { flags: "a" })
    logStreams.set(filePath, stream)

    stream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      logStreams.delete(filePath)
    })
  }
  return stream
}

const flushBuffer = (filePath: string) => {
  const buffer = logBuffers.get(filePath)
  if (!buffer || buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
    }
  })

  logBuffers.set(filePath, [])
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer(filePath)
  }
}

// Set up periodic buffer flushing
setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)

// Cleanup on process exit
const cleanup = () => {
  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }
  logStreams.clear()
  logBuffers.clear()
}

process.on("exit", cleanup)
process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})
process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})

// Track last cleanup time
let lastCleanup = 0

/**
 * Create a handler-specific logger that writes to file
 * Files are named: {handler-name}-{date}.log
 * Logs are retained for 7 days
 */
export const createHandlerLogger = (name: string): ConsolaInstance => {
  ensureLogDirectory()

  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  if (state.verbose) {
    instance.level = 5
  }
  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      ensureLogDirectory()

      // Periodic cleanup of old logs
      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        cleanupOldLogs()
        lastCleanup = Date.now()
      }

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(LOG_DIR, `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(logObj.args as Array<unknown>)
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      appendLine(filePath, line)
    },
  })

  return instance
}

// ============================================================
// LogEmitter Class (backward compatibility)
// ============================================================

interface LogEntry {
  level: string
  message: string
  timestamp: string
}

type LogListener = (entry: LogEntry) => void

class LogEmitter {
  private recentLogs: Array<LogEntry> = []
  private maxLogs = 1000
  private listeners: Set<LogListener> = new Set()

  /**
   * Add a log entry and emit event
   */
  log(level: string, message: string): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
    }

    // Add to recent logs (circular buffer)
    this.recentLogs.push(entry)
    if (this.recentLogs.length > this.maxLogs) {
      this.recentLogs.shift()
    }

    // Emit to listeners
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Subscribe to log events
   */
  on(_event: "log", listener: LogListener): void {
    this.listeners.add(listener)
  }

  /**
   * Unsubscribe from log events
   */
  off(_event: "log", listener: LogListener): void {
    this.listeners.delete(listener)
  }

  /**
   * Get recent logs
   */
  getRecentLogs(limit: number = 100): Array<LogEntry> {
    return this.recentLogs.slice(-limit)
  }

  /**
   * Create a wrapped logger that also emits events
   */
  createLogger() {
    return {
      info: (...args: Array<unknown>) => {
        const message = args.map(String).join(" ")
        consola.info(message)
        this.log("info", message)
      },
      warn: (...args: Array<unknown>) => {
        const message = args.map(String).join(" ")
        consola.warn(message)
        this.log("warn", message)
      },
      error: (...args: Array<unknown>) => {
        const message = args.map(String).join(" ")
        consola.error(message)
        this.log("error", message)
      },
      debug: (...args: Array<unknown>) => {
        const message = args.map(String).join(" ")
        consola.debug(message)
        this.log("debug", message)
      },
      success: (...args: Array<unknown>) => {
        const message = args.map(String).join(" ")
        consola.success(message)
        this.log("success", message)
      },
      box: (message: string) => {
        consola.box(message)
      },
      // Expose raw consola for direct access
      raw: consola,
    }
  }
}

export const logEmitter = new LogEmitter()
export const logger = logEmitter.createLogger()
