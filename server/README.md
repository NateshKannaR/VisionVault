# VisionVault planner

The FastAPI service turns browser context into structured action suggestions. One dispatch path serves standard JSON, the legacy route, and server-sent events.

## Run locally

Install dependencies with Python 3.12, copy `.env.example` to `.env`, and run `npm run server` from the repository root. The process binds to `127.0.0.1:8000`. The example leaves all model providers disabled, which selects deterministic rules.

| Variable | Purpose |
| --- | --- |
| `VISIONVAULT_API_TOKEN` | Bearer token of at least 32 characters. Without a token, the API accepts only loopback clients |
| `VISIONVAULT_ALLOWED_ORIGINS` | Optional comma-separated CORS origins for browser integrations, with exact schemes and hosts |
| `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT` | Enable or configure self-hosted model inference. An explicitly empty host skips discovery |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Enable OpenRouter and select its model |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Enable Gemini and select its model |

Process environment values take precedence over `.env`. Provider keys belong on the server. The extension uses only the planner token.

## Run in Docker

Generate a token and set it in your current shell before starting Compose:

```sh
export VISIONVAULT_API_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
docker compose up --build -d
curl -fsS http://127.0.0.1:8000/livez
curl -fsS -H "Authorization: Bearer $VISIONVAULT_API_TOKEN" http://127.0.0.1:8000/health
```

Use the same token in the extension under **Settings → Planner token**. Compose publishes the API to the host loopback only, runs it as an unprivileged user, and checks liveness.

To enable the optional Ollama container, set `OLLAMA_HOST=http://ollama:11434`, start Compose with `--profile ollama`, and install a model with `docker compose exec ollama ollama pull qwen2.5:3b-instruct`. A local model requires enough RAM or accelerator capacity for the selected weights.

For remote deployments, terminate TLS at the reverse proxy, keep the planner port internal, and configure the extension with the HTTPS service URL and token. Configure corresponding request size, rate, and timeout limits at the proxy. Keep proxy buffering disabled for the SSE route and monitor provider cooldowns and HTTP failures. Settings and upstream capacity should be validated in the target environment before opening the service to users.

## HTTP API

| Method and path | Response |
| --- | --- |
| `GET /livez` | Unauthenticated process liveness |
| `GET /health` | Authenticated provider order, models, and cooldowns |
| `POST /api/agent/plan` | Decomposes a task into short milestones |
| `POST /api/agent/step` | One suggested action as JSON |
| `POST /api/agent/step/stream` | An SSE action result followed by `[DONE]` |
| `POST /plan-action` | Compatibility route for JSON action planning |

Example request with the rules backend:

```sh
curl -fsS http://127.0.0.1:8000/api/agent/step \
  -H "Authorization: Bearer $VISIONVAULT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"task":"search for optics","marks":[{"id":2,"role":"input:search","label":"search"}],"privacy_budget":{"level":0}}'
```

Planner requests are bounded to 12 MiB. A zero-pixel request carrying either image field is rejected. Direct users of the API are responsible for masking their input. The server can validate the request shape and declared budget, and the client performs detection and masking.

Run `python eval/test-planner-http.py` and `python eval/test-fallback-chain.py` for isolated verification. See the [project README](../README.md) for the rest of the verification matrix.
