/**
 * Unit tests for paths module
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, ensurePaths } from "../paths"

describe("Paths Module", () => {
  describe("PATHS constants", () => {
    it("PATHS.APP_DIR is defined", () => {
      expect(PATHS.APP_DIR).toBeDefined()
      expect(typeof PATHS.APP_DIR).toBe("string")
      expect(PATHS.APP_DIR.length).toBeGreaterThan(0)
    })

    it("PATHS.APP_DIR contains copilot-api", () => {
      expect(PATHS.APP_DIR).toContain("copilot-api")
    })

    it("PATHS.APP_DIR is in home directory", () => {
      const homeDir = os.homedir()
      expect(PATHS.APP_DIR.startsWith(homeDir)).toBe(true)
    })

    it("PATHS.GITHUB_TOKEN_PATH is defined", () => {
      expect(PATHS.GITHUB_TOKEN_PATH).toBeDefined()
      expect(typeof PATHS.GITHUB_TOKEN_PATH).toBe("string")
    })

    it("PATHS.GITHUB_TOKEN_PATH is inside APP_DIR", () => {
      expect(PATHS.GITHUB_TOKEN_PATH.startsWith(PATHS.APP_DIR)).toBe(true)
    })

    it("PATHS.GITHUB_TOKEN_PATH has correct filename", () => {
      const filename = path.basename(PATHS.GITHUB_TOKEN_PATH)
      expect(filename).toBe("github_token")
    })
  })

  describe("ensurePaths", () => {
    const testDir = path.join(os.tmpdir(), "copilot-api-paths-test")

    beforeEach(async () => {
      // Clean up test directory if exists
      try {
        await fs.rm(testDir, { recursive: true, force: true })
      } catch {
        // Ignore if doesn't exist
      }
    })

    afterEach(async () => {
      // Clean up after tests
      try {
        await fs.rm(testDir, { recursive: true, force: true })
      } catch {
        // Ignore if doesn't exist
      }
    })

    it("ensurePaths creates APP_DIR directory", async () => {
      // Call ensurePaths (it will create the actual APP_DIR)
      await ensurePaths()

      // Verify directory exists
      const stat = await fs.stat(PATHS.APP_DIR)
      expect(stat.isDirectory()).toBe(true)
    })

    it("ensurePaths creates github_token file", async () => {
      await ensurePaths()

      // Verify file exists
      const stat = await fs.stat(PATHS.GITHUB_TOKEN_PATH)
      expect(stat.isFile()).toBe(true)
    })

    it("ensurePaths is idempotent", async () => {
      // Call twice should not throw
      await ensurePaths()
      // Should not throw
      await ensurePaths()
    })

    it("ensurePaths sets correct permissions on github_token", async () => {
      await ensurePaths()

      const stat = await fs.stat(PATHS.GITHUB_TOKEN_PATH)
      // 0o600 = owner read/write only (384 in decimal)
      // mode & 0o777 extracts permission bits
      const permissions = stat.mode & 0o777
      expect(permissions).toBe(0o600)
    })

    it("github_token file is writable", async () => {
      await ensurePaths()

      // Should be able to access with write permission (no error thrown = writable)
      // fs.access returns void, we just check it doesn't throw
      let didThrow = false
      try {
        await fs.access(PATHS.GITHUB_TOKEN_PATH, fs.constants.W_OK)
      } catch {
        didThrow = true
      }
      expect(didThrow).toBe(false)
    })
  })

  describe("Path structure", () => {
    it("follows XDG Base Directory Specification", () => {
      // APP_DIR should be in ~/.local/share/
      const expectedBase = path.join(os.homedir(), ".local", "share")
      expect(PATHS.APP_DIR.startsWith(expectedBase)).toBe(true)
    })

    it("all paths are absolute", () => {
      expect(path.isAbsolute(PATHS.APP_DIR)).toBe(true)
      expect(path.isAbsolute(PATHS.GITHUB_TOKEN_PATH)).toBe(true)
    })
  })
})
