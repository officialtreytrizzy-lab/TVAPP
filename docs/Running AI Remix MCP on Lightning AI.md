# Running AI Remix MCP on Lightning AI

This document explains how to run the TVAPP Lightning AI Remix MCP control server from a Lightning AI GPU Studio.

The MCP server is for operator control from ChatGPT/agent clients. It is not the product video API. TrizzyCut should use the FastAPI AI Remix worker on port `8000` for real multipart video upload, job polling, logs, and output downloads.

## What this gives us

The MCP server exposes allowlisted tools so a connected AI client can inspect and operate the Lightning GPU AI Remix worker:

- `check_lightning_runtime`
- `check_gpu`
- `check_wan`
- `get_worker_health`
- `start_worker`
- `stop_worker`
- `restart_worker`
- `start_tiny_smoke_remix`
- `get_job_status`
- `tail_job_log`
- `get_output_path`
- `list_recent_jobs`
- `cancel_job`

The MCP server does **not** expose arbitrary shell execution.

## Required environment

Run these from the Lightning AI GPU Studio terminal:

```bash
cd /teamspace/studios/this_studio/TVAPP/gpu-worker
python -m venv .venv
source .venv/bin/activate
python -m pip install -U pip wheel setuptools
pip install -r requirements.txt
```

Then configure the Lightning paths:

```bash
export WAN_ROOT="/teamspace/studios/this_studio/Wan2.1"
export WAN_CKPT_DIR="/teamspace/studios/this_studio/models/Wan2.1-VACE-1.3B"
export AI_REMIX_WORK_DIR="/teamspace/studios/this_studio/runtime/ai-remix-jobs"

export AI_REMIX_PROVIDER="lightning-gpu"
export AI_REMIX_GPU_ENABLED="true"
export AI_REMIX_ALLOW_MODAL="false"

export AI_REMIX_SIZE="512*288"
export AI_REMIX_FRAME_NUM="17"
export AI_REMIX_SAMPLE_STEPS="8"
export AI_REMIX_MAX_SECONDS="2"
export AI_REMIX_MAX_UPLOAD_MB="50"

export AI_REMIX_PIPELINE_CMD="python /teamspace/studios/this_studio/TVAPP/gpu-worker/pipelines/wan_vace_remix.py"
```

Create a long secret token. Do not commit this token.

```bash
export LIGHTNING_MCP_TOKEN="replace-this-with-a-long-random-secret"
```

## Start the MCP server

From `TVAPP/gpu-worker`:

```bash
source .venv/bin/activate
uvicorn lightning_ai_remix_mcp:app --host 0.0.0.0 --port 8765
```

Or:

```bash
python lightning_ai_remix_mcp.py
```

Expose/open port `8765` in Lightning AI only when you are ready to connect a client. Keep the token private.

## Test the MCP server locally

Health does not require the token:

```bash
curl -s http://127.0.0.1:8765/health | python -m json.tool
```

List tools with the token:

```bash
curl -s http://127.0.0.1:8765/mcp/tools \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" | python -m json.tool
```

Initialize over JSON-RPC:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"local-curl","version":"0.0.1"},"capabilities":{}}}' \
  | python -m json.tool
```

List MCP tools:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | python -m json.tool
```

Check GPU:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_gpu","arguments":{}}}' \
  | python -m json.tool
```

Check Wan:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"check_wan","arguments":{}}}' \
  | python -m json.tool
```

Start the local FastAPI AI Remix worker from MCP:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"start_worker","arguments":{"port":8000}}}' \
  | python -m json.tool
```

Run a tiny one-second AI Remix smoke job:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"start_tiny_smoke_remix","arguments":{"prompt":"Make it a neon R&B music video"}}}' \
  | python -m json.tool
```

Copy the returned `jobId` / `job_id`, then poll status:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_job_status","arguments":{"job_id":"remix_REPLACE_ME"}}}' \
  | python -m json.tool
```

Tail logs:

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $LIGHTNING_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"tail_job_log","arguments":{"job_id":"remix_REPLACE_ME","lines":120}}}' \
  | python -m json.tool
```

## Connect from an MCP-capable client

Use the Lightning public URL for port `8765` as the remote MCP endpoint:

```text
https://YOUR-LIGHTNING-PORT-8765-URL/mcp
```

Add this header in the client configuration:

```text
Authorization: Bearer YOUR_LIGHTNING_MCP_TOKEN
```

If the client supports custom headers, prefer the `Authorization` header. The server also accepts `X-Lightning-MCP-Token` or `?token=` for emergency testing, but header auth is cleaner.

## Security rules

Do not expose this MCP publicly without a secret token.

The MCP server can start GPU jobs, inspect files under `AI_REMIX_WORK_DIR`, and read logs. That is powerful enough to waste GPU time or expose project runtime details if shared carelessly.

Safe defaults in this implementation:

- token required for `/mcp` and `/mcp/tools`
- no arbitrary shell tool
- no arbitrary file reads
- job IDs are validated
- job paths are constrained under `AI_REMIX_WORK_DIR`
- worker process control uses a pid file managed by this server
- Modal is not used

## Product API remains FastAPI

TrizzyCut should still point to the FastAPI worker, not the MCP endpoint:

```text
VITE_AI_REMIX_PROVIDER=lightning-gpu
VITE_AI_REMIX_GPU_ENABLED=true
VITE_AI_REMIX_LIGHTNING_GPU_WORKER_URL=https://YOUR-LIGHTNING-PORT-8000-URL
VITE_AI_REMIX_ALLOW_MODAL=false
```

MCP is for this chat / agents to control the Lightning AI worker. FastAPI is for TrizzyCut users to upload clips and receive output videos.
