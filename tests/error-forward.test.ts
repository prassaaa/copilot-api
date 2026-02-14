import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { forwardError } from "../src/lib/error"

describe("forwardError", () => {
  test("returns 499 for client abort error", async () => {
    const app = new Hono()
    app.get("/", async (c) => {
      return forwardError(c, new Error("The operation was aborted."))
    })

    const response = await app.request("/")
    const body = await response.json()

    expect(response.status).toBe(499)
    expect(body).toEqual({
      error: {
        message: "Request aborted by client",
        type: "aborted",
      },
    })
  })

  test("keeps 500 for generic errors", async () => {
    const app = new Hono()
    app.get("/", async (c) => {
      return forwardError(c, new Error("Something else failed"))
    })

    const response = await app.request("/")

    expect(response.status).toBe(500)
  })
})
