<p align="center">
  <img src="public/favicon.svg" alt="Copilot API Logo" width="120" height="120" />
</p>

<h1 align="center">Copilot API</h1>

<p align="center">
  <strong>Transformasi GitHub Copilot jadi API OpenAI/Anthropic yang kompatibel</strong>
</p>

<p align="center">
  <a href="https://github.com/prassaaa/copilot-api/actions"><img src="https://img.shields.io/github/actions/workflow/status/prassaaa/copilot-api/ci.yml?branch=main&style=flat-square&logo=github&label=CI" alt="CI Status" /></a>
  <a href="https://github.com/prassaaa/copilot-api/releases"><img src="https://img.shields.io/github/v/release/prassaaa/copilot-api?style=flat-square&logo=github&color=blue" alt="Release" /></a>
  <a href="https://github.com/prassaaa/copilot-api/blob/main/LICENSE"><img src="https://img.shields.io/github/license/prassaaa/copilot-api?style=flat-square&color=green" alt="License" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Bun-%3E%3D1.2-black?style=flat-square&logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/Hono-4.x-orange?style=flat-square&logo=hono" alt="Hono" />
</p>

<p align="center">
  <a href="#fitur-utama">Fitur</a> •
  <a href="#instalasi">Instalasi</a> •
  <a href="#penggunaan">Penggunaan</a> •
  <a href="#api-endpoints">API</a> •
  <a href="#konfigurasi">Konfigurasi</a> •
  <a href="#arsitektur">Arsitektur</a>
</p>

---

> **Peringatan**: Ini adalah reverse-engineered proxy dari GitHub Copilot API. Tidak didukung resmi oleh GitHub dan bisa berhenti berfungsi kapan saja. Gunakan dengan risiko sendiri.
>
> **Catatan Keamanan GitHub**: Penggunaan berlebihan atau otomatis terhadap Copilot bisa memicu sistem deteksi abuse GitHub. Pastikan kamu review [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies) dan [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot).

---

## Apa Ini?

**Copilot API** adalah proxy server yang mengubah GitHub Copilot API menjadi format yang kompatibel dengan OpenAI Chat Completions API dan Anthropic Messages API. Dengan ini, kamu bisa pake GitHub Copilot di tools yang support format OpenAI/Anthropic, termasuk **Claude Code**!

Basically, ini bikin langganan GitHub Copilot kamu jadi lebih "fleksibel" - bisa dipake di berbagai tools AI tanpa perlu bayar lagi.

---

## Fitur Utama

### Core Features

| Fitur | Deskripsi |
|-------|-----------|
| **OpenAI Compatible** | Endpoint `/v1/chat/completions` yang fully compatible sama OpenAI SDK |
| **Anthropic Compatible** | Endpoint `/v1/messages` buat Claude-style requests |
| **Multi-Account Pool** | Rotasi otomatis antar multiple GitHub accounts buat hindarin rate limit |
| **Request Caching** | LRU cache yang persist ke disk, hemat quota dan response lebih cepet |
| **WebUI Dashboard** | Dashboard mobile-first buat monitoring usage, accounts, dan settings |
| **Streaming Support** | Full streaming support buat real-time responses |
| **Model Fallback** | Auto fallback ke model lain kalo yang diminta gak available |

### Advanced Features

| Fitur | Deskripsi |
|-------|-----------|
| **Adaptive Thinking** | Configurable reasoning effort per model (none, minimal, low, medium, high, xhigh) |
| **Request Queue** | Queue system buat handle concurrent requests dengan rate limiting |
| **Cost Tracking** | Track estimated cost berdasarkan token usage |
| **Webhook Notifications** | Discord/Slack alerts buat quota low, errors, dll |
| **Quota Management** | Auto-pause accounts yang quota-nya abis |
| **Proxy Support** | HTTP/HTTPS proxy support via environment variables |

### Dashboard Features

| Fitur | Deskripsi |
|-------|-----------|
| **Overview** | Statistik real-time, chart usage by model, runtime pulse |
| **Model Catalog** | Browse semua model dengan filter vendor dan search |
| **Usage & Quotas** | Detail quota per akun (Chat, Completions, Premium) |
| **Account Pool** | Manajemen multi-account dengan OAuth flow |
| **Real-time Logs** | Live streaming log dengan filter level, search, export |
| **Request History** | Audit trail paginated dengan filter dan cost tracking |
| **API Playground** | Test endpoint langsung dengan preset templates |

---

## Arsitektur

### Request Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT REQUEST                                  │
│                    (OpenAI SDK / Anthropic SDK / curl)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HONO SERVER                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │    CORS     │→ │    Auth     │→ │   Logging   │→ │    Trace ID         │ │
│  │ Middleware  │  │ Middleware  │  │ Middleware  │  │    Middleware       │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
          ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
          │ /v1/chat/       │ │ /v1/messages    │ │ /v1/embeddings  │
          │ completions     │ │ (Anthropic)     │ │                 │
          │ (OpenAI)        │ │                 │ │                 │
          └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
                   │                   │                   │
                   └───────────────────┼───────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            REQUEST PROCESSING                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Cache     │→ │   Queue     │→ │ Rate Limit  │→ │   Account Pool      │ │
│  │   Check     │  │   System    │  │   Check     │  │   Selection         │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GITHUB COPILOT API                                 │
│                      (api.githubcopilot.com)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          RESPONSE TRANSFORMATION                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Copilot Response  →  OpenAI Format / Anthropic Format              │    │
│  │                    →  Streaming Chunks / Non-Streaming              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT RESPONSE                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Account Pool Selection Strategies

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         SELECTION STRATEGIES                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐     Tetep pake account yang sama sampai error               │
│  │   STICKY    │────────────────────────────────────────────────────────►    │
│  └─────────────┘                                                             │
│                                                                              │
│  ┌─────────────┐     Rotasi berurutan: A → B → C → A → B → C                 │
│  │ ROUND-ROBIN │────────────────────────────────────────────────────────►    │
│  └─────────────┘                                                             │
│                                                                              │
│  ┌─────────────┐     Pilih account dengan quota tertinggi                    │
│  │ QUOTA-BASED │────────────────────────────────────────────────────────►    │
│  └─────────────┘                                                             │
│                                                                              │
│  ┌─────────────┐     Sticky + auto-rotate pas ada error/rate-limit           │
│  │   HYBRID    │────────────────────────────────────────────────────────►    │
│  └─────────────┘     (RECOMMENDED)                                           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Thinking/Reasoning Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           REASONING MECHANISM                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Check Model Reasoning Effort dari Config                                  │
│    ┌───────────────────────────────────────────────────────────────────┐    │
│    │  "gpt-5-mini": "low"      →  Budget: 2048 tokens                  │    │
│    │  "gpt-5.3-codex": "xhigh" →  Budget: 16384 tokens                 │    │
│    │  "gpt-5.4": "xhigh"       →  Budget: 16384 tokens                 │    │
│    │  Default: "high"          →  Budget: 8192 tokens                  │    │
│    └───────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Convert to Anthropic Effort Format                                        │
│    ┌───────────────────────────────────────────────────────────────────┐    │
│    │  xhigh    →  max                                                   │    │
│    │  high     →  high                                                  │    │
│    │  medium   →  medium                                                │    │
│    │  low      →  low                                                   │    │
│    │  minimal  →  low                                                   │    │
│    │  none     →  low                                                   │    │
│    └───────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Apply Thinking Budget ke Request                                         │
│    - Adaptive thinking enabled untuk high/xhigh effort                      │
│    - Budget di-cap berdasarkan max_output_tokens                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Caching Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CACHE FLOW (LRU Algorithm)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Request masuk  →  Generate cache key (SHA-256 hash)                        │
│        │            - model name                                            │
│        │            - messages (normalized)                                 │
│        │            - temperature, max_tokens, tools, etc                   │
│        ▼                                                                    │
│  ┌───────────┐     HIT: Return cached response                              │
│  │ Cache Get │─────────────────────────────────────────────────────────►    │
│  └─────┬─────┘     - Update lastAccessed                                    │
│        │           - Move to front of LRU list                              │
│        │ MISS      - Increment hit counter                                  │
│        ▼                                                                    │
│  Forward ke Copilot API                                                     │
│        │                                                                    │
│        ▼                                                                    │
│  ┌───────────┐                                                              │
│  │ Cache Set │  →  Store response + add to front of LRU                     │
│  └───────────┘  →  Evict tail if exceeds maxSize                            │
│                                                                             │
│  Auto-save setiap 5 menit ke disk                                           │
│  Auto-evict entries yang expired (TTL)                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Struktur Folder

```
copilot-api/
├── src/
│   ├── main.ts                    # CLI entry point (citty)
│   ├── server.ts                  # Hono server setup + middleware
│   ├── start.ts                   # Server orchestration & initialization
│   ├── auth.ts                    # GitHub OAuth flow
│   │
│   ├── lib/
│   │   ├── account-pool.ts        # Multi-account management
│   │   ├── account-pool-selection.ts    # Selection strategies
│   │   ├── account-pool-quota.ts        # Quota tracking
│   │   ├── account-pool-store.ts        # Pool state persistence
│   │   ├── account-pool-notify.ts       # Pool event notifications
│   │   ├── config.ts              # File-based config management
│   │   ├── request-cache.ts       # LRU request caching
│   │   ├── request-queue.ts       # Concurrent request handling
│   │   ├── reasoning.ts           # Thinking/reasoning utilities
│   │   ├── models.ts              # Model ID normalization
│   │   ├── token.ts               # GitHub & Copilot token handling
│   │   ├── state.ts               # Centralized runtime state
│   │   ├── cost-calculator.ts     # Token-based cost tracking
│   │   ├── webhook.ts             # Discord/Slack notifications
│   │   ├── rate-limit.ts          # Rate limiting logic
│   │   ├── fallback.ts            # Model fallback logic
│   │   ├── error.ts               # Custom error classes
│   │   ├── logger.ts              # Logging utilities
│   │   ├── proxy.ts               # HTTP proxy support
│   │   └── ...
│   │
│   ├── routes/
│   │   ├── chat-completions/      # OpenAI /v1/chat/completions
│   │   │   ├── route.ts           # Route handler
│   │   │   ├── handler.ts         # Request processing
│   │   │   ├── request-payload.ts # Zod validation
│   │   │   └── stream-chunks.ts   # Streaming utilities
│   │   ├── messages/              # Anthropic /v1/messages
│   │   │   ├── route.ts
│   │   │   ├── handler.ts
│   │   │   └── stream-translation.ts
│   │   ├── embeddings/            # OpenAI /v1/embeddings
│   │   ├── models/                # GET /models
│   │   ├── responses/             # OpenAI Responses API
│   │   ├── health/                # Health check
│   │   ├── usage/                 # Usage statistics
│   │   └── token/                 # Token info
│   │
│   ├── services/
│   │   ├── copilot/               # GitHub Copilot API client
│   │   │   ├── create-chat-completions.ts
│   │   │   ├── create-embeddings.ts
│   │   │   └── get-models.ts
│   │   └── github/                # GitHub OAuth & API
│   │       ├── get-device-code.ts
│   │       ├── poll-access-token.ts
│   │       ├── get-copilot-token.ts
│   │       └── get-user.ts
│   │
│   └── webui/                     # Dashboard API routes
│       ├── routes.ts              # API endpoints
│       └── api/                   # Individual API handlers
│
├── public/                        # Static files untuk WebUI
│   ├── index.html                 # Dashboard UI (mobile-first)
│   ├── js/app.js                  # Alpine.js application
│   ├── css/                       # Stylesheets
│   └── favicon.svg                # Logo
│
├── tests/                         # Test files
├── dist/                          # Build output
├── CLAUDE.md                      # Claude Code instructions
└── package.json
```

---

## Instalasi

### Prerequisites

- **Bun** >= 1.2.x
- **GitHub Account** dengan akses Copilot (Individual/Business/Enterprise)

### Install via npm

```bash
# Global install
npm install -g copilot-api

# atau pake bunx langsung
bunx copilot-api
```

### Install dari Source

```bash
# Clone repo
git clone https://github.com/prassaaa/copilot-api.git
cd copilot-api

# Install dependencies
bun install

# Build
bun run build

# Run
bun run start
```

---

## Penggunaan

### Quick Start

```bash
# 1. Authenticate dengan GitHub
copilot-api auth

# 2. Start server
copilot-api start

# Server jalan di http://localhost:4141
# Dashboard available di http://localhost:4141
```

### CLI Options

```bash
copilot-api start [options]

Options:
  -p, --port <port>           Port to listen on (default: 4141)
  -v, --verbose               Enable verbose logging
  -d, --debug                 Enable debug mode
  -a, --account-type <type>   Account type: individual|business|enterprise
  -g, --github-token <token>  Provide GitHub token directly
  -c, --claude-code           Generate Claude Code launch command
  -r, --rate-limit <seconds>  Rate limit between requests
  -w, --wait                  Wait instead of error on rate limit
  -f, --fallback              Enable automatic model fallback
  --proxy-env                 Use HTTP_PROXY/HTTPS_PROXY from env
  --webui-password <pass>     Set WebUI authentication password
  --show-token                Show tokens on fetch/refresh
```

### Dengan Claude Code

```bash
# Start server dengan opsi Claude Code
copilot-api start --claude-code

# Pilih model, terus command-nya akan di-copy ke clipboard
# Jalankan command tersebut buat launch Claude Code
```

Manual setup:

```bash
ANTHROPIC_BASE_URL=http://localhost:4141 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL=gpt-4.1 \
claude
```

### Dengan OpenAI SDK

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:4141/v1',
  apiKey: 'dummy', // API key gak dipake, tapi required
});

const response = await client.chat.completions.create({
  model: 'gpt-4.1',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Dengan Anthropic SDK

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://localhost:4141',
  apiKey: 'dummy',
});

const response = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.content);
```

### Dengan curl

```bash
# Chat completion (OpenAI format)
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Messages (Anthropic format)
curl http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## API Endpoints

### OpenAI Compatible

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `POST` | `/v1/chat/completions` | Chat completions (streaming/non-streaming) |
| `POST` | `/chat/completions` | Alias tanpa prefix v1 |
| `GET` | `/v1/models` | List available models |
| `GET` | `/models` | Alias tanpa prefix v1 |
| `POST` | `/v1/embeddings` | Generate embeddings |
| `POST` | `/embeddings` | Alias tanpa prefix v1 |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/responses` | Alias tanpa prefix v1 |

### Anthropic Compatible

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `POST` | `/v1/messages` | Anthropic Messages API |

### Utility Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `GET` | `/health` | Health check |
| `GET` | `/usage` | Usage statistics |
| `GET` | `/token` | Current Copilot token info |
| `GET` | `/account-limits` | Account quota/limits |

### WebUI API

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `GET` | `/` | WebUI Dashboard |
| `GET` | `/api/config` | Get configuration |
| `POST` | `/api/config` | Update configuration |
| `GET` | `/api/accounts` | List pool accounts |
| `POST` | `/api/accounts` | Add account to pool |
| `DELETE` | `/api/accounts/:id` | Remove account |
| `POST` | `/api/accounts/:id/pause` | Pause/resume account |
| `POST` | `/api/accounts/:id/set-current` | Set current account |
| `GET` | `/api/cache/stats` | Cache statistics |
| `POST` | `/api/cache/clear` | Clear cache |
| `GET` | `/api/queue/stats` | Queue statistics |
| `GET` | `/api/logs/stream` | Real-time log stream (SSE) |
| `GET` | `/api/notifications/stream` | Notification stream (SSE) |

---

## Konfigurasi

Config file ada di `~/.config/copilot-api/config.json`

### Contoh Konfigurasi Lengkap

```json
{
  "port": 4141,
  "debug": false,
  "apiKeys": [],
  "webuiPassword": "",

  "rateLimitSeconds": null,
  "rateLimitWait": false,

  "fallbackEnabled": false,
  "modelMapping": {},

  "trackUsage": true,
  "trackCost": true,

  "defaultModel": "gpt-4.1",
  "defaultSmallModel": "gpt-4.1",
  "smallModel": "gpt-5-mini",
  "compactUseSmallModel": true,
  "warmupUseSmallModel": true,

  "poolEnabled": true,
  "poolStrategy": "hybrid",
  "poolAccounts": [
    { "token": "ghp_xxx", "label": "account-1" },
    { "token": "ghp_yyy", "label": "account-2" }
  ],

  "queueEnabled": true,
  "queueMaxConcurrent": 3,
  "queueMaxSize": 100,
  "queueTimeout": 60000,

  "cacheEnabled": true,
  "cacheMaxSize": 1000,
  "cacheTtlSeconds": 3600,

  "requestTimeoutMs": 300000,

  "autoRotationEnabled": true,
  "autoRotationTriggers": {
    "quotaThreshold": 10,
    "errorCount": 3,
    "requestCount": 0
  },
  "autoRotationCooldownMinutes": 30,

  "modelReasoningEfforts": {
    "gpt-5-mini": "low",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4": "xhigh"
  },

  "extraPrompts": {},

  "useFunctionApplyPatch": true,
  "useMessagesApi": true,

  "webhookEnabled": true,
  "webhookProvider": "discord",
  "webhookUrl": "https://discord.com/api/webhooks/xxx",
  "webhookEvents": {
    "quotaLow": { "enabled": true, "threshold": 10 },
    "accountError": true,
    "rateLimitHit": true,
    "accountRotation": true
  }
}
```

### Environment Variables

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `PORT` | `4141` | Override server port |
| `DEBUG` | `false` | Enable debug mode (`true`/`false`) |
| `WEBUI_PASSWORD` | - | Set WebUI password |
| `GH_TOKEN` | - | GitHub token |
| `HTTP_PROXY` | - | HTTP proxy URL |
| `HTTPS_PROXY` | - | HTTPS proxy URL |
| `CHAT_COMPLETION_TIMEOUT_MS` | `300000` | Request timeout in ms |
| `FALLBACK` | `false` | Enable model fallback (`true`/`false`) |

---

## Multi-Account Pool

Pool system memungkinkan kamu rotasi antara multiple GitHub accounts untuk:
- Hindari rate limiting
- Maximize quota usage
- High availability

### Setup Pool

```bash
# Authenticate account pertama
copilot-api auth

# Start server (account otomatis masuk pool)
copilot-api start

# Tambah account via WebUI atau API
curl -X POST http://localhost:4141/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"token": "ghp_xxx", "label": "backup-account"}'
```

### Selection Strategies

| Strategy | Deskripsi | Kapan Pake |
|----------|-----------|------------|
| `sticky` | Satu account sampai error | Default, simple usage |
| `round-robin` | Rotasi berurutan antar accounts | Load balancing rata |
| `quota-based` | Prioritas account dengan quota tinggi | Maximize quota usage |
| `hybrid` | Sticky + auto-rotate pas error | **Recommended!** Best of both worlds |

### Auto-Rotation Triggers

Pool bisa auto-rotate ke account lain berdasarkan:

| Trigger | Config Key | Deskripsi |
|---------|------------|-----------|
| Quota Threshold | `quotaThreshold` | Rotate kalo quota < threshold |
| Error Count | `errorCount` | Rotate setelah N errors |
| Request Count | `requestCount` | Rotate setelah N requests (0 = disabled) |
| Rate Limit | - | Always rotate on rate limit |

---

## Caching

Request cache menggunakan LRU (Least Recently Used) algorithm dengan O(1) complexity buat get/set/evict.

### Cache Stats

```bash
# Via API
curl http://localhost:4141/api/cache/stats

# Response:
{
  "enabled": true,
  "size": 150,
  "maxSize": 1000,
  "hits": 2500,
  "misses": 500,
  "hitRate": 0.83,
  "savedTokens": 1500000
}
```

### Clear Cache

```bash
curl -X POST http://localhost:4141/api/cache/clear
```

---

## Testing

```bash
# Run all tests
bun test

# Run specific test
bun test tests/specific.test.ts

# Type checking
bun run typecheck

# Linting
bun run lint
```

---

## Development

```bash
# Development mode (hot reload)
bun run dev

# Build
bun run build

# Lint & fix
bun run lint --fix

# Check for unused dependencies
bun run knip
```

### Code Style

- **Imports**: Use `~/*` path alias untuk `src/*` (e.g., `import { foo } from '~/lib/foo'`)
- **Types**: Strict TypeScript, no `any`, explicit types
- **Naming**: camelCase untuk variables/functions, PascalCase untuk types/classes
- **Modules**: ESNext modules only, no CommonJS
- **Errors**: Use custom error classes dari `src/lib/error.ts`
- **Tests**: Place in `tests/`, name as `*.test.ts`

---

## Troubleshooting

### "Copilot token expired"

```bash
# Re-authenticate
copilot-api auth
```

### Rate limit errors

1. Enable multi-account pool
2. Gunakan `hybrid` strategy
3. Enable request queue
4. Kurangi concurrent requests

### Model not found

1. Check available models: `GET /models`
2. Enable `fallbackEnabled: true` di config
3. Pastiin account punya akses ke model tersebut
4. Cek model mapping di config

### Cache issues

```bash
# Clear cache via API
curl -X POST http://localhost:4141/api/cache/clear

# Or delete file manually
rm ~/.config/copilot-api/request-cache.json
```

### Connection issues

1. Check jika ada firewall yang block
2. Pastiin proxy settings benar (kalo pake proxy)
3. Coba dengan `--debug` flag buat lihat detailed logs

---

## Data Storage

Semua data disimpan di home directory:

| Path | Deskripsi |
|------|-----------|
| `~/.config/copilot-api/config.json` | Configuration |
| `~/.config/copilot-api/request-cache.json` | Request cache |
| `~/.local/share/copilot-api/github-token.txt` | GitHub token |
| `~/.local/share/copilot-api/pool-state.json` | Account pool state |
| `~/.local/share/copilot-api/usage-stats.json` | Usage statistics |
| `~/.local/share/copilot-api/request-history.json` | Request history |
| `~/.local/share/copilot-api/cost-data.json` | Cost tracking data |

---

## Contributing

Contributions welcome! Please:

1. Fork repo
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push branch (`git push origin feature/amazing`)
5. Open Pull Request

### Guidelines

- Pastikan semua tests passed
- Follow code style yang ada
- Update dokumentasi kalo perlu
- Add tests buat fitur baru

---

## Contributors

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/prassaaa">
        <img src="https://github.com/prassaaa.png" width="80" height="80" alt="Prasetyo Ari Wibowo" /><br />
        <sub><b>Prasetyo Ari Wibowo</b></sub>
      </a>
    </td>
  </tr>
</table>

---

## Stats

<p align="center">
  <img src="https://img.shields.io/github/stars/prassaaa/copilot-api?style=social" alt="Stars" />
  <img src="https://img.shields.io/github/forks/prassaaa/copilot-api?style=social" alt="Forks" />
  <img src="https://img.shields.io/github/watchers/prassaaa/copilot-api?style=social" alt="Watchers" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/issues/prassaaa/copilot-api?style=flat-square" alt="Issues" />
  <img src="https://img.shields.io/github/issues-pr/prassaaa/copilot-api?style=flat-square" alt="PRs" />
  <img src="https://img.shields.io/github/last-commit/prassaaa/copilot-api?style=flat-square" alt="Last Commit" />
  <img src="https://img.shields.io/github/commit-activity/m/prassaaa/copilot-api?style=flat-square" alt="Commit Activity" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/repo-size/prassaaa/copilot-api?style=flat-square" alt="Repo Size" />
  <img src="https://img.shields.io/github/languages/code-size/prassaaa/copilot-api?style=flat-square" alt="Code Size" />
  <img src="https://img.shields.io/github/languages/top/prassaaa/copilot-api?style=flat-square" alt="Top Language" />
</p>

---

## License

[MIT License](LICENSE) - Copyright (c) 2025 Prasetyo Ari Wibowo

---

<p align="center">
  Made with love di Indonesia
</p>
