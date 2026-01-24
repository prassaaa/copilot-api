# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Copilot API is a reverse-engineered proxy server that transforms the GitHub Copilot API into OpenAI-compatible and Anthropic-compatible endpoints. It enables using GitHub Copilot with tools that support the OpenAI Chat Completions API or Anthropic Messages API.

**Runtime**: Bun >= 1.2.x

## Commands

```bash
# Development
bun run dev              # Dev mode with hot reload
bun run start            # Production mode

# Build & Quality
bun run build            # Build with tsdown
bun run lint             # Lint with ESLint (cached)
bun run typecheck        # TypeScript type checking

# Testing
bun test                           # Run all tests
bun test tests/specific.test.ts    # Run single test file

# Other
bun run auth             # Authenticate with GitHub
bun run check-usage      # Check Copilot quota
bun run debug            # Display debug info
```

## Architecture

### Request Pipeline

```
Client Request → Hono Server → Middleware (CORS, Auth, Logging)
    → Cache Check → Queue → Rate Limit → Account Pool Selection
    → Copilot API → Response Transform (OpenAI/Anthropic format) → Client
```

### Key Components

| Component | Location | Description |
|-----------|----------|-------------|
| CLI Entry | `src/main.ts` | Citty command definitions |
| Server | `src/server.ts` | Hono app with middleware |
| Startup | `src/start.ts` | Server orchestration, token refresh |
| Account Pool | `src/lib/account-pool.ts` | Multi-account rotation (4 strategies) |
| Token Mgmt | `src/lib/token.ts` | GitHub & Copilot token handling |
| Config | `src/lib/config.ts` | File-based config with env overrides |
| State | `src/lib/state.ts` | Centralized runtime state |

### Routes

- `src/routes/chat-completions/` - OpenAI `/v1/chat/completions`
- `src/routes/messages/` - Anthropic `/v1/messages`
- `src/routes/embeddings/` - OpenAI `/v1/embeddings`
- `src/routes/models/` - Model listing
- `src/webui/` - WebUI dashboard API

### Services

- `src/services/copilot/` - GitHub Copilot API client
- `src/services/github/` - GitHub OAuth & user API

### Data Storage

All data stored in user home directory:
- `~/.config/copilot-api/config.json` - Configuration
- `~/.local/share/copilot-api/` - Tokens, account pool, cache, history

## Code Style

- **Imports**: Use `~/*` path alias for `src/*` (e.g., `import { foo } from '~/lib/foo'`)
- **Types**: Strict TypeScript, no `any`, explicit types
- **Naming**: camelCase for variables/functions, PascalCase for types/classes
- **Modules**: ESNext modules only, no CommonJS
- **Errors**: Use custom error classes from `src/lib/error.ts`
- **Unused**: Unused imports/variables are errors
- **Tests**: Place in `tests/`, name as `*.test.ts`

## Key Patterns

### Adding a New Route

1. Create handler in `src/routes/your-route/`
2. Register in `src/server.ts`
3. Follow existing patterns for request validation (Zod) and response formatting

### Account Pool Strategies

- `sticky` - Same account until error
- `round-robin` - Sequential rotation
- `quota-based` - Select by remaining quota
- `hybrid` - Sticky with auto-rotation on errors

### Configuration

Config loaded from file with environment variable overrides. Key env vars:
- `PORT`, `DEBUG`, `WEBUI_PASSWORD`, `GH_TOKEN`
- `HTTP_PROXY`, `HTTPS_PROXY` (with `--proxy-env` flag)
