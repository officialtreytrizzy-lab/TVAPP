# Trizzy Audio ACE Modal Worker

Production ACE-Step 1.5 worker for Trizzy Canvas.

- `turbo_api`: fast previews and normal generation.
- `base_api`: higher-quality/final/editing workloads.
- The public gateway requires a valid Supabase bearer token for generation,
  polling, models, formatting, and audio download.
- ACE-Step itself listens only on localhost inside the Modal container.
- Reference audio URLs are downloaded by the gateway after public-HTTPS/SSRF checks.

The deployed API follows ACE-Step's native asynchronous contract:

1. `POST /release_task`
2. `POST /query_result`
3. `GET /v1/audio?path=...`

The deployment workflow uses the same official Modal workspace credentials as
the existing TVAPP GPU worker and never commits Modal tokens.
