"""ChatGPT-compatible MCP server for Lightning AI Remix operator tools.

This server uses the official Python MCP SDK instead of the local JSON-RPC
compatibility shim in lightning_ai_remix_mcp.py. It intentionally exposes only
safe, allowlisted operator tools and keeps large video upload/download traffic on
FastAPI port 8000.

Default transport is Streamable HTTP on /mcp because that is the current MCP SDK
HTTP transport. SSE is also supported by starting with --transport sse, which
serves /sse and /messages/ on the same port.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# Make this file runnable from either the repo root or gpu-worker directory.
THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

import lightning_ai_remix_mcp as core  # noqa: E402

TransportName = Literal["sse", "streamable-http"]
DEFAULT_HOST = os.environ.get("CHATGPT_MCP_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.environ.get("CHATGPT_MCP_PORT", "8766"))
DEFAULT_TRANSPORT: TransportName = os.environ.get("CHATGPT_MCP_TRANSPORT", "streamable-http")  # type: ignore[assignment]

# ChatGPT reaches this server through a public tunnel with a dynamic Host header
# such as *.trycloudflare.com. Disable DNS-rebinding checks for this dedicated
# operator endpoint; keep the server unauthenticated only when exposed through a
# private/unlisted tunnel URL as documented below.
PUBLIC_TUNNEL_SECURITY = TransportSecuritySettings(enable_dns_rebinding_protection=False)

mcp = FastMCP(
    "tvapp-lightning-ai-remix-chatgpt",
    instructions=(
        "Safe operator MCP for TVAPP AI Remix on Lightning AI. "
        "Use these tools only for runtime inspection, starting/stopping the local "
        "FastAPI worker, tiny smoke jobs, job status, logs, outputs, recent jobs, "
        "and cancellation markers. Large video upload remains on FastAPI port 8000."
    ),
    host=DEFAULT_HOST,
    port=DEFAULT_PORT,
    sse_path="/sse",
    message_path="/messages/",
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=False,
    transport_security=PUBLIC_TUNNEL_SECURITY,
)


def _tool_payload(value: dict[str, Any]) -> dict[str, Any]:
    """Return plain structured dicts so ChatGPT can render tool results."""
    return value


@mcp.tool(description="Inspect Lightning runtime, env, paths, and token/configuration status.")
def check_lightning_runtime() -> dict[str, Any]:
    return _tool_payload(core.check_lightning_runtime())


@mcp.tool(description="Run nvidia-smi and torch CUDA checks on the Lightning Studio.")
def check_gpu() -> dict[str, Any]:
    return _tool_payload(core.check_gpu())


@mcp.tool(description="Check Wan root, generate.py, and checkpoint directory on Lightning storage.")
def check_wan() -> dict[str, Any]:
    return _tool_payload(core.check_wan())


@mcp.tool(description="Read the local FastAPI AI Remix worker /health endpoint.")
def get_worker_health() -> dict[str, Any]:
    return _tool_payload(core.get_worker_health())


@mcp.tool(description="Start the local FastAPI AI Remix worker with uvicorn on the requested port.")
def start_worker(port: int = core.DEFAULT_WORKER_PORT) -> dict[str, Any]:
    return _tool_payload(core.start_worker(port=port))


@mcp.tool(description="Stop the uvicorn worker started by the MCP server.")
def stop_worker() -> dict[str, Any]:
    return _tool_payload(core.stop_worker())


@mcp.tool(description="Restart the local FastAPI AI Remix worker.")
def restart_worker(port: int = core.DEFAULT_WORKER_PORT) -> dict[str, Any]:
    return _tool_payload(core.restart_worker(port=port))


@mcp.tool(description="Create a tiny MP4 and submit it to the local FastAPI AI Remix worker.")
def start_tiny_smoke_remix(prompt: str = "Make it a neon R&B music video") -> dict[str, Any]:
    return _tool_payload(core.start_tiny_smoke_remix(prompt=prompt))


@mcp.tool(description="Get AI Remix job status by ID from the worker, falling back to local status.json.")
def get_job_status(job_id: str) -> dict[str, Any]:
    return _tool_payload(core.get_job_status(job_id=job_id))


@mcp.tool(description="Read the tail of a Wan/AI Remix job log by ID.")
def tail_job_log(job_id: str, lines: int = 80) -> dict[str, Any]:
    return _tool_payload(core.tail_job_log(job_id=job_id, lines=lines))


@mcp.tool(description="Return safe local output path and worker download URL for a completed job.")
def get_output_path(job_id: str) -> dict[str, Any]:
    return _tool_payload(core.get_output_path(job_id=job_id))


@mcp.tool(description="List recent AI Remix jobs under AI_REMIX_WORK_DIR.")
def list_recent_jobs(limit: int = 10) -> dict[str, Any]:
    return _tool_payload(core.list_recent_jobs(limit=limit))


@mcp.tool(description="Write a cancellation marker for an AI Remix job.")
def cancel_job(job_id: str) -> dict[str, Any]:
    return _tool_payload(core.cancel_job(job_id=job_id))


def endpoint_for(transport: TransportName, public_base_url: str | None = None) -> str:
    path = "/sse" if transport == "sse" else "/mcp"
    if public_base_url:
        return public_base_url.rstrip("/") + path
    host_for_display = "127.0.0.1" if DEFAULT_HOST == "0.0.0.0" else DEFAULT_HOST
    return f"http://{host_for_display}:{DEFAULT_PORT}{path}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run ChatGPT-compatible TVAPP Lightning AI Remix MCP server.")
    parser.add_argument("--transport", choices=["streamable-http", "sse"], default=DEFAULT_TRANSPORT)
    parser.add_argument("--public-base-url", default=os.environ.get("CHATGPT_MCP_PUBLIC_BASE_URL", ""), help="Optional public tunnel base URL used only for printed instructions.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    transport: TransportName = args.transport
    print("TVAPP Lightning AI Remix ChatGPT MCP server", flush=True)
    print(f"transport={transport}", flush=True)
    print(f"listen=http://{DEFAULT_HOST}:{DEFAULT_PORT}", flush=True)
    print(f"local_endpoint={endpoint_for(transport)}", flush=True)
    if args.public_base_url:
        print(f"chatgpt_server_url={endpoint_for(transport, args.public_base_url)}", flush=True)
    else:
        print("chatgpt_server_url=<cloudflared https URL>" + ("/sse" if transport == "sse" else "/mcp"), flush=True)
    print("auth=No Auth (use an unlisted/private tunnel URL; no arbitrary shell/file tools are exposed)", flush=True)
    mcp.run(transport=transport)


if __name__ == "__main__":
    main()
