import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types";

import { state } from "../src/lib/state";
import { createMessages } from "../src/services/copilot/create-messages";

// Mock state
state.copilotToken = "test-token";
state.vsCodeVersion = "1.0.0";
state.accountType = "individual";

describe("createMessages service", () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("throws error when copilot token is missing", async () => {
    const originalToken = state.copilotToken;
    state.copilotToken = undefined;

    try {
      await expect(
        createMessages(
          { model: "test", messages: [], max_tokens: 100 },
          undefined,
          { requestId: "test-id" },
        ),
      ).rejects.toThrow("Copilot token not found");
    } finally {
      state.copilotToken = originalToken;
    }
  });

  test("sends request to /v1/messages endpoint", async () => {
    let capturedUrl = "";
    const fetchMock = mock((url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          model: "claude-test",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };

    await createMessages(payload, undefined, { requestId: "test-id" });

    expect(capturedUrl).toContain("/v1/messages");
  });

  test("sets x-initiator header to user for user-initiated requests", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) => {
        capturedHeaders = opts.headers;
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            model: "claude-test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };

    await createMessages(payload, undefined, { requestId: "test-id" });

    expect(capturedHeaders["x-initiator"]).toBe("user");
  });

  test("sets x-initiator header to agent for tool_result responses", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) => {
        capturedHeaders = opts.headers;
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            model: "claude-test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_123", content: "result" },
          ],
        },
      ],
      max_tokens: 1000,
    };

    await createMessages(payload, undefined, { requestId: "test-id" });

    expect(capturedHeaders["x-initiator"]).toBe("agent");
  });

  test("sets vision header when image is present", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) => {
        capturedHeaders = opts.headers;
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "I see the image" }],
            model: "claude-test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "base64data",
              },
            },
          ],
        },
      ],
      max_tokens: 1000,
    };

    await createMessages(payload, undefined, { requestId: "test-id" });

    expect(capturedHeaders["copilot-vision-request"]).toBe("true");
  });

  test("adds anthropic-beta header for extended thinking", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) => {
        capturedHeaders = opts.headers;
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Thinking..." }],
            model: "claude-test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
      thinking: { type: "enabled", budget_tokens: 10000 },
    };

    await createMessages(payload, undefined, { requestId: "test-id" });

    expect(capturedHeaders["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14",
    );
  });

  test("does not add anthropic-beta for adaptive thinking", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) => {
        capturedHeaders = opts.headers;
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            model: "claude-test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
      thinking: { type: "adaptive" },
    };

    await createMessages(payload, undefined, { requestId: "test-id" });

    expect(capturedHeaders["anthropic-beta"]).toBeUndefined();
  });

  test("filters and passes allowed anthropic-beta headers from client", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) => {
        capturedHeaders = opts.headers;
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            model: "claude-test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };

    // Pass allowed beta header
    await createMessages(
      payload,
      "context-management-2025-06-27,invalid-beta",
      {
        requestId: "test-id",
      },
    );

    // Should only contain the allowed beta
    expect(capturedHeaders["anthropic-beta"]).toBe(
      "context-management-2025-06-27",
    );
  });

  test("returns streaming response for stream=true", async () => {
    const fetchMock = mock(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: message_start\ndata: {"type":"message_start"}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
      stream: true,
    };

    const result = await createMessages(payload, undefined, {
      requestId: "test-id",
    });

    // Should return an async iterable (events stream)
    expect(Symbol.asyncIterator in (result as object)).toBe(true);
  });

  test("returns JSON response for stream=false", async () => {
    const fetchMock = mock(() => {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          model: "claude-test",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
      stream: false,
    };

    const result = await createMessages(payload, undefined, {
      requestId: "test-id",
    });

    expect(result).toHaveProperty("id", "msg_test");
    expect(result).toHaveProperty("type", "message");
  });

  test("throws HTTPError for non-OK response", async () => {
    const fetchMock = mock(() => {
      return new Response(
        JSON.stringify({ error: { message: "Bad request" } }),
        { status: 400 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1000,
    };

    await expect(
      createMessages(payload, undefined, { requestId: "test-id" }),
    ).rejects.toThrow("Failed to create messages");
  });
});
