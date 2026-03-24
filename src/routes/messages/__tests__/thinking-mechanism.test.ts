import { beforeEach, describe, expect, it } from "bun:test";

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions";

import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "../anthropic-types";

import {
  THINKING_TEXT,
  translateChunkToAnthropicEvents,
} from "../stream-translation";

// Helper to create a clean stream state for each test
function createCleanState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    toolCalls: {},
  };
}

// Helper to create a basic chunk with support for reasoning_text and reasoning_opaque
function createBasicChunk(
  delta: ChatCompletionChunk["choices"][0]["delta"] & {
    reasoning_text?: string | null;
    reasoning_opaque?: string | null;
  },
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "test-chunk-id",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: delta as ChatCompletionChunk["choices"][0]["delta"],
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
  };
}

// Helper to find specific event type in events array
function findEvent<T extends AnthropicStreamEventData["type"]>(
  events: Array<AnthropicStreamEventData>,
  type: T,
): Extract<AnthropicStreamEventData, { type: T }> | undefined {
  return events.find((e) => e.type === type) as
    | Extract<AnthropicStreamEventData, { type: T }>
    | undefined;
}

// Helper to find all events of a specific type
function findEvents<T extends AnthropicStreamEventData["type"]>(
  events: Array<AnthropicStreamEventData>,
  type: T,
): Array<Extract<AnthropicStreamEventData, { type: T }>> {
  return events.filter((e) => e.type === type) as Array<
    Extract<AnthropicStreamEventData, { type: T }>
  >;
}

describe("handleThinkingText", () => {
  let state: AnthropicStreamState;

  beforeEach(() => {
    state = createCleanState();
  });

  it("should open a thinking block when receiving reasoning_text", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    // Create a chunk with reasoning_text in delta
    const chunk = createBasicChunk({
      reasoning_text: "Let me think about this...",
    });

    const events = translateChunkToAnthropicEvents(chunk, state);

    // Should have content_block_start for thinking
    const startEvent = findEvent(events, "content_block_start");
    expect(startEvent).toBeDefined();
    if (startEvent?.type === "content_block_start") {
      expect(startEvent.content_block).toEqual({
        type: "thinking",
        thinking: "",
      });
    }

    // State should have thinking block open
    expect(state.thinkingBlockOpen).toBe(true);
  });

  it("should send thinking_delta when thinking block is open", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    // Open thinking block first
    const openChunk = createBasicChunk({
      reasoning_text: "First thought...",
    });
    translateChunkToAnthropicEvents(openChunk, state);

    // Send more thinking content
    const continueChunk = createBasicChunk({
      reasoning_text: "More thinking...",
    });
    const events = translateChunkToAnthropicEvents(continueChunk, state);

    // Should have thinking_delta
    const deltaEvent = findEvent(events, "content_block_delta");
    expect(deltaEvent).toBeDefined();
    if (deltaEvent?.type === "content_block_delta") {
      expect(deltaEvent.delta).toEqual({
        type: "thinking_delta",
        thinking: "More thinking...",
      });
    }
  });

  it("should not open thinking block if content block is already open", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    // Open a text content block first
    const textChunk = createBasicChunk({ content: "Hello world" });
    translateChunkToAnthropicEvents(textChunk, state);

    expect(state.contentBlockOpen).toBe(true);

    // Now try to send thinking text - it should be treated as content
    const thinkingChunk = createBasicChunk({
      reasoning_text: "Some thinking",
    });
    translateChunkToAnthropicEvents(thinkingChunk, state);

    // thinkingBlockOpen should still be false because contentBlockOpen was true
    expect(state.thinkingBlockOpen).toBe(false);
  });
});

describe("closeThinkingBlockIfOpen", () => {
  let state: AnthropicStreamState;

  beforeEach(() => {
    state = createCleanState();
  });

  it("should close thinking block with signature_delta when text content arrives", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    // Open thinking block
    const thinkingChunk = createBasicChunk({
      reasoning_text: "Thinking...",
    });
    translateChunkToAnthropicEvents(thinkingChunk, state);

    expect(state.thinkingBlockOpen).toBe(true);
    const originalBlockIndex = state.contentBlockIndex;

    // Now send regular content - this should close the thinking block
    const contentChunk = createBasicChunk({ content: "Here is my answer" });
    const events = translateChunkToAnthropicEvents(contentChunk, state);

    // Should have signature_delta to close thinking block
    const signatureDelta = findEvents(events, "content_block_delta").find(
      (e) => e.delta.type === "signature_delta",
    );
    expect(signatureDelta).toBeDefined();
    if (signatureDelta?.delta.type === "signature_delta") {
      expect(signatureDelta.delta.signature).toBe("");
    }

    // Should have content_block_stop for thinking
    const stopEvent = findEvent(events, "content_block_stop");
    expect(stopEvent).toBeDefined();
    expect(stopEvent?.index).toBe(originalBlockIndex);

    // State should update
    expect(state.thinkingBlockOpen).toBe(false);
    expect(state.contentBlockIndex).toBeGreaterThan(originalBlockIndex);
  });

  it("should not emit events if thinking block is not open", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    expect(state.thinkingBlockOpen).toBe(false);

    // Send content directly
    const contentChunk = createBasicChunk({ content: "Direct answer" });
    const events = translateChunkToAnthropicEvents(contentChunk, state);

    // Should not have signature_delta
    const signatureDelta = findEvents(events, "content_block_delta").find(
      (e) => e.delta.type === "signature_delta",
    );
    expect(signatureDelta).toBeUndefined();
  });
});

describe("handleReasoningOpaque", () => {
  let state: AnthropicStreamState;

  beforeEach(() => {
    state = createCleanState();
  });

  it("should emit signature_delta when reasoning_opaque arrives with thinking block open", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    // Open thinking block first
    const thinkingChunk = createBasicChunk({
      reasoning_text: "Thinking...",
    });
    translateChunkToAnthropicEvents(thinkingChunk, state);

    expect(state.thinkingBlockOpen).toBe(true);
    const originalBlockIndex = state.contentBlockIndex;

    // Send reasoning_opaque with empty content (as per implementation logic at line 319-341)
    // When thinking block is open, reasoning_opaque with content="" closes it
    const opaqueChunk = createBasicChunk({
      content: "",
      reasoning_opaque: "opaque-signature-data",
    });
    const events = translateChunkToAnthropicEvents(opaqueChunk, state);

    // Should have signature_delta
    const signatureDeltas = findEvents(events, "content_block_delta").filter(
      (e) => e.delta.type === "signature_delta",
    );
    expect(signatureDeltas).toHaveLength(1);
    if (signatureDeltas[0]?.delta.type === "signature_delta") {
      expect(signatureDeltas[0].delta.signature).toBe("opaque-signature-data");
    }

    // Should have content_block_stop
    const stopEvent = findEvent(events, "content_block_stop");
    expect(stopEvent).toBeDefined();
    expect(stopEvent?.index).toBe(originalBlockIndex);

    // State should update
    expect(state.thinkingBlockOpen).toBe(false);
    expect(state.contentBlockIndex).toBe(originalBlockIndex + 1);
  });

  it("should emit complete thinking block with signature for reasoning_opaque at finish", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    const originalBlockIndex = state.contentBlockIndex;

    // Create a chunk with reasoning_opaque AND finish_reason (how it works in practice)
    // handleReasoningOpaque is only called when finish_reason is present
    const chunk = createBasicChunk(
      {
        reasoning_opaque: "opaque-signature-data",
      },
      "stop",
    );
    const events = translateChunkToAnthropicEvents(chunk, state);

    // Should have content_block_start for thinking
    const startEvent = findEvent(events, "content_block_start");
    expect(startEvent).toBeDefined();
    if (startEvent?.type === "content_block_start") {
      expect(startEvent.index).toBe(originalBlockIndex);
      expect(startEvent.content_block).toEqual({
        type: "thinking",
        thinking: "",
      });
    }

    // Should have thinking_delta with THINKING_TEXT
    const thinkingDeltas = findEvents(events, "content_block_delta").filter(
      (e) => e.delta.type === "thinking_delta",
    );
    expect(thinkingDeltas).toHaveLength(1);
    if (thinkingDeltas[0]?.delta.type === "thinking_delta") {
      expect(thinkingDeltas[0].delta.thinking).toBe(THINKING_TEXT);
    }

    // Should have signature_delta with the opaque data
    const signatureDeltas = findEvents(events, "content_block_delta").filter(
      (e) => e.delta.type === "signature_delta",
    );
    expect(signatureDeltas).toHaveLength(1);
    if (signatureDeltas[0]?.delta.type === "signature_delta") {
      expect(signatureDeltas[0].delta.signature).toBe("opaque-signature-data");
    }

    // Should have content_block_stop
    const stopEvent = findEvent(events, "content_block_stop");
    expect(stopEvent).toBeDefined();
    expect(stopEvent?.index).toBe(originalBlockIndex);

    // Content block index should increment (after thinking block closed)
    expect(state.contentBlockIndex).toBe(originalBlockIndex + 1);
  });

  it("should not emit events for empty reasoning_opaque", () => {
    // First, send a chunk with role to trigger message_start
    const roleChunk = createBasicChunk({ role: "assistant" });
    translateChunkToAnthropicEvents(roleChunk, state);

    // Empty reasoning_opaque with finish_reason
    const chunk = createBasicChunk(
      {
        reasoning_opaque: "",
      },
      "stop",
    );
    const events = translateChunkToAnthropicEvents(chunk, state);

    // Should not have thinking block events (only message events)
    const startEvents = findEvents(events, "content_block_start");
    expect(startEvents).toHaveLength(0);
  });
});

describe("Complete thinking flow integration", () => {
  let state: AnthropicStreamState;

  beforeEach(() => {
    state = createCleanState();
  });

  it("should handle full thinking -> content -> finish flow", () => {
    const allEvents: Array<AnthropicStreamEventData> = [];

    // 1. First chunk with role
    const roleChunk = createBasicChunk({ role: "assistant" });
    allEvents.push(...translateChunkToAnthropicEvents(roleChunk, state));

    // Should have message_start
    expect(findEvent(allEvents, "message_start")).toBeDefined();
    expect(state.messageStartSent).toBe(true);

    // 2. Thinking content
    const thinking1 = createBasicChunk({
      reasoning_text: "Let me analyze this problem...",
    });
    allEvents.push(...translateChunkToAnthropicEvents(thinking1, state));

    expect(state.thinkingBlockOpen).toBe(true);
    expect(state.contentBlockIndex).toBe(0);

    // 3. More thinking
    const thinking2 = createBasicChunk({
      reasoning_text: " I need to consider multiple factors.",
    });
    allEvents.push(...translateChunkToAnthropicEvents(thinking2, state));

    expect(state.thinkingBlockOpen).toBe(true);

    // 4. Regular content (should close thinking block)
    const content1 = createBasicChunk({ content: "Based on my analysis, " });
    allEvents.push(...translateChunkToAnthropicEvents(content1, state));

    expect(state.thinkingBlockOpen).toBe(false);
    expect(state.contentBlockOpen).toBe(true);
    expect(state.contentBlockIndex).toBe(1);

    // 5. More content
    const content2 = createBasicChunk({ content: "here is my answer." });
    allEvents.push(...translateChunkToAnthropicEvents(content2, state));

    // 6. Finish
    const finishChunk = createBasicChunk({}, "stop");
    allEvents.push(...translateChunkToAnthropicEvents(finishChunk, state));

    // Verify final state
    expect(state.contentBlockOpen).toBe(false);
    expect(findEvent(allEvents, "message_stop")).toBeDefined();

    // Count event types
    const messageStarts = findEvents(allEvents, "message_start");
    const blockStarts = findEvents(allEvents, "content_block_start");
    const blockStops = findEvents(allEvents, "content_block_stop");

    expect(messageStarts).toHaveLength(1);
    expect(blockStarts).toHaveLength(2); // thinking block + text block
    expect(blockStops).toHaveLength(2); // both blocks closed
  });

  it("should handle reasoning_opaque at finish after content", () => {
    const allEvents: Array<AnthropicStreamEventData> = [];

    // 1. First chunk with role
    const roleChunk = createBasicChunk({ role: "assistant" });
    allEvents.push(...translateChunkToAnthropicEvents(roleChunk, state));

    // 2. Regular content first
    const contentChunk = createBasicChunk({ content: "The answer is 42." });
    allEvents.push(...translateChunkToAnthropicEvents(contentChunk, state));

    expect(state.contentBlockOpen).toBe(true);
    expect(state.contentBlockIndex).toBe(0);

    // 3. Finish with reasoning_opaque (complete thinking block at end)
    const finishChunk = createBasicChunk(
      {
        reasoning_opaque: "encrypted-thinking-data",
      },
      "stop",
    );
    allEvents.push(...translateChunkToAnthropicEvents(finishChunk, state));

    // Verify blocks: text block first, then thinking block at finish
    const blockStarts = findEvents(allEvents, "content_block_start");
    expect(blockStarts).toHaveLength(2); // text + opaque thinking

    // First should be text
    expect(blockStarts[0]?.content_block.type).toBe("text");
    // Second should be thinking (from reasoning_opaque at finish)
    expect(blockStarts[1]?.content_block.type).toBe("thinking");
  });

  it("should handle only content without thinking", () => {
    const allEvents: Array<AnthropicStreamEventData> = [];

    // 1. First chunk with role
    const roleChunk = createBasicChunk({ role: "assistant" });
    allEvents.push(...translateChunkToAnthropicEvents(roleChunk, state));

    // 2. Direct content
    const content1 = createBasicChunk({ content: "Hello, " });
    allEvents.push(...translateChunkToAnthropicEvents(content1, state));

    expect(state.thinkingBlockOpen).toBe(false);
    expect(state.contentBlockOpen).toBe(true);

    // 3. More content
    const content2 = createBasicChunk({ content: "world!" });
    allEvents.push(...translateChunkToAnthropicEvents(content2, state));

    // 4. Finish
    const finishChunk = createBasicChunk({}, "stop");
    allEvents.push(...translateChunkToAnthropicEvents(finishChunk, state));

    // Should only have one block (text)
    const blockStarts = findEvents(allEvents, "content_block_start");
    expect(blockStarts).toHaveLength(1);
    expect(blockStarts[0]?.content_block.type).toBe("text");

    // No thinking deltas
    const thinkingDeltas = findEvents(allEvents, "content_block_delta").filter(
      (e) => e.delta.type === "thinking_delta",
    );
    expect(thinkingDeltas).toHaveLength(0);
  });

  it("should handle thinking with reasoning_opaque closing the block", () => {
    const allEvents: Array<AnthropicStreamEventData> = [];

    // 1. First chunk with role
    const roleChunk = createBasicChunk({ role: "assistant" });
    allEvents.push(...translateChunkToAnthropicEvents(roleChunk, state));

    // 2. Thinking content
    const thinkingChunk = createBasicChunk({
      reasoning_text: "Analyzing the problem...",
    });
    allEvents.push(...translateChunkToAnthropicEvents(thinkingChunk, state));
    expect(state.thinkingBlockOpen).toBe(true);

    // 3. reasoning_opaque closes thinking block (with empty content)
    const opaqueChunk = createBasicChunk({
      content: "",
      reasoning_opaque: "signature-data",
    });
    allEvents.push(...translateChunkToAnthropicEvents(opaqueChunk, state));

    expect(state.thinkingBlockOpen).toBe(false);
    expect(state.contentBlockIndex).toBe(1);

    // 4. Regular content
    const contentChunk = createBasicChunk({ content: "The answer is 42." });
    allEvents.push(...translateChunkToAnthropicEvents(contentChunk, state));

    expect(state.contentBlockOpen).toBe(true);

    // 5. Finish
    const finishChunk = createBasicChunk({}, "stop");
    allEvents.push(...translateChunkToAnthropicEvents(finishChunk, state));

    // Verify blocks
    const blockStarts = findEvents(allEvents, "content_block_start");
    expect(blockStarts).toHaveLength(2); // thinking + text

    // First should be thinking
    expect(blockStarts[0]?.content_block.type).toBe("thinking");
    // Second should be text
    expect(blockStarts[1]?.content_block.type).toBe("text");
  });
});

describe("THINKING_TEXT constant", () => {
  it("should equal 'Thinking...'", () => {
    expect(THINKING_TEXT).toBe("Thinking...");
  });
});
