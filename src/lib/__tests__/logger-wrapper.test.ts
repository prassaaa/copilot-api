/**
 * Unit tests for logger wrapper
 */

import { describe, expect, it, mock } from "bun:test"

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
import { logEmitter, logger } from "../logger"

describe("logger (created from LogEmitter)", () => {
  it("has all required logging methods", () => {
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
    expect(typeof logger.debug).toBe("function")
    expect(typeof logger.success).toBe("function")
    expect(typeof logger.box).toBe("function")
  })

  it("has raw consola access", () => {
    expect(logger.raw).toBeDefined()
  })

  it("logs info messages and emits events", () => {
    const entries: Array<{ level: string; message: string }> = []
    const listener = (entry: { level: string; message: string }) => {
      entries.push(entry)
    }

    logEmitter.on("log", listener)
    logger.info("info test")

    const infoEntry = entries.find(
      (e) => e.level === "info" && e.message === "info test",
    )
    expect(infoEntry).toBeDefined()

    logEmitter.off("log", listener)
  })

  it("logs warn messages and emits events", () => {
    const entries: Array<{ level: string; message: string }> = []
    const listener = (entry: { level: string; message: string }) => {
      entries.push(entry)
    }

    logEmitter.on("log", listener)
    logger.warn("warn test")

    const warnEntry = entries.find(
      (e) => e.level === "warn" && e.message === "warn test",
    )
    expect(warnEntry).toBeDefined()

    logEmitter.off("log", listener)
  })

  it("logs error messages and emits events", () => {
    const entries: Array<{ level: string; message: string }> = []
    const listener = (entry: { level: string; message: string }) => {
      entries.push(entry)
    }

    logEmitter.on("log", listener)
    logger.error("error test")

    const errorEntry = entries.find(
      (e) => e.level === "error" && e.message === "error test",
    )
    expect(errorEntry).toBeDefined()

    logEmitter.off("log", listener)
  })

  it("logs debug messages and emits events", () => {
    const entries: Array<{ level: string; message: string }> = []
    const listener = (entry: { level: string; message: string }) => {
      entries.push(entry)
    }

    logEmitter.on("log", listener)
    logger.debug("debug test")

    const debugEntry = entries.find(
      (e) => e.level === "debug" && e.message === "debug test",
    )
    expect(debugEntry).toBeDefined()

    logEmitter.off("log", listener)
  })

  it("logs success messages and emits events", () => {
    const entries: Array<{ level: string; message: string }> = []
    const listener = (entry: { level: string; message: string }) => {
      entries.push(entry)
    }

    logEmitter.on("log", listener)
    logger.success("success test")

    const successEntry = entries.find(
      (e) => e.level === "success" && e.message === "success test",
    )
    expect(successEntry).toBeDefined()

    logEmitter.off("log", listener)
  })

  it("joins multiple arguments into message", () => {
    const entries: Array<{ level: string; message: string }> = []
    const listener = (entry: { level: string; message: string }) => {
      entries.push(entry)
    }

    logEmitter.on("log", listener)
    logger.info("part1", "part2", "part3")

    const joinedEntry = entries.find((e) => e.message === "part1 part2 part3")
    expect(joinedEntry).toBeDefined()

    logEmitter.off("log", listener)
  })
})
