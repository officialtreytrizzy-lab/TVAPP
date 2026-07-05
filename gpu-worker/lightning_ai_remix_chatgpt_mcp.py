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
import shutil
import subprocess
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
LIGHTNING_ROOT = Path("/teamspace/studios/this_studio")
TVAPP_ROOT = LIGHTNING_ROOT / "TVAPP"
GPU_WORKER_ROOT = TVAPP_ROOT / "gpu-worker"
WAN_ROOT = LIGHTNING_ROOT / "Wan2.1"
WAN_CKPT_DIR = LIGHTNING_ROOT / "models" / "Wan2.1-VACE-1.3B"
AI_REMIX_WORK_DIR = LIGHTNING_ROOT / "runtime" / "ai-remix-jobs"
WAN_REQUIREMENTS = WAN_ROOT / "requirements.txt"
GPU_WORKER_REQUIREMENTS = GPU_WORKER_ROOT / "requirements.txt"
WAN_PIPELINE = GPU_WORKER_ROOT / "pipelines" / "wan_vace_remix.py"

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


def _run_allowlisted(command: list[str], timeout: int = 900, cwd: Path | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    safe_env = os.environ.copy()
    if env:
        safe_env.update(env)
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            env=safe_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = completed.stdout or ""
        return {
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            "command": command,
            "cwd": str(cwd) if cwd else None,
            "output_tail": output[-12000:],
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "returncode": None,
            "command": command,
            "cwd": str(cwd) if cwd else None,
            "output_tail": f"Timed out after {timeout}s. {exc}",
        }
    except FileNotFoundError as exc:
        return {
            "ok": False,
            "returncode": None,
            "command": command,
            "cwd": str(cwd) if cwd else None,
            "output_tail": f"Executable not found: {exc}",
        }


def _dir_size_bytes(root: Path) -> int:
    total = 0
    if not root.exists():
        return 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except Exception:
            continue
    return total


def _first_entries(root: Path, limit: int = 50) -> list[str]:
    if not root.exists():
        return []
    entries: list[str] = []
    for path in sorted(root.rglob("*")):
        try:
            entries.append(str(path.relative_to(root)))
        except Exception:
            entries.append(path.name)
        if len(entries) >= limit:
            break
    return entries


def _requires_hf_login(output: str) -> bool:
    lowered = output.lower()
    return any(
        marker in lowered
        for marker in (
            "401",
            "403",
            "unauthorized",
            "forbidden",
            "gated",
            "authentication",
            "access token",
            "login",
        )
    )


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


@mcp.tool(description="Check Hugging Face CLI, hf_transfer package, and whether HF_TOKEN is configured without revealing secrets.")
def check_hf_cli() -> dict[str, Any]:
    hf_transfer = _run_allowlisted(["python", "-c", "import hf_transfer; print('hf_transfer ok')"], timeout=30)
    has_token = bool(os.environ.get("HF_TOKEN", "").strip())
    huggingface_cli = shutil.which("huggingface-cli")
    return _tool_payload({
        "ok": True,
        "huggingface_cli_installed": bool(huggingface_cli),
        "huggingface_cli_path": huggingface_cli,
        "hf_transfer_installed": bool(hf_transfer.get("ok")),
        "hf_transfer_check": hf_transfer,
        "hf_token_configured": has_token,
        "likely_ready": bool(huggingface_cli) and bool(hf_transfer.get("ok")) and has_token,
        "note": "HF_TOKEN value is intentionally never returned. If missing, set HF_TOKEN in the Lightning environment or run huggingface-cli login in the Lightning terminal.",
    })


@mcp.tool(description="Install only allowlisted Python dependencies required for Wan setup.")
def install_wan_python_deps() -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    for command in (
        ["python", "-m", "pip", "install", "-U", "pip", "wheel", "setuptools"],
        ["python", "-m", "pip", "install", "-U", "huggingface_hub[cli]", "hf_transfer"],
    ):
        result = _run_allowlisted(command, timeout=900, cwd=TVAPP_ROOT if TVAPP_ROOT.exists() else None)
        steps.append(result)
        if not result.get("ok"):
            return _tool_payload({"ok": False, "failed_step": command, "steps": steps})

    if GPU_WORKER_REQUIREMENTS.exists():
        command = ["python", "-m", "pip", "install", "-r", str(GPU_WORKER_REQUIREMENTS)]
        result = _run_allowlisted(command, timeout=1800, cwd=TVAPP_ROOT)
        steps.append(result)
        if not result.get("ok"):
            return _tool_payload({"ok": False, "failed_step": command, "steps": steps})
    else:
        steps.append({"ok": True, "skipped": True, "reason": f"{GPU_WORKER_REQUIREMENTS} does not exist"})
    return _tool_payload({"ok": True, "steps": steps})


@mcp.tool(description="Clone or fast-forward update the allowlisted Wan2.1 repository path.")
def install_wan_code() -> dict[str, Any]:
    WAN_ROOT.parent.mkdir(parents=True, exist_ok=True)
    if WAN_ROOT.exists():
        command = ["git", "-C", str(WAN_ROOT), "pull", "--ff-only"]
    else:
        command = ["git", "clone", "https://github.com/Wan-Video/Wan2.1.git", str(WAN_ROOT)]
    result = _run_allowlisted(command, timeout=1800, cwd=LIGHTNING_ROOT if LIGHTNING_ROOT.exists() else None)
    generate_py = WAN_ROOT / "generate.py"
    return _tool_payload({
        "ok": bool(result.get("ok")) and generate_py.exists(),
        "command_result": result,
        "wan_root": str(WAN_ROOT),
        "wan_root_exists": WAN_ROOT.exists(),
        "generate_py": str(generate_py),
        "generate_py_exists": generate_py.exists(),
    })


@mcp.tool(description="Install Wan2.1 requirements from the fixed allowlisted requirements path if present.")
def install_wan_requirements() -> dict[str, Any]:
    if not WAN_REQUIREMENTS.exists():
        return _tool_payload({"ok": False, "error": "Wan requirements.txt does not exist", "path": str(WAN_REQUIREMENTS)})
    command = ["python", "-m", "pip", "install", "-r", str(WAN_REQUIREMENTS)]
    result = _run_allowlisted(command, timeout=3600, cwd=WAN_ROOT)
    return _tool_payload({"ok": bool(result.get("ok")), "requirements": str(WAN_REQUIREMENTS), "result": result})


@mcp.tool(description="Download Wan2.1 VACE checkpoint to the fixed Lightning model directory using Hugging Face CLI.")
def download_wan_vace_checkpoint() -> dict[str, Any]:
    WAN_CKPT_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        "huggingface-cli",
        "download",
        "Wan-AI/Wan2.1-VACE-1.3B",
        "--local-dir",
        str(WAN_CKPT_DIR),
    ]
    env = {"HF_HUB_ENABLE_HF_TRANSFER": "1"}
    result = _run_allowlisted(command, timeout=7200, cwd=LIGHTNING_ROOT if LIGHTNING_ROOT.exists() else None, env=env)
    output_tail = str(result.get("output_tail") or "")
    if not result.get("ok") and _requires_hf_login(output_tail):
        return _tool_payload({
            "ok": False,
            "requires_hf_login": True,
            "error": "Hugging Face authentication or model access is required.",
            "instructions": "Set HF_TOKEN in the Lightning environment or run `huggingface-cli login` inside the Lightning terminal. Do not paste Hugging Face tokens into chat.",
            "result": result,
        })
    return _tool_payload({
        "ok": bool(result.get("ok")) and WAN_CKPT_DIR.exists(),
        "requires_hf_login": False,
        "model_dir": str(WAN_CKPT_DIR),
        "model_dir_exists": WAN_CKPT_DIR.exists(),
        "size_bytes": _dir_size_bytes(WAN_CKPT_DIR),
        "first_50_entries": _first_entries(WAN_CKPT_DIR, limit=50),
        "result": result,
    })


@mcp.tool(description="Run the fixed safe Wan2.1 bootstrap sequence and stop on the first failed step.")
def bootstrap_wan_2_1() -> dict[str, Any]:
    sequence = [
        ("check_hf_cli", check_hf_cli),
        ("install_wan_python_deps", install_wan_python_deps),
        ("install_wan_code", install_wan_code),
        ("install_wan_requirements", install_wan_requirements),
        ("download_wan_vace_checkpoint", download_wan_vace_checkpoint),
        ("check_wan", check_wan),
    ]
    results: dict[str, Any] = {}
    for name, func in sequence:
        result = func()
        results[name] = result
        if name == "check_hf_cli" and not result.get("hf_token_configured"):
            return _tool_payload({
                "ok": False,
                "failed_step": name,
                "requires_hf_login": True,
                "instructions": "Set HF_TOKEN in the Lightning environment or run `huggingface-cli login` inside the Lightning terminal. Do not paste Hugging Face tokens into chat.",
                "results": results,
            })
        if not result.get("ok"):
            return _tool_payload({"ok": False, "failed_step": name, "results": results})
    return _tool_payload({"ok": True, "results": results})


@mcp.tool(description="Start the local AI Remix FastAPI worker on port 8000 with Lightning GPU environment.")
def start_ai_remix_worker() -> dict[str, Any]:
    os.environ.update({
        "WAN_ROOT": str(WAN_ROOT),
        "WAN_CKPT_DIR": str(WAN_CKPT_DIR),
        "AI_REMIX_WORK_DIR": str(AI_REMIX_WORK_DIR),
        "AI_REMIX_PROVIDER": "lightning-gpu",
        "AI_REMIX_GPU_ENABLED": "true",
        "AI_REMIX_ALLOW_MODAL": "false",
        "AI_REMIX_SIZE": "512*288",
        "AI_REMIX_MAX_SECONDS": "2",
        "AI_REMIX_MAX_UPLOAD_MB": "50",
        "AI_REMIX_PIPELINE_CMD": f"python {WAN_PIPELINE}",
    })
    started = core.start_worker(port=8000)
    health = core.get_worker_health()
    return _tool_payload({"ok": bool(started.get("ok")) and bool(health.get("ok")), "start": started, "health": health})


@mcp.tool(description="Return a single readiness report for GPU, Wan, and local FastAPI worker health.")
def full_ai_remix_readiness() -> dict[str, Any]:
    runtime = core.check_lightning_runtime()
    gpu = core.check_gpu()
    wan = core.check_wan()
    worker = core.get_worker_health()
    gpu_ready = bool(gpu.get("ok"))
    wan_ready = bool(wan.get("ok"))
    worker_ready = bool(worker.get("ok"))
    return _tool_payload({
        "ok": gpu_ready and wan_ready and worker_ready,
        "gpu_ready": gpu_ready,
        "wan_ready": wan_ready,
        "worker_ready": worker_ready,
        "ready_for_smoke_test": gpu_ready and wan_ready and worker_ready,
        "runtime": runtime,
        "gpu": gpu,
        "wan": wan,
        "worker": worker,
    })


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
