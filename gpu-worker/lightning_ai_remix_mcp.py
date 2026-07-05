"""Remote MCP control server for Lightning AI Remix GPU testing.

This server is intentionally an operator/control surface, not the product video
upload API. TrizzyCut should continue to use gpu-worker/main.py over FastAPI for
large video uploads/downloads. This MCP endpoint exposes small, allowlisted tools
for ChatGPT/agent clients to inspect and operate a Lightning AI GPU worker.

Run from the gpu-worker directory or repo root:

    export LIGHTNING_MCP_TOKEN="replace-with-a-long-secret"
    uvicorn lightning_ai_remix_mcp:app --host 0.0.0.0 --port 8765

The implementation speaks a small JSON-RPC MCP-compatible subset over HTTP:
- initialize
- notifications/initialized
- ping
- tools/list
- tools/call

It deliberately does not expose arbitrary shell execution.
"""

from __future__ import annotations

import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

APP_VERSION = "0.1.0"
MCP_PROTOCOL_VERSION = "2024-11-05"
DEFAULT_WORKER_PORT = int(os.environ.get("AI_REMIX_WORKER_PORT", "8000"))
DEFAULT_WORKER_BASE_URL = os.environ.get("AI_REMIX_WORKER_BASE_URL", f"http://127.0.0.1:{DEFAULT_WORKER_PORT}").rstrip("/")
WAN_ROOT = Path(os.environ.get("WAN_ROOT", "/teamspace/studios/this_studio/Wan2.1"))
WAN_CKPT_DIR = Path(os.environ.get("WAN_CKPT_DIR", "/teamspace/studios/this_studio/models/Wan2.1-VACE-1.3B"))
AI_REMIX_WORK_DIR = Path(os.environ.get("AI_REMIX_WORK_DIR", "/teamspace/studios/this_studio/runtime/ai-remix-jobs"))
TOKEN_ENV = "LIGHTNING_MCP_TOKEN"
PID_FILE = AI_REMIX_WORK_DIR / "lightning_worker.pid"
WORKER_BASE_FILE = AI_REMIX_WORK_DIR / "lightning_worker_base_url.txt"
MCP_LOG_FILE = AI_REMIX_WORK_DIR / "lightning_mcp.log"
JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,96}$")

AI_REMIX_WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="TVAPP Lightning AI Remix MCP", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _log(message: str) -> None:
    try:
        MCP_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with MCP_LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(f"{_now()} {message.rstrip()}\n")
    except Exception:
        pass


def _configured_token() -> str:
    return os.environ.get(TOKEN_ENV, "").strip()


def _extract_bearer(authorization: str | None) -> str:
    if not authorization:
        return ""
    prefix = "Bearer "
    if authorization.startswith(prefix):
        return authorization[len(prefix):].strip()
    return authorization.strip()


def require_auth(
    authorization: str | None = Header(default=None),
    x_lightning_mcp_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    expected = _configured_token()
    if not expected:
        raise HTTPException(status_code=503, detail=f"{TOKEN_ENV} is required before MCP tools can run")
    provided = token or x_lightning_mcp_token or _extract_bearer(authorization)
    if provided != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing Lightning MCP token")


def _safe_job_id(job_id: str) -> str:
    clean = (job_id or "").strip()
    if not JOB_ID_PATTERN.match(clean):
        raise ValueError("Invalid job_id")
    return clean


def _safe_job_dir(job_id: str) -> Path:
    clean = _safe_job_id(job_id)
    root = AI_REMIX_WORK_DIR.resolve()
    candidate = (AI_REMIX_WORK_DIR / clean).resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("Job path escapes AI_REMIX_WORK_DIR")
    return candidate


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"_read_error": str(exc)}


def _run(command: list[str], timeout: int = 30, cwd: Path | None = None) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
        return {
            "command": command,
            "returncode": completed.returncode,
            "ok": completed.returncode == 0,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "output": (completed.stdout or "")[-12000:],
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "command": command,
            "returncode": None,
            "ok": False,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "output": f"Timed out after {timeout}s. {exc}",
        }
    except FileNotFoundError as exc:
        return {
            "command": command,
            "returncode": None,
            "ok": False,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "output": f"Executable not found: {exc}",
        }


def _http_json(url: str, timeout: int = 15) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return {
                "ok": 200 <= response.status < 300,
                "status": response.status,
                "url": url,
                "json": json.loads(body) if body else {},
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "status": exc.code, "url": url, "body": body[-4000:]}
    except Exception as exc:
        return {"ok": False, "status": None, "url": url, "error": str(exc)}


def _post_multipart(url: str, fields: dict[str, str], files: dict[str, Path], timeout: int = 60) -> dict[str, Any]:
    boundary = f"----tvapp-lightning-mcp-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode())
        chunks.append(b"\r\n")
    for name, path in files.items():
        data = path.read_bytes()
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'.encode())
        chunks.append(b"Content-Type: video/mp4\r\n\r\n")
        chunks.append(data)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(len(body))},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return {"ok": 200 <= response.status < 300, "status": response.status, "url": url, "json": json.loads(raw) if raw else {}}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "status": exc.code, "url": url, "body": raw[-4000:]}
    except Exception as exc:
        return {"ok": False, "status": None, "url": url, "error": str(exc)}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_worker_pid() -> int | None:
    try:
        raw = PID_FILE.read_text(encoding="utf-8").strip()
        return int(raw) if raw else None
    except Exception:
        return None


def _worker_base_url() -> str:
    try:
        saved = WORKER_BASE_FILE.read_text(encoding="utf-8").strip().rstrip("/")
        if saved:
            return saved
    except Exception:
        pass
    return DEFAULT_WORKER_BASE_URL


def _write_worker_base_url(url: str) -> None:
    WORKER_BASE_FILE.parent.mkdir(parents=True, exist_ok=True)
    WORKER_BASE_FILE.write_text(url.rstrip("/") + "\n", encoding="utf-8")


def _tail_file(path: Path, lines: int = 120) -> dict[str, Any]:
    lines = max(1, min(int(lines), 1000))
    if not path.exists():
        return {"ok": False, "path": str(path), "error": "File not found"}
    content = path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
    return {"ok": True, "path": str(path), "lines": lines, "text": "\n".join(content)}


def _tool_result(value: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value, indent=2, sort_keys=True)}], "isError": False}


def check_lightning_runtime() -> dict[str, Any]:
    return {
        "ok": True,
        "time": _now(),
        "python": sys.version,
        "platform": platform.platform(),
        "cwd": str(Path.cwd()),
        "worker_base_url": _worker_base_url(),
        "ai_remix_work_dir": str(AI_REMIX_WORK_DIR),
        "wan_root": str(WAN_ROOT),
        "wan_ckpt_dir": str(WAN_CKPT_DIR),
        "token_configured": bool(_configured_token()),
        "environment": {
            "AI_REMIX_PROVIDER": os.environ.get("AI_REMIX_PROVIDER", ""),
            "AI_REMIX_GPU_ENABLED": os.environ.get("AI_REMIX_GPU_ENABLED", ""),
            "AI_REMIX_ALLOW_MODAL": os.environ.get("AI_REMIX_ALLOW_MODAL", ""),
            "AI_REMIX_SIZE": os.environ.get("AI_REMIX_SIZE", ""),
            "AI_REMIX_FRAME_NUM": os.environ.get("AI_REMIX_FRAME_NUM", ""),
            "AI_REMIX_SAMPLE_STEPS": os.environ.get("AI_REMIX_SAMPLE_STEPS", ""),
            "AI_REMIX_MAX_SECONDS": os.environ.get("AI_REMIX_MAX_SECONDS", ""),
        },
    }


def check_gpu() -> dict[str, Any]:
    nvidia = _run(["nvidia-smi"], timeout=20)
    torch_payload: dict[str, Any]
    try:
        import torch  # type: ignore

        cuda_available = bool(torch.cuda.is_available())
        torch_payload = {
            "torch_imported": True,
            "cuda_available": cuda_available,
            "device_count": int(torch.cuda.device_count()) if cuda_available else 0,
            "device_name": torch.cuda.get_device_name(0) if cuda_available else None,
        }
    except Exception as exc:
        torch_payload = {"torch_imported": False, "cuda_available": False, "error": str(exc)}
    return {"ok": bool(nvidia.get("ok")) or bool(torch_payload.get("cuda_available")), "nvidia_smi": nvidia, "torch": torch_payload}


def check_wan() -> dict[str, Any]:
    generate_py = WAN_ROOT / "generate.py"
    root_entries: list[str] = []
    ckpt_entries: list[str] = []
    if WAN_ROOT.exists():
        try:
            root_entries = sorted(p.name for p in WAN_ROOT.iterdir())[:40]
        except Exception:
            root_entries = []
    if WAN_CKPT_DIR.exists():
        try:
            ckpt_entries = sorted(p.name for p in WAN_CKPT_DIR.iterdir())[:40]
        except Exception:
            ckpt_entries = []
    return {
        "ok": WAN_ROOT.exists() and generate_py.exists() and WAN_CKPT_DIR.exists(),
        "wan_root": str(WAN_ROOT),
        "wan_root_exists": WAN_ROOT.exists(),
        "generate_py": str(generate_py),
        "generate_py_exists": generate_py.exists(),
        "wan_ckpt_dir": str(WAN_CKPT_DIR),
        "wan_ckpt_dir_exists": WAN_CKPT_DIR.exists(),
        "root_entries": root_entries,
        "checkpoint_entries": ckpt_entries,
        "pipeline_cmd": os.environ.get("AI_REMIX_PIPELINE_CMD", "python /app/pipelines/wan_vace_remix.py"),
    }


def get_worker_health() -> dict[str, Any]:
    return _http_json(f"{_worker_base_url()}/health", timeout=15)


def start_worker(port: int = DEFAULT_WORKER_PORT) -> dict[str, Any]:
    port = max(1024, min(int(port), 65535))
    existing = _read_worker_pid()
    worker_base_url = f"http://127.0.0.1:{port}"
    if existing and _pid_alive(existing):
        _write_worker_base_url(worker_base_url)
        return {"ok": True, "already_running": True, "pid": existing, "worker_base_url": worker_base_url}

    script_dir = Path(__file__).resolve().parent
    main_py = script_dir / "main.py"
    pipeline_py = script_dir / "pipelines" / "wan_vace_remix.py"
    if not main_py.exists():
        return {"ok": False, "error": f"Missing worker app at {main_py}"}

    env = os.environ.copy()
    env.setdefault("AI_REMIX_WORK_DIR", str(AI_REMIX_WORK_DIR))
    env.setdefault("WAN_ROOT", str(WAN_ROOT))
    env.setdefault("WAN_CKPT_DIR", str(WAN_CKPT_DIR))
    env.setdefault("AI_REMIX_PROVIDER", "lightning-gpu")
    env.setdefault("AI_REMIX_GPU_ENABLED", "true")
    env.setdefault("AI_REMIX_ALLOW_MODAL", "false")
    env.setdefault("AI_REMIX_PIPELINE_CMD", f"python {pipeline_py}")
    env.setdefault("ERASER_PUBLIC_BASE_URL", worker_base_url)

    log_path = AI_REMIX_WORK_DIR / "lightning_worker_uvicorn.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = log_path.open("ab")
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", str(port)],
        cwd=str(script_dir),
        env=env,
        stdout=handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    PID_FILE.write_text(str(process.pid), encoding="utf-8")
    _write_worker_base_url(worker_base_url)
    _log(f"started worker pid={process.pid} port={port}")
    time.sleep(2.0)
    health = _http_json(f"{worker_base_url}/health", timeout=10)
    return {"ok": process.poll() is None, "pid": process.pid, "worker_base_url": worker_base_url, "log_path": str(log_path), "health": health}


def stop_worker() -> dict[str, Any]:
    pid = _read_worker_pid()
    if not pid:
        return {"ok": True, "stopped": False, "message": "No pid file found"}
    if not _pid_alive(pid):
        PID_FILE.unlink(missing_ok=True)
        return {"ok": True, "stopped": False, "message": "Pid file existed but process is not running", "pid": pid}
    try:
        os.killpg(pid, signal.SIGTERM)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception as exc:
            return {"ok": False, "error": str(exc), "pid": pid}
    for _ in range(20):
        if not _pid_alive(pid):
            PID_FILE.unlink(missing_ok=True)
            _log(f"stopped worker pid={pid}")
            return {"ok": True, "stopped": True, "pid": pid}
        time.sleep(0.25)
    return {"ok": False, "error": "Worker did not stop after SIGTERM", "pid": pid}


def restart_worker(port: int = DEFAULT_WORKER_PORT) -> dict[str, Any]:
    stopped = stop_worker()
    started = start_worker(port=port)
    return {"ok": bool(started.get("ok")), "stop": stopped, "start": started}


def _make_tiny_video(path: Path) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    return _run([
        "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=8:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
    ], timeout=60)


def start_tiny_smoke_remix(prompt: str = "Make it a neon R&B music video") -> dict[str, Any]:
    worker_base_url = _worker_base_url()
    video_path = AI_REMIX_WORK_DIR / "smoke" / "tiny-1s.mp4"
    created = _make_tiny_video(video_path)
    if not created.get("ok"):
        return {"ok": False, "phase": "create_fixture", "ffmpeg": created}
    health = get_worker_health()
    if not health.get("ok"):
        started = start_worker(DEFAULT_WORKER_PORT)
        health = get_worker_health()
        if not health.get("ok"):
            return {"ok": False, "phase": "worker_health", "start": started, "health": health}
    post = _post_multipart(
        f"{worker_base_url}/v1/ai-remix/jobs",
        fields={
            "prompt": prompt,
            "intent": "full_video_to_video",
            "strength": "medium",
            "preserve_audio": "true",
            "preserve_face": "true",
            "preserve_motion": "true",
            "quality": "source",
        },
        files={"video": video_path},
        timeout=60,
    )
    return {"ok": bool(post.get("ok")), "fixture": str(video_path), "worker_base_url": worker_base_url, "response": post}


def get_job_status(job_id: str) -> dict[str, Any]:
    clean = _safe_job_id(job_id)
    remote = _http_json(f"{_worker_base_url()}/v1/ai-remix/jobs/{urllib.parse.quote(clean)}", timeout=15)
    if remote.get("ok"):
        return remote
    local_status = _read_json(_safe_job_dir(clean) / "status.json")
    return {"ok": bool(local_status), "remote": remote, "local_status": local_status}


def tail_job_log(job_id: str, lines: int = 80) -> dict[str, Any]:
    clean = _safe_job_id(job_id)
    lines = max(1, min(int(lines), 400))
    job_dir = _safe_job_dir(clean)
    candidates = [job_dir / "error.log", job_dir / "wan_pipeline.log"]
    for path in candidates:
        if path.exists():
            tailed = _tail_file(path, lines=lines)
            return {"job_id": clean, **tailed}
    return {"ok": False, "job_id": clean, "error": "No log file found", "checked": [str(p) for p in candidates]}


def tail_worker_log(lines: int = 160) -> dict[str, Any]:
    return _tail_file(AI_REMIX_WORK_DIR / "lightning_worker_uvicorn.log", lines=lines)


def tail_mcp_log(lines: int = 160) -> dict[str, Any]:
    return _tail_file(MCP_LOG_FILE, lines=lines)


def get_output_path(job_id: str) -> dict[str, Any]:
    clean = _safe_job_id(job_id)
    output = _safe_job_dir(clean) / "output.mp4"
    status = _read_json(_safe_job_dir(clean) / "status.json")
    return {
        "ok": output.exists() and output.stat().st_size > 0,
        "job_id": clean,
        "output_path": str(output),
        "exists": output.exists(),
        "size_bytes": output.stat().st_size if output.exists() else 0,
        "status": status,
        "download_url": f"{_worker_base_url()}/v1/ai-remix/jobs/{urllib.parse.quote(clean)}/output",
    }


def get_job_bundle(job_id: str, log_lines: int = 120) -> dict[str, Any]:
    clean = _safe_job_id(job_id)
    return {
        "ok": True,
        "job_id": clean,
        "status": get_job_status(clean),
        "log": tail_job_log(clean, lines=log_lines),
        "output": get_output_path(clean),
    }


def list_recent_jobs(limit: int = 10) -> dict[str, Any]:
    limit = max(1, min(int(limit), 50))
    jobs: list[dict[str, Any]] = []
    for path in AI_REMIX_WORK_DIR.glob("remix_*"):
        if not path.is_dir():
            continue
        status = _read_json(path / "status.json")
        jobs.append({
            "job_id": path.name,
            "modified_at": path.stat().st_mtime,
            "modified_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(path.stat().st_mtime)),
            "phase": status.get("phase"),
            "progress": status.get("progress"),
            "statusMessage": status.get("statusMessage"),
            "has_output": (path / "output.mp4").exists(),
            "path": str(path),
        })
    jobs.sort(key=lambda item: item["modified_at"], reverse=True)
    return {"ok": True, "work_dir": str(AI_REMIX_WORK_DIR), "jobs": jobs[:limit]}


def cancel_job(job_id: str) -> dict[str, Any]:
    clean = _safe_job_id(job_id)
    job_dir = _safe_job_dir(clean)
    if not job_dir.exists():
        return {"ok": False, "job_id": clean, "error": "Job not found"}
    marker = job_dir / "cancel_requested.txt"
    marker.write_text(f"cancel_requested_at={_now()}\n", encoding="utf-8")
    return {"ok": True, "job_id": clean, "marker": str(marker), "note": "Current worker may only observe cancellation after the active subprocess exits unless cancellation support is added to main.py."}


TOOL_REGISTRY: dict[str, tuple[Callable[..., dict[str, Any]], dict[str, Any], str]] = {
    "check_lightning_runtime": (check_lightning_runtime, {"type": "object", "properties": {}, "additionalProperties": False}, "Inspect Lightning runtime, env, paths, and token configuration."),
    "check_gpu": (check_gpu, {"type": "object", "properties": {}, "additionalProperties": False}, "Run nvidia-smi and torch CUDA checks."),
    "check_wan": (check_wan, {"type": "object", "properties": {}, "additionalProperties": False}, "Check Wan root, generate.py, and checkpoint directory."),
    "get_worker_health": (get_worker_health, {"type": "object", "properties": {}, "additionalProperties": False}, "Read the local FastAPI worker /health endpoint."),
    "start_worker": (start_worker, {"type": "object", "properties": {"port": {"type": "integer", "default": DEFAULT_WORKER_PORT}}, "additionalProperties": False}, "Start the local FastAPI AI Remix worker with uvicorn."),
    "stop_worker": (stop_worker, {"type": "object", "properties": {}, "additionalProperties": False}, "Stop the uvicorn worker started by this MCP server."),
    "restart_worker": (restart_worker, {"type": "object", "properties": {"port": {"type": "integer", "default": DEFAULT_WORKER_PORT}}, "additionalProperties": False}, "Restart the local FastAPI AI Remix worker."),
    "start_tiny_smoke_remix": (start_tiny_smoke_remix, {"type": "object", "properties": {"prompt": {"type": "string", "default": "Make it a neon R&B music video"}}, "additionalProperties": False}, "Create a tiny MP4 and submit it to the local AI Remix worker."),
    "get_job_status": (get_job_status, {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}, "additionalProperties": False}, "Get AI Remix job status by ID."),
    "tail_job_log": (tail_job_log, {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}, "lines": {"type": "integer", "default": 80}}, "additionalProperties": False}, "Read the tail of a Wan/AI Remix job log."),
    "tail_worker_log": (tail_worker_log, {"type": "object", "properties": {"lines": {"type": "integer", "default": 160}}, "additionalProperties": False}, "Read the FastAPI worker uvicorn log started by this MCP server."),
    "tail_mcp_log": (tail_mcp_log, {"type": "object", "properties": {"lines": {"type": "integer", "default": 160}}, "additionalProperties": False}, "Read this MCP server's own operator log."),
    "get_output_path": (get_output_path, {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}, "additionalProperties": False}, "Return the safe local output path and download URL for a job."),
    "get_job_bundle": (get_job_bundle, {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}, "log_lines": {"type": "integer", "default": 120}}, "additionalProperties": False}, "Return status, log tail, and output metadata for one AI Remix job."),
    "list_recent_jobs": (list_recent_jobs, {"type": "object", "properties": {"limit": {"type": "integer", "default": 10}}, "additionalProperties": False}, "List recent AI Remix jobs under AI_REMIX_WORK_DIR."),
    "cancel_job": (cancel_job, {"type": "object", "required": ["job_id"], "properties": {"job_id": {"type": "string"}}, "additionalProperties": False}, "Write a cancellation marker for an AI Remix job."),
}


def _list_tools() -> list[dict[str, Any]]:
    return [
        {"name": name, "description": description, "inputSchema": schema}
        for name, (_, schema, description) in sorted(TOOL_REGISTRY.items())
    ]


def _jsonrpc_result(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _jsonrpc_error(request_id: Any, code: int, message: str, data: Any | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
    if data is not None:
        payload["error"]["data"] = data
    return payload


def _handle_jsonrpc(payload: dict[str, Any]) -> dict[str, Any] | None:
    method = payload.get("method")
    request_id = payload.get("id")
    params = payload.get("params") or {}

    if method == "initialize":
        return _jsonrpc_result(request_id, {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "serverInfo": {"name": "tvapp-lightning-ai-remix-mcp", "version": APP_VERSION},
            "capabilities": {"tools": {"listChanged": False}},
        })
    if method == "notifications/initialized":
        return None
    if method == "ping":
        return _jsonrpc_result(request_id, {})
    if method == "tools/list":
        return _jsonrpc_result(request_id, {"tools": _list_tools()})
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if name not in TOOL_REGISTRY:
            return _jsonrpc_error(request_id, -32602, f"Unknown tool: {name}")
        func, _, _ = TOOL_REGISTRY[name]
        try:
            result = func(**arguments)
            return _jsonrpc_result(request_id, _tool_result(result))
        except Exception as exc:
            _log(f"tool_error name={name} error={exc}")
            return _jsonrpc_result(request_id, {"content": [{"type": "text", "text": json.dumps({"ok": False, "error": str(exc)}, indent=2)}], "isError": True})
    return _jsonrpc_error(request_id, -32601, f"Method not found: {method}")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "server": "tvapp-lightning-ai-remix-mcp",
        "version": APP_VERSION,
        "token_configured": bool(_configured_token()),
        "worker_base_url": _worker_base_url(),
        "tools": sorted(TOOL_REGISTRY.keys()),
    }


@app.get("/mcp/tools")
async def http_list_tools(_: None = Query(default=None), authorization: str | None = Header(default=None), x_lightning_mcp_token: str | None = Header(default=None), token: str | None = Query(default=None)) -> dict[str, Any]:
    require_auth(authorization=authorization, x_lightning_mcp_token=x_lightning_mcp_token, token=token)
    return {"tools": _list_tools()}


@app.post("/mcp")
async def mcp_endpoint(request: Request, authorization: str | None = Header(default=None), x_lightning_mcp_token: str | None = Header(default=None), token: str | None = Query(default=None)) -> JSONResponse:
    require_auth(authorization=authorization, x_lightning_mcp_token=x_lightning_mcp_token, token=token)
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(_jsonrpc_error(None, -32700, "Parse error", str(exc)), status_code=400)

    if isinstance(payload, list):
        responses = []
        for item in payload:
            if not isinstance(item, dict):
                responses.append(_jsonrpc_error(None, -32600, "Invalid request"))
                continue
            response = _handle_jsonrpc(item)
            if response is not None:
                responses.append(response)
        return JSONResponse(responses)
    if not isinstance(payload, dict):
        return JSONResponse(_jsonrpc_error(None, -32600, "Invalid request"), status_code=400)

    response = _handle_jsonrpc(payload)
    if response is None:
        return JSONResponse({}, status_code=202)
    return JSONResponse(response)


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("LIGHTNING_MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("LIGHTNING_MCP_PORT", "8765"))
    uvicorn.run("lightning_ai_remix_mcp:app", host=host, port=port, reload=False)
