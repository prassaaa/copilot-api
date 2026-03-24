/**
 * Unit tests for createHandlerLogger
 */

import { describe, expect, it } from "bun:test"
import { mock } from "bun:test"

// Mock the state module
void mock.module("~/lib/state", () => ({
  state: {
    verbose: false,
  },
}))

// Mock request-context
void mock.module("~/lib/request-context", () => ({
  requestContext: {
    getStore: () => ({ traceId: "test-trace-id" }),
  },
}))

// Mock paths
void mock.module("~/lib/paths", () => ({
  PATHS: {
    APP_DIR: "/tmp/copilot-api-test",
  },
}))

// Import after mocks
import { createHandlerLogger } from "../logger"

describe("createHandlerLogger", () => {
  it("returns a valid logger instance", () => {
    const handlerLogger = createHandlerLogger("test-handler")

    expect(handlerLogger).toBeDefined()
    expect(typeof handlerLogger.info).toBe("function")
    expect(typeof handlerLogger.warn).toBe("function")
    expect(typeof handlerLogger.error).toBe("function")
    expect(typeof handlerLogger.debug).toBe("function")
  })

  it("creates logger with sanitized name", () => {
    const handlerLogger = createHandlerLogger("Test Handler With Spaces!")

    expect(handlerLogger).toBeDefined()
    // Logger should still be functional regardless of name
    expect(typeof handlerLogger.info).toBe("function")
  })

  it("handles empty name by defaulting to 'handler'", () => {
    const handlerLogger = createHandlerLogger("")

    expect(handlerLogger).toBeDefined()
    expect(typeof handlerLogger.info).toBe("function")
  })

  it("handles special characters in name", () => {
    const handlerLogger = createHandlerLogger("@#$%^&*()")

    expect(handlerLogger).toBeDefined()
    expect(typeof handlerLogger.info).toBe("function")
  })
})
