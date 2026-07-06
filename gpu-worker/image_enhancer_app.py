from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, PlainTextResponse
from pydantic import BaseModel

IMAGE_WORK_DIR = Path(os.environ.get("IMAGE_ENHANCER_WORK_DIR", "/tmp/image-enhancer-jobs"))
IMAGE_WORK_DIR.mkdir(parents=True, exist_ok=True)
PUBLIC_BASE_URL = os.environ.get("IMAGE_ENHANCER_PUBLIC_BASE_URL", os.environ.get("ERASER_PUBLIC_BASE_URL", "")).rstrip("/")
PIPELINE_CMD = os.environ.get("IMAGE_ENHANCER_PIPELINE_CMD", "python /app/pipelines/realesrgan_enhance.py").strip()
MAX_UPLOAD_BYTES = int(os.environ.get("IMAGE_ENHANCER_MAX_UPLOAD_MB", "24")) * 1024 * 1024
APP_VERSION = "0.1.0"

app = FastAPI(title="TVAPP AI Image Enhancer Worker", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
    }


@app.options("/{path:path}")
async def options_catch_all(path: str):
    return Response(status_code=204, headers=cors_headers())


def absolute_base_url(request: Request | None = None) -> str:
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    if request is not None:
        forwarded_proto = request.headers.get("x-forwarded-proto")
        forwarded_host = request.headers.get("x-forwarded-host")
        if forwarded_host:
            return f"{forwarded_proto or request.url.scheme}://{forwarded_host}".rstrip("/")
        return str(request.base_url).rstrip("/")
    return ""


def absolute_url(path: str, request: Request | None = None) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    base = absolute_base_url(request)
    return f"{base}{path if path.startswith('/') else '/' + path}" if base else path


class ImageJobState(BaseModel):
    jobId: str
    phase: str = "queued"
    progress: int = 0
    statusMessage: str = "Queued"
    outputUrl: str | None = None
    output_url: str | None = None
    error: str | None = None
    mode: str = "photo"
    scale: int = 4
    faceEnhance: bool = False
    outputFormat: str = "png"


jobs: dict[str, ImageJobState] = {}
jobs_lock = Lock()


def job_dir(job_id: str) -> Path:
    return IMAGE_WORK_DIR / job_id


def status_path(job_id: str) -> Path:
    return job_dir(job_id) / "status.json"


def log_path(job_id: str) -> Path:
    return job_dir(job_id) / "enhancer.log"


def output_path(job_id: str, output_format: str = "png") -> Path:
    fmt = output_format.lower().strip()
    if fmt not in {"png", "jpg", "jpeg", "webp"}:
        fmt = "png"
    ext = "jpg" if fmt == "jpeg" else fmt
    return job_dir(job_id) / f"output.{ext}"


def media_type_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "image/png"


def public_output_url(job_id: str, request: Request | None = None) -> str:
    return absolute_url(f"/v1/image-enhancer/jobs/{job_id}/output", request)


def dump_job(job: ImageJobState, request: Request | None = None) -> dict[str, Any]:
    data = job.model_dump()
    data["job_id"] = job.jobId
    if data.get("outputUrl"):
        data["outputUrl"] = absolute_url(str(data["outputUrl"]), request)
        data["output_url"] = data["outputUrl"]
    return data


def set_job(job_id: str, **updates: Any) -> ImageJobState:
    with jobs_lock:
        current = jobs.get(job_id) or ImageJobState(jobId=job_id)
        data = current.model_dump()
        data.update(updates)
        updated = ImageJobState(**data)
        jobs[job_id] = updated
    path = status_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dump_job(updated), indent=2, sort_keys=True), encoding="utf-8")
    return updated


def get_job(job_id: str) -> ImageJobState:
    with jobs_lock:
        cached = jobs.get(job_id)
    if cached:
        return cached
    path = status_path(job_id)
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        data["jobId"] = data.get("jobId") or data.get("job_id") or job_id
        job = ImageJobState(**{key: value for key, value in data.items() if key in ImageJobState.model_fields})
        with jobs_lock:
            jobs[job_id] = job
        return job
    raise HTTPException(status_code=404, detail="Image enhancer job not found")


def save_upload(upload: UploadFile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as out:
        shutil.copyfileobj(upload.file, out)


def tail(path: Path, limit: int = 6000) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")[-limit:]


def process_image_job(job_id: str, mode: str, scale: int, face_enhance: bool, output_format: str) -> None:
    current_dir = job_dir(job_id)
    input_image = current_dir / "input_image"
    out_image = output_path(job_id, output_format)
    log = log_path(job_id)
    try:
        set_job(job_id, phase="preparing", progress=8, statusMessage="Preparing Real-ESRGAN image enhancer", mode=mode, scale=scale, faceEnhance=face_enhance, outputFormat=output_format)
        env = os.environ.copy()
        env.update({
            "ENHANCER_JOB_ID": job_id,
            "ENHANCER_INPUT_IMAGE": str(input_image),
            "ENHANCER_OUTPUT_IMAGE": str(out_image),
            "ENHANCER_MODE": mode,
            "ENHANCER_SCALE": str(scale),
            "ENHANCER_FACE_ENHANCE": "true" if face_enhance else "false",
            "ENHANCER_OUTPUT_FORMAT": output_format,
            "PYTHONUNBUFFERED": "1",
        })
        set_job(job_id, phase="enhancing", progress=35, statusMessage="Running Real-ESRGAN enhancement", mode=mode, scale=scale, faceEnhance=face_enhance, outputFormat=output_format)
        started = time.time()
        completed = subprocess.run(PIPELINE_CMD, shell=True, cwd=str(current_dir), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60 * 12)
        log.write_text(completed.stdout or "", encoding="utf-8")
        if completed.returncode != 0:
            raise RuntimeError(completed.stdout[-6000:] or f"Image enhancer exited with {completed.returncode}")
        if not out_image.exists() or out_image.stat().st_size <= 0:
            raise RuntimeError("Image enhancer completed without writing an output image")
        set_job(job_id, phase="completed", progress=100, statusMessage=f"Image enhancement complete in {int(time.time() - started)}s", outputUrl=f"/v1/image-enhancer/jobs/{job_id}/output", output_url=f"/v1/image-enhancer/jobs/{job_id}/output", mode=mode, scale=scale, faceEnhance=face_enhance, outputFormat=output_format, error=None)
    except Exception as exc:
        message = str(exc)
        if not log.exists():
            log.write_text(message, encoding="utf-8")
        set_job(job_id, phase="failed", progress=100, statusMessage="Image enhancement failed", error=message[-6000:], mode=mode, scale=scale, faceEnhance=face_enhance, outputFormat=output_format)


@app.get("/health")
async def health(request: Request):
    weights_dir = Path(os.environ.get("REALESRGAN_WEIGHTS_DIR", "/opt/realesrgan_weights"))
    return {
        "ok": True,
        "worker": "tvapp-ai-image-enhancer-gpu",
        "version": APP_VERSION,
        "public_base_url": absolute_base_url(request),
        "pipeline_cmd": PIPELINE_CMD,
        "work_dir": str(IMAGE_WORK_DIR),
        "has_photo_model": (weights_dir / "RealESRGAN_x4plus.pth").exists(),
        "has_anime_model": (weights_dir / "RealESRGAN_x4plus_anime_6B.pth").exists(),
        "has_gfpgan_model": (weights_dir / "GFPGANv1.4.pth").exists(),
        "routes": ["POST /v1/image-enhancer/jobs", "GET /v1/image-enhancer/jobs/{jobId}", "GET /v1/image-enhancer/jobs/{jobId}/output", "GET /v1/image-enhancer/jobs/{jobId}/log"],
    }


@app.post("/v1/image-enhancer/jobs")
async def create_image_job(
    request: Request,
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    mode: str = Form(default="photo"),
    scale: str = Form(default="4"),
    face_enhance: str = Form(default="false"),
    output_format: str = Form(default="png"),
    job_id: str = Form(default=""),
):
    normalized_mode = mode.strip().lower()
    if normalized_mode not in {"photo", "anime"}:
        normalized_mode = "photo"
    try:
        normalized_scale = int(float(scale))
    except Exception:
        normalized_scale = 4
    if normalized_scale not in {2, 4}:
        normalized_scale = 4
    normalized_face = face_enhance.strip().lower() in {"1", "true", "yes", "on"}
    normalized_format = output_format.strip().lower()
    if normalized_format not in {"png", "jpg", "jpeg", "webp"}:
        normalized_format = "png"

    remote_job_id = job_id.strip() or f"enhance_{uuid.uuid4().hex[:18]}"
    current_dir = job_dir(remote_job_id)
    current_dir.mkdir(parents=True, exist_ok=True)
    input_path = current_dir / "input_image"
    save_upload(image, input_path)
    if input_path.stat().st_size > MAX_UPLOAD_BYTES:
        input_path.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail=f"Image enhancer upload limit is {MAX_UPLOAD_BYTES // (1024 * 1024)}MB")

    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued Real-ESRGAN image enhancer", mode=normalized_mode, scale=normalized_scale, faceEnhance=normalized_face, outputFormat=normalized_format)
    background_tasks.add_task(process_image_job, remote_job_id, normalized_mode, normalized_scale, normalized_face, normalized_format)
    payload = dump_job(state, request)
    payload["statusUrl"] = payload["status_url"] = absolute_url(f"/v1/image-enhancer/jobs/{remote_job_id}", request)
    payload["outputUrl"] = payload["output_url"] = public_output_url(remote_job_id, request)
    payload["workerBase"] = payload["worker_base"] = absolute_base_url(request)
    return payload


@app.get("/v1/image-enhancer/jobs/{job_id}")
async def get_image_job(job_id: str, request: Request):
    job = get_job(job_id)
    payload = dump_job(job, request)
    payload["statusUrl"] = payload["status_url"] = absolute_url(f"/v1/image-enhancer/jobs/{job_id}", request)
    if job.phase == "completed":
        payload["outputUrl"] = payload["output_url"] = public_output_url(job_id, request)
    return payload


@app.get("/v1/image-enhancer/jobs/{job_id}/output")
async def get_image_output(job_id: str):
    job = get_job(job_id)
    if job.phase != "completed":
        return JSONResponse(status_code=409, content={"error": "Image enhancer output is not ready", "job_id": job_id, "phase": job.phase, "statusMessage": job.statusMessage})
    out = output_path(job_id, job.outputFormat)
    if not out.exists() or out.stat().st_size <= 0:
        return JSONResponse(status_code=500, content={"error": "Image enhancer completed but output is missing", "job_id": job_id})
    return FileResponse(str(out), media_type=media_type_for(out), filename=f"{job_id}{out.suffix}")


@app.get("/v1/image-enhancer/jobs/{job_id}/log")
async def get_image_log(job_id: str):
    log = log_path(job_id)
    if log.exists():
        return PlainTextResponse(tail(log, 12000), media_type="text/plain")
    return JSONResponse(status_code=404, content={"error": "No enhancer log found", "job_id": job_id})
