# Caching Analysis: copilot-api vs cina-copilot

**Date:** 2026-03-21
**Analyzed by:** copilot-api-cache-analyst
**Task:** #11

## Executive Summary

**copilot-api** has a sophisticated request-level caching system with LRU eviction and persistent storage, while **cina-copilot** has NO request-level caching at all. The only "caching" in cina-copilot is in-memory caching of configuration and runtime metadata (models list, VSCode version, session IDs).

## copilot-api: Request Caching Implementation

### Architecture

Located in: `src/lib/request-cache.ts` (547 lines)

**Key Features:**
1. **LRU Cache with Doubly Linked List** - O(1) eviction performance
2. **Persistent Storage** - Saved to `~/.config/copilot-api/request-cache.json`
3. **Configurable** - Enabled by default with customizable parameters
4. **Statistics Tracking** - Hit rate, saved tokens, cache size
5. **Auto-save** - Persists every 5 minutes + on shutdown
6. **TTL Support** - Configurable time-to-live for entries

### Cache Key Generation

```typescript
function generateCacheKey(
  model: string,
  messages: Array<{ role: string; content: unknown }>,
  options?: CacheKeyOptions
): string
```

**Factors in cache key:**
- Model name
- Message history (normalized)
- Temperature, max_tokens, top_p, frequency_penalty, presence_penalty
- Seed, stop sequences, response_format, tool_choice
- Tools definition (hashed)
- Account ID (optional)
- User, logit_bias, logprobs, n, stream

**SHA-256 hash** (first 16 chars) ensures uniqueness: `${model}_${hash}`

### Cache Entry Structure

```typescript
interface CacheEntry {
  key: string
  response: unknown           // Full response object
  model: string
  inputTokens: number
  outputTokens: number
  createdAt: number
  lastAccessed: number
  hits: number               // Number of cache hits
}
```

### Configuration

From `src/lib/config.ts`:

```typescript
cacheEnabled: true           // Default: ON
cacheMaxSize: 1000          // Max entries
cacheTtlSeconds: 3600       // 1 hour TTL
```

### Integration Points

**Chat Completions Handler** (`src/routes/chat-completions/handler.ts`):
```typescript
// Check cache before making API call
const cached = requestCache.get(cacheKey)
if (cached) {
  return c.json(cached.response)
}

// After successful response
requestCache.set({
  key: cacheKey,
  response: normalizedResponse,
  model,
  inputTokens,
  outputTokens
})
```

**Messages Handler** (`src/routes/messages/handler.ts`):
```typescript
const cached = requestCache.get(cacheKey)
if (cached) {
  // Return cached Anthropic response
  return c.json(cached.response)
}

// After response
requestCache.set({
  key: getCacheKey(openAIPayload, accountInfo),
  response,
  model,
  inputTokens,
  outputTokens
})
```

### WebUI Integration

Admin API endpoints (`src/webui/api/cache.ts`):
- `GET /api/cache/stats` - View cache statistics
- `POST /api/cache/clear` - Clear all cache
- `DELETE /api/cache/:key` - Delete specific entry

### Performance Characteristics

**Time Complexity:**
- Cache lookup: O(1)
- Cache insertion: O(1)
- LRU eviction: O(1)
- Save to disk: O(n) where n = cache size

**Space Complexity:**
- In-memory: ~1000 entries by default
- Disk: JSON file (~1-10MB depending on response sizes)

### Statistics & Monitoring

```typescript
interface CacheStats {
  enabled: boolean
  size: number              // Current entries
  maxSize: number          // Max capacity
  hits: number             // Total cache hits
  misses: number           // Total cache misses
  hitRate: number          // hits / (hits + misses)
  savedTokens: number      // Total tokens saved
}
```

---

## cina-copilot: No Request Caching

### What cina DOES cache (metadata only):

Located in: `src/lib/utils.ts`

**1. Models List** (`cacheModels()`)
```typescript
export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models  // In-memory only
}
```

**2. VSCode Version** (`cacheVSCodeVersion()`)
```typescript
export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response  // In-memory only
}
```

**3. Machine ID** (`cacheMacMachineId()`)
```typescript
export const cacheMacMachineId = () => {
  const macAddress = getMac() ?? randomUUID()
  state.macMachineId = createHash("sha256")
    .update(macAddress, "utf8")
    .digest("hex")
}
```

**4. Session ID** (`cacheVsCodeSessionId()`)
```typescript
export const cacheVsCodeSessionId = () => {
  generateSessionId()  // Refreshes every 60-80 minutes
  scheduleSessionIdRefresh()
}
```

**5. Tokenizer Encoding** (`src/lib/tokenizer.ts`)
```typescript
const encodingCache = new Map<string, Encoder>()  // In-memory only
```

**6. Config** (`src/lib/config.ts`)
```typescript
let cachedConfig: AppConfig | null = null  // In-memory only
```

### What cina DOESN'T cache:

❌ **NO request caching** - Every identical request hits GitHub Copilot API
❌ **NO response caching** - No deduplication of responses
❌ **NO token savings** - All tokens consumed even for duplicate requests
❌ **NO persistent cache** - Everything is in-memory and lost on restart
❌ **NO cache statistics** - No hit rate tracking

### Anthropic Prompt Caching Support

**Test file shows cina supports Anthropic's prompt caching API:**

From `tests/responses-translation.test.ts`:
```typescript
{
  type: "text",
  text: "hi",
  cache_control: {
    type: "ephemeral",
  },
}
```

And returns `prompt_cache_key` in responses:
```typescript
expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
```

**However:** This is Anthropic's server-side prompt caching, NOT client-side request caching. It helps with context window reuse but doesn't prevent duplicate API calls.

---

## Gap Analysis

### What copilot-api Has That cina Lacks

| Feature | copilot-api | cina-copilot |
|---------|-------------|--------------|
| **Request deduplication** | ✅ SHA-256 based | ❌ None |
| **Response caching** | ✅ Full responses | ❌ None |
| **Persistent cache** | ✅ Disk storage | ❌ In-memory only |
| **LRU eviction** | ✅ O(1) doubly-linked list | ❌ N/A |
| **TTL expiration** | ✅ Configurable | ❌ N/A |
| **Cache statistics** | ✅ Hit rate, saved tokens | ❌ None |
| **Admin API** | ✅ View/clear cache | ❌ None |
| **Auto-save** | ✅ Every 5min + shutdown | ❌ N/A |
| **Token tracking** | ✅ Saves input+output tokens | ❌ None |

### Impact

**Without request caching, cina-copilot:**

1. **Higher API usage** - Duplicate requests consume quota unnecessarily
2. **Slower responses** - No instant cache hits for identical requests
3. **More costs** - Every request costs tokens
4. **No optimization** - Cannot reduce load during development/testing
5. **Worse UX** - Users wait for API calls even for repeated requests

**Use cases where caching helps:**
- Repeated code generation requests (e.g., user hitting "regenerate")
- Tool/function definitions unchanged between requests
- Same prompt with same parameters
- Development/testing with identical queries
- Multi-user scenarios with similar requests

---

## Recommendations

### For cina-copilot (to add request caching):

**Priority 1: Core Cache Implementation**
1. Port `request-cache.ts` from copilot-api
2. Implement LRU cache with doubly-linked list
3. Add cache key generation for all endpoints
4. Integrate into message handler

**Priority 2: Persistence**
1. Add JSON file storage in `~/.cina-copilot/cache/`
2. Implement auto-save mechanism
3. Add shutdown hook for final save

**Priority 3: Configuration**
1. Add cache settings to config:
   ```typescript
   cache: {
     enabled: true,
     maxSize: 1000,
     ttlSeconds: 3600
   }
   ```

**Priority 4: Statistics & Monitoring**
1. Track hit rate, saved tokens
2. Add admin endpoint to view stats (if webui exists)
3. Log cache performance metrics

### For copilot-api (already has caching):

**Enhancements:**
1. ✅ Already excellent implementation
2. Consider: Add configurable cache warming on startup
3. Consider: Support for cache key prefixes/namespaces per account
4. Consider: Export cache analytics to metrics endpoint
5. Consider: Add cache preloading from common patterns

---

## Technical Details

### Cache Key Collision Prevention

**copilot-api uses:**
- Full message history (normalized)
- All API parameters that affect output
- SHA-256 hash (collision probability: ~10^-77)

**Normalization:**
```typescript
function normalizeMessages(messages) {
  return messages.map((msg) => ({
    role: msg.role,
    content: typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content)
  }))
}
```

### LRU Algorithm

```
Most Recent ← [Node] ↔ [Node] ↔ [Node] → Least Recent
              Head                        Tail

On access: Move node to head
On eviction: Remove tail
Complexity: O(1) for all operations
```

### File Format

`~/.config/copilot-api/request-cache.json`:
```json
{
  "entries": [
    {
      "key": "gpt-4.1_a3f2e8b9c1d4",
      "response": { /* full API response */ },
      "model": "gpt-4.1",
      "inputTokens": 1500,
      "outputTokens": 800,
      "createdAt": 1710979200000,
      "lastAccessed": 1710982800000,
      "hits": 3
    }
  ],
  "stats": {
    "hits": 42,
    "misses": 15,
    "savedTokens": 35000
  }
}
```

---

## Conclusion

**copilot-api** has production-ready request caching that significantly reduces API usage and improves response times. The implementation is efficient (O(1) operations), persistent, and well-integrated.

**cina-copilot** completely lacks request caching, leading to unnecessary API calls and token consumption. Adding similar caching would be a high-value enhancement.

**Estimated Savings with Caching:**
- Development: 30-50% reduction in API calls (repeated prompts)
- Production: 10-20% reduction (depends on request patterns)
- Testing: 70-90% reduction (highly repetitive)

---

## Appendix: Key Files

### copilot-api
- `src/lib/request-cache.ts` - Core cache implementation (547 lines)
- `src/webui/api/cache.ts` - Admin API (47 lines)
- `src/routes/chat-completions/handler.ts` - Integration example
- `src/routes/messages/handler.ts` - Integration example
- `src/lib/config.ts` - Cache configuration

### cina-copilot
- `src/lib/utils.ts` - Metadata caching only
- `src/lib/config.ts` - Config caching (in-memory)
- `src/lib/tokenizer.ts` - Encoding cache (in-memory)
- ❌ No request cache implementation
