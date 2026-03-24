/**
 * Unit tests for LogEmitter
 */

import { describe, expect, it, mock } from "bun:test";

// Mock the state module
void mock.module("~/lib/state", () => ({
  state: {
    verbose: false,
  },
}));

// Mock request-context
void mock.module("~/lib/request-context", () => ({
  requestContext: {
    getStore: () => ({ traceId: "test-trace-id" }),
  },
}));

// Mock paths
void mock.module("~/lib/paths", () => ({
  PATHS: {
    APP_DIR: "/tmp/copilot-api-test",
  },
}));

// Import after mocks
import { logEmitter } from "../logger";

// Error listener for testing (moved to outer scope)
const createErrorListener = () => {
  return () => {
    throw new Error("Listener error");
  };
};

describe("LogEmitter", () => {
  describe("log method", () => {
    it("adds entry to recent logs", () => {
      // Get initial count
      const initialLogs = logEmitter.getRecentLogs();
      const initialCount = initialLogs.length;

      // Add a log entry
      logEmitter.log("info", "test message");

      // Check it was added
      const logs = logEmitter.getRecentLogs();
      expect(logs.length).toBe(initialCount + 1);

      const lastLog = logs.at(-1);
      expect(lastLog?.level).toBe("info");
      expect(lastLog?.message).toBe("test message");
      expect(lastLog?.timestamp).toBeDefined();
    });

    it("creates log entry with correct structure", () => {
      logEmitter.log("warn", "warning message");

      const logs = logEmitter.getRecentLogs();
      const lastLog = logs.at(-1);

      expect(lastLog).toHaveProperty("level");
      expect(lastLog).toHaveProperty("message");
      expect(lastLog).toHaveProperty("timestamp");
      expect(typeof lastLog?.timestamp).toBe("string");
      // Timestamp should be ISO format
      expect(() => new Date(lastLog?.timestamp ?? "")).not.toThrow();
    });
  });

  describe("buffer limit", () => {
    it("maintains buffer within maxLogs limit (1000)", () => {
      // Add more than maxLogs entries
      for (let i = 0; i < 1050; i++) {
        logEmitter.log("info", `message ${i}`);
      }

      const logs = logEmitter.getRecentLogs(2000);
      // Should not exceed maxLogs (1000)
      expect(logs.length).toBeLessThanOrEqual(1000);
    });

    it("removes oldest entries when buffer is full", () => {
      // Clear by adding many entries to push out old ones
      for (let i = 0; i < 1001; i++) {
        logEmitter.log("info", `overflow-test-${i}`);
      }

      const logs = logEmitter.getRecentLogs(1000);
      // The first entry should have been shifted out
      const hasFirstEntry = logs.some(
        (log) => log.message === "overflow-test-0",
      );
      expect(hasFirstEntry).toBe(false);

      // But later entries should exist
      const hasLastEntry = logs.some(
        (log) => log.message === "overflow-test-1000",
      );
      expect(hasLastEntry).toBe(true);
    });
  });

  describe("event listeners", () => {
    it("emits events to listeners when log is added", () => {
      const receivedEntries: Array<{ level: string; message: string }> = [];
      const listener = (entry: { level: string; message: string }) => {
        receivedEntries.push(entry);
      };

      logEmitter.on("log", listener);
      logEmitter.log("error", "listener test message");

      expect(receivedEntries.length).toBeGreaterThanOrEqual(1);
      const lastReceived = receivedEntries.at(-1);
      expect(lastReceived?.level).toBe("error");
      expect(lastReceived?.message).toBe("listener test message");

      // Cleanup
      logEmitter.off("log", listener);
    });

    it("can unsubscribe listeners", () => {
      let callCount = 0;
      const listener = () => {
        callCount++;
      };

      logEmitter.on("log", listener);
      logEmitter.log("info", "before unsubscribe");
      const countAfterFirst = callCount;

      logEmitter.off("log", listener);
      logEmitter.log("info", "after unsubscribe");

      // Should not have increased after unsubscribe
      expect(callCount).toBe(countAfterFirst);
    });

    it("handles multiple listeners", () => {
      const results: Array<string> = [];

      const listener1 = () => results.push("listener1");
      const listener2 = () => results.push("listener2");

      logEmitter.on("log", listener1);
      logEmitter.on("log", listener2);

      logEmitter.log("info", "multi-listener test");

      expect(results).toContain("listener1");
      expect(results).toContain("listener2");

      // Cleanup
      logEmitter.off("log", listener1);
      logEmitter.off("log", listener2);
    });

    it("handles listener errors gracefully", () => {
      const errorListener = createErrorListener();
      const goodListener = mock(() => {});

      logEmitter.on("log", errorListener);
      logEmitter.on("log", goodListener);

      // Should not throw
      expect(() => logEmitter.log("info", "error test")).not.toThrow();

      // Good listener should still be called
      expect(goodListener).toHaveBeenCalled();

      // Cleanup
      logEmitter.off("log", errorListener);
      logEmitter.off("log", goodListener);
    });
  });

  describe("getRecentLogs", () => {
    it("returns limited number of logs", () => {
      // Add some logs
      for (let i = 0; i < 50; i++) {
        logEmitter.log("info", `recent-log-${i}`);
      }

      const logs = logEmitter.getRecentLogs(10);
      expect(logs.length).toBeLessThanOrEqual(10);
    });

    it("returns most recent logs", () => {
      logEmitter.log("info", "older-log");
      logEmitter.log("info", "newer-log");

      const logs = logEmitter.getRecentLogs(2);
      const lastLog = logs.at(-1);
      expect(lastLog?.message).toBe("newer-log");
    });

    it("defaults to 100 logs when no limit specified", () => {
      const logs = logEmitter.getRecentLogs();
      expect(logs.length).toBeLessThanOrEqual(100);
    });
  });
});
