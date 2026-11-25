# Tomodachi

Tomodachi is a responsive AI chat app with SQLite-backed session history and a LiteLLM gateway for provider key failover and response caching. The browser stores a session ID and optional system prompt; conversation history is fetched from SQLite. Provider and gateway keys stay on the server.

## Run locally

1. Install Docker with Compose and Node.js 20 or newer.
2. Copy `.env.example` to `.env`. Set `LITELLM_MASTER_KEY` and `LITELLM_API_KEY` to the same long random value, then provide at least two valid provider keys in `OPENAI_API_KEYS`, separated by commas.
3. Run `make up` and open [http://localhost:3000](http://localhost:3000). The API backend is available at [http://localhost:8000](http://localhost:8000).

The Compose setup starts the frontend, Node API, and LiteLLM services. SQLite is mounted on the named `tomodachi-data` volume at `/data`, using `/data/app.db`. Use `make down` to stop the stack. The Node service exposes only `GET /health`, `POST /chat`, and `GET /sessions/{session_id}/messages`; unknown paths return JSON 404s. For running Node outside Compose, start LiteLLM separately and run `npm start`; the Node start command loads `.env`. Never add real secrets to source control.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port for running the Node backend directly | `8000` |
| `FRONTEND_PORT` | Host port for the frontend container | `3000` |
| `BACKEND_PORT` | Host and container port for the backend | `8000` |
| `LITELLM_PORT` | LiteLLM gateway port | `4000` |
| `LITELLM_BASE_URL` | LiteLLM OpenAI-compatible API URL | `http://127.0.0.1:4000/v1` |
| `LITELLM_API_KEY` | Server-to-gateway credential | — |
| `LITELLM_MODEL` | LiteLLM model alias | `tomodachi` |
| `LITELLM_TIMEOUT_MS` | Maximum gateway request time before returning a retryable error | `45000` |
| `LITELLM_MASTER_KEY` | LiteLLM proxy master key | — |
| `OPENAI_API_KEYS` | Comma-separated LiteLLM provider key pool (minimum two) | — |
| `LITELLM_PROVIDER_MODEL` | Provider model ID used by each pool key | `openai/gpt-4o-mini` |
| `ENABLE_FAILURE_SIMULATION` | Enables the request-scoped failover demonstration header | `false` |

Tomodachi calls LiteLLM's OpenAI-compatible `/chat/completions` endpoint. [`litellm_entrypoint.py`](./litellm_entrypoint.py) reads `OPENAI_API_KEYS` in order, rejects pools with fewer than two keys, and generates one LiteLLM deployment per key with IDs `key_1`, `key_2`, and so on. The first deployment is exposed as `tomodachi`, with later deployments named `tomodachi-key_2`, `tomodachi-key_3`, and so forth. The backend calls these model aliases in order and counts each failure before the successful response; LiteLLM's per-call retries are disabled so each attempt maps to exactly one key. LiteLLM's built-in local cache is enabled. Set `LITELLM_PROVIDER_MODEL` to a supported LiteLLM model identifier. The cache is in-memory and clears when LiteLLM restarts.

The backend exposes exactly three API routes: `GET /health`, `POST /chat`, and `GET /sessions/{session_id}/messages`. The chat client generates the session ID; posting to an unknown ID starts that session. It sends only the new message and optional `system_prompt`. Responses use `session_id`, `reply`, and a `metadata` object containing `resolution_source`, `model`, `latency_ms`, `input_tokens`, `output_tokens`, `key_id`, and `fallback_attempts`. Validation errors are JSON with a `detail` field and status 422; provider exhaustion returns 503 with `{"detail":"all providers unavailable"}`. A failed turn is not inserted into history.

The browser generates a new session ID on every page load. Its UI provides the required `chat-input`, `send-button`, `assistant-message`, `meta-source`, `meta-model`, `meta-latency`, `meta-input-tokens`, and `meta-output-tokens` test IDs, plus the optional `system-prompt-input`. Request errors are displayed inline in the conversation while the input stays cleared after submission.

Session history is stored in SQLite by the Node backend, not in the request from the browser. The `messages` table records each user/assistant message, assistant metadata as JSON, and an ISO-8601 server timestamp. A `sessions` table stores session system prompts and timestamps. Schema and indexes are created on startup. `DATABASE_URL` can be a file path (for example `/data/app.db`), a `file:` URL, or `:memory:` for tests. History is returned oldest-first without the system prompt. The browser stores only the session ID and optional system prompt, and restores messages through the backend.

LiteLLM caching uses the model alias and complete message list. Cache hits are identified from `x-litellm-cache-key`; their original token usage is preserved, `key_id` is null, and `fallback_attempts` is zero. Live usage is per request, never accumulated. The gateway's `x-litellm-model-id`, `x-litellm-model-name`, and `x-litellm-attempted-fallbacks` headers provide the responding key ID, provider model, and fallback count. `GET /health` verifies SQLite and the LiteLLM model/key pool, and returns `status`, `keys_configured`, and `cache_enabled`.

When `ENABLE_FAILURE_SIMULATION=true`, `POST /chat` accepts `X-Simulate-Failure` values such as `key_1=429`, `key_1=429,key_2=500`, or `*=429`. Only key IDs and status codes 429, 500, 502, and 503 are accepted. Simulated failures apply to that request only and exercise the same ordered fallback path as a provider error; failed turns are not stored. The Render Blueprint enables this test hook; set it to `false` outside environments where demonstration is needed.

## Deploy on Render

The [`render.yaml`](./render.yaml) Blueprint defines a public static frontend, a Node backend with a persistent Render disk mounted at `/data`, and a LiteLLM gateway. It sets `DATABASE_URL=/data/app.db`; the static build writes the backend URL into `config.js`, and the backend allows the configured frontend origin. Set `OPENAI_API_KEYS` on the gateway (at least two comma-separated keys), `LITELLM_MASTER_KEY` on the gateway, and the matching `LITELLM_API_KEY` on the backend. Review and update `FRONTEND_ORIGIN` if the frontend's assigned Render hostname differs from `tomodachi-frontend.onrender.com` or a custom domain is used. The backend health check is `/health`.

## Verify

Run `npm test` to check SQLite-backed session history, persistence across backend restarts, gateway metadata/cache handling, simulated key failover, error recovery, and request validation. Run `BACKEND_URL=https://your-backend.example npm run build:frontend` (or set `$env:BACKEND_URL` in PowerShell) to build the separately hosted frontend.
