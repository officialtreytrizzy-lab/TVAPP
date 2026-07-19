from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import select
import signal
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from threading import Lock, Thread, get_ident
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel

WORK_DIR = Path(os.environ.get("ERASER_WORK_DIR", "/tmp/video-eraser-jobs"))
TRANSITION_WORK_DIR = Path(os.environ.get("TRANSITION_WORK_DIR", "/tmp/video-transition-jobs"))
REMIX_WORK_DIR = Path(os.environ.get("AI_REMIX_WORK_DIR", "/tmp/ai-remix-jobs"))
UPLOAD_WORK_DIR = Path(os.environ.get("ERASER_UPLOAD_WORK_DIR", str(WORK_DIR / "_chunked_uploads")))
PUBLIC_BASE_URL = os.environ.get("ERASER_PUBLIC_BASE_URL", "").rstrip("/")
PIPELINE_CMD = os.environ.get("ERASER_PIPELINE_CMD", "python /app/pipelines/optical_flow_vace_inpaint.py").strip()
AI_REMIX_PIPELINE_CMD = os.environ.get("AI_REMIX_PIPELINE_CMD", "python /app/pipelines/wan_vace_remix.py").strip()

WORK_DIR.mkdir(parents=True, exist_ok=True)
TRANSITION_WORK_DIR.mkdir(parents=True, exist_ok=True)
REMIX_WORK_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_WORK_DIR.mkdir(parents=True, exist_ok=True)

APP_VERSION = "1.10.0"
WORKER_NAME = "tvapp-video-eraser-gpu"
WAN_ROOT = os.environ.get("WAN_ROOT", "/opt/Wan2.1")
WAN_CKPT_DIR = os.environ.get("WAN_CKPT_DIR", "/models/Wan2.1-VACE-1.3B")
MAX_AI_REMIX_UPLOAD_BYTES = int(os.environ.get("AI_REMIX_MAX_UPLOAD_MB", "50")) * 1024 * 1024
MAX_AI_REMIX_SECONDS = float(os.environ.get("AI_REMIX_MAX_SECONDS", "6"))
ERASER_UPLOAD_CHUNK_BYTES = int(os.environ.get("ERASER_UPLOAD_CHUNK_BYTES", str(2 * 1024 * 1024)))
ERASER_MAX_UPLOAD_BYTES = int(os.environ.get("ERASER_MAX_UPLOAD_MB", "1024")) * 1024 * 1024
UPLOAD_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")

app = FastAPI(title="TVAPP GPU Worker", version=APP_VERSION)
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


def job_dir_for(job_id: str) -> Path:
    if job_id.startswith("remix_"):
        return REMIX_WORK_DIR / job_id
    for root in (WORK_DIR, TRANSITION_WORK_DIR, REMIX_WORK_DIR):
        candidate = root / job_id
        if candidate.exists():
            return candidate
    return REMIX_WORK_DIR / job_id if job_id.startswith("remix") else WORK_DIR / job_id


def status_path_for(job_id: str) -> Path:
    return job_dir_for(job_id) / "status.json"


class JobState(BaseModel):
    jobId: str
    phase: str = "queued"
    progress: int = 0
    statusMessage: str = "Queued"
    outputUrl: str | None = None
    finalCompositeUrl: str | None = None
    compositeOutputUrl: str | None = None
    fullVideoUrl: str | None = None
    finalOutputUrl: str | None = None
    outputKind: str | None = None
    error: str | None = None
    prompt: str | None = None
    intent: str | None = None
    strength: str | None = None


class ChunkUploadCreate(BaseModel):
    job_id: str = ""
    filename: str = "video.mp4"
    size: int
    mime_type: str = "video/mp4"
    chunk_size: int | None = None


class ChunkUploadComplete(BaseModel):
    job_id: str = ""
    mask_base64: str
    selected_time: str | float | int = "0"
    selected_frame_index: str | int = "0"
    fps: str | float | int = "30"
    duration: str | float | int = "0"
    width: str | int = "0"
    height: str | int = "0"
    pipeline: str = "optical-flow-vace-diffusion"
    quality: str = "source"
    preserve_resolution: bool = True
    preserve_fps: bool = True
    preserve_audio: bool = True


jobs: dict[str, JobState] = {}
jobs_lock = Lock()


def dump_job_payload(job: JobState, request: Request | None = None) -> dict[str, Any]:
    data = job.model_dump()
    data["job_id"] = job.jobId
    for camel, snake in (
        ("outputUrl", "output_url"),
        ("finalCompositeUrl", "final_composite_url"),
        ("compositeOutputUrl", "composite_output_url"),
        ("fullVideoUrl", "full_video_url"),
        ("finalOutputUrl", "final_output_url"),
    ):
        if data.get(camel):
            data[camel] = absolute_url(str(data[camel]), request)
            data[snake] = data[camel]
    return data


def set_job(job_id: str, **updates: Any) -> JobState:
    with jobs_lock:
        current = jobs.get(job_id) or JobState(jobId=job_id)
        data = current.model_dump()
        data.update(updates)
        updated = JobState(**data)
        jobs[job_id] = updated
    try:
        path = status_path_for(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dump_job_payload(updated), indent=2, sort_keys=True), encoding="utf-8")
    except Exception:
        pass
    return updated


def get_job(job_id: str) -> JobState:
    with jobs_lock:
        job = jobs.get(job_id)
    if job:
        return job
    path = status_path_for(job_id)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["jobId"] = data.get("jobId") or data.get("job_id") or job_id
            job = JobState(**{k: v for k, v in data.items() if k in JobState.model_fields})
            with jobs_lock:
                jobs[job_id] = job
            return job
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not read job status: {exc}")
    raise HTTPException(status_code=404, detail="Job not found")


def public_output_url(job_id: str) -> str:
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}/v1/video-eraser/jobs/{job_id}/output"
    return f"/v1/video-eraser/jobs/{job_id}/output"


def public_transition_output_url(job_id: str) -> str:
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}/v1/video-transitions/mix/jobs/{job_id}/output"
    return f"/v1/video-transitions/mix/jobs/{job_id}/output"


def public_remix_output_url(job_id: str, request: Request | None = None) -> str:
    return absolute_url(f"/v1/ai-remix/jobs/{job_id}/output", request)


def save_upload(upload: UploadFile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as out:
        shutil.copyfileobj(upload.file, out)


def safe_upload_id(raw: str) -> str:
    value = str(raw or "").strip()
    if not UPLOAD_ID_PATTERN.fullmatch(value):
        raise HTTPException(status_code=400, detail="Invalid upload session id")
    return value


def safe_job_id(raw: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_-]+", "-", str(raw or "").strip()).strip("-")
    return value[:120] or str(uuid.uuid4())


def upload_dir_for(upload_id: str) -> Path:
    return UPLOAD_WORK_DIR / safe_upload_id(upload_id)


def upload_manifest_path(upload_id: str) -> Path:
    return upload_dir_for(upload_id) / "manifest.json"


def read_upload_manifest(upload_id: str) -> dict[str, Any]:
    path = upload_manifest_path(upload_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Upload session not found")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Upload manifest is unreadable: {exc}")
    return payload


def decode_mask_data_url(raw: str) -> bytes:
    value = str(raw or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="mask_base64 is required")
    encoded = value.split(",", 1)[1] if "," in value else value
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"mask_base64 is invalid: {exc}")
    if not decoded or len(decoded) > 16 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Mask is empty or too large")
    return decoded


def append_text_log(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line.rstrip("\n") + "\n")
        handle.flush()


def tail_text(path: Path, limit: int = 6000) -> str:
    if not path.exists():
        return ""
    data = path.read_text(encoding="utf-8", errors="replace")
    return data[-limit:]


def run_json(command: list[str]) -> dict[str, Any]:
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-2000:] or f"Command failed: {' '.join(command)}")
    return json.loads(completed.stdout or "{}")


def ffprobe_duration(path: Path) -> float:
    payload = run_json(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)])
    return max(float(payload.get("format", {}).get("duration") or 0), 0.0)


def ffprobe_video(path: Path) -> tuple[int, int, float]:
    payload = run_json([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", str(path),
    ])
    streams = payload.get("streams") or []
    if not streams:
        raise RuntimeError(f"No video stream found in {path.name}")
    stream = streams[0]
    width = int(stream.get("width") or 1280)
    height = int(stream.get("height") or 720)
    rate = str(stream.get("r_frame_rate") or "30/1")
    try:
        num, den = rate.split("/")
        fps = float(num) / max(float(den), 1.0)
    except Exception:
        fps = 30.0
    if fps <= 0 or fps > 120:
        fps = 30.0
    return width if width % 2 == 0 else width - 1, height if height % 2 == 0 else height - 1, fps


def has_audio(path: Path) -> bool:
    payload = run_json(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "json", str(path)])
    return bool(payload.get("streams"))


def clean_float(value: str, fallback: float, min_value: float, max_value: float) -> float:
    try:
        parsed = float(value)
    except Exception:
        parsed = fallback
    return max(min(parsed, max_value), min_value)


def assert_playable_mp4(path: Path) -> None:
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError(f"Output video is missing or empty: {path}")
    payload = run_json(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "json", str(path)])
    streams = payload.get("streams") or []
    if not streams:
        raise RuntimeError("Output exists but does not contain a playable video stream.")


def process_job(job_id: str, selected_time: str, selected_frame_index: str, fps: str, duration: str, width: str, height: str, quality: str) -> None:
    job_dir = WORK_DIR / job_id
    video_path = job_dir / "input_video"
    mask_path = job_dir / "mask.png"
    output_path = job_dir / "output.mp4"
    process: subprocess.Popen[str] | None = None
    try:
        set_job(
            job_id,
            phase="frame_extraction",
            progress=10,
            statusMessage="Preparing frame extraction",
        )
        if not PIPELINE_CMD:
            raise RuntimeError(
                "ERASER_PIPELINE_CMD is not configured. Point it at the optical-flow VACE diffusion pipeline."
            )
        env = os.environ.copy()
        env.update({
            "ERASER_JOB_ID": job_id,
            "ERASER_INPUT_VIDEO": str(video_path),
            "ERASER_INPUT_MASK": str(mask_path),
            "ERASER_OUTPUT_VIDEO": str(output_path),
            "ERASER_SELECTED_TIME": selected_time,
            "ERASER_SELECTED_FRAME_INDEX": selected_frame_index,
            "ERASER_FPS": fps,
            "ERASER_DURATION": duration,
            "ERASER_WIDTH": width,
            "ERASER_HEIGHT": height,
            "ERASER_OUTPUT_QUALITY": quality,
            "ERASER_PRESERVE_RESOLUTION": "true",
            "ERASER_PRESERVE_FPS": "true",
            "ERASER_PRESERVE_AUDIO": "true",
            "PYTHONUNBUFFERED": "1",
        })
        process = subprocess.Popen(
            PIPELINE_CMD,
            shell=True,
            cwd=str(job_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        assert process.stdout is not None
        log_lines: list[str] = []
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            log_lines.append(line)
            print(line, flush=True)
            if line.startswith("PIPELINE_STAGE:"):
                try:
                    stage = json.loads(line.split(":", 1)[1])
                    set_job(
                        job_id,
                        phase=str(stage.get("name") or "processing"),
                        progress=max(1, min(99, int(stage.get("progress") or 1))),
                        statusMessage=str(stage.get("message") or "Processing video"),
                    )
                except Exception as stage_error:
                    print(f"Could not parse pipeline stage update: {stage_error}", flush=True)
        return_code = process.wait(timeout=60 * 60)
        if return_code != 0:
            raise RuntimeError("\n".join(log_lines[-120:]) or f"Pipeline exited with {return_code}")
        assert_playable_mp4(output_path)
        final_url = public_output_url(job_id)
        set_job(
            job_id,
            phase="completed",
            progress=100,
            statusMessage="Optical-flow diffusion removal complete",
            outputUrl=final_url,
            finalCompositeUrl=final_url,
            compositeOutputUrl=final_url,
            fullVideoUrl=final_url,
            finalOutputUrl=final_url,
            outputKind="final_composite_video",
            error=None,
        )
    except Exception as exc:
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except Exception:
                process.kill()
        set_job(
            job_id,
            phase="failed",
            progress=100,
            statusMessage="Optical-flow diffusion removal failed",
            error=str(exc),
        )

def process_ai_remix_job(job_id: str, prompt: str, intent: str, strength: str, preserve_audio: str, preserve_face: str, preserve_motion: str, quality: str) -> None:
    job_dir = REMIX_WORK_DIR / job_id
    video_path = job_dir / "input_video"
    mask_path = job_dir / "mask.png"
    output_path = job_dir / "output.mp4"
    pipeline_log_path = job_dir / "wan_pipeline.log"
    error_log_path = job_dir / "error.log"
    started_at = time.monotonic()
    heartbeat_marks = [
        (60, 40, "Wan is still generating…"),
        (120, 45, "Wan is still generating…"),
        (240, 50, "Wan is still generating…"),
        (480, 60, "Wan is still generating…"),
    ]
    next_heartbeat_index = 0
    process: subprocess.Popen[str] | None = None
    try:
        append_text_log(pipeline_log_path, f"timestamp={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
        append_text_log(pipeline_log_path, f"job_id={job_id}")
        append_text_log(pipeline_log_path, f"input_path={video_path}")
        append_text_log(pipeline_log_path, f"output_path={output_path}")
        append_text_log(pipeline_log_path, f"prompt={prompt}")
        append_text_log(pipeline_log_path, f"worker_pid={os.getpid()}")
        append_text_log(pipeline_log_path, f"worker_thread_id={get_ident()}")
        append_text_log(pipeline_log_path, f"pipeline_command={AI_REMIX_PIPELINE_CMD}")
        if not AI_REMIX_PIPELINE_CMD:
            raise RuntimeError("AI_REMIX_PIPELINE_CMD is not configured. Point it at the Wan remix pipeline command.")
        if not prompt.strip():
            raise RuntimeError("AI Remix prompt is required.")
        set_job(job_id, phase="preparing", progress=8, statusMessage="Preparing Wan2.1 AI Remix", prompt=prompt, intent=intent, strength=strength)
        env = os.environ.copy()
        env.update({
            "AI_REMIX_JOB_ID": job_id,
            "AI_REMIX_INPUT_VIDEO": str(video_path),
            "AI_REMIX_INPUT_MASK": str(mask_path) if mask_path.exists() else "",
            "AI_REMIX_OUTPUT_VIDEO": str(output_path),
            "AI_REMIX_PROMPT": prompt,
            "AI_REMIX_INTENT": intent,
            "AI_REMIX_STRENGTH": strength,
            "AI_REMIX_PRESERVE_AUDIO": preserve_audio,
            "AI_REMIX_PRESERVE_FACE": preserve_face,
            "AI_REMIX_PRESERVE_MOTION": preserve_motion,
            "AI_REMIX_OUTPUT_QUALITY": quality,
            "AI_REMIX_LOG_PATH": str(pipeline_log_path),
            "PYTHONUNBUFFERED": "1",
            "WAN_ROOT": os.environ.get("WAN_ROOT", "/opt/Wan2.1"),
            "WAN_CKPT_DIR": os.environ.get("WAN_CKPT_DIR", "/models/Wan2.1-VACE-1.3B"),
        })
        set_job(job_id, phase="remixing", progress=35, statusMessage="Generating prompt-based AI remix with Wan2.1")
        append_text_log(pipeline_log_path, "starting AI Remix pipeline subprocess")
        process = subprocess.Popen(AI_REMIX_PIPELINE_CMD, shell=True, cwd=str(job_dir), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
        append_text_log(pipeline_log_path, f"pipeline_pid={process.pid}")
        assert process.stdout is not None
        while True:
            elapsed = time.monotonic() - started_at
            if next_heartbeat_index < len(heartbeat_marks):
                mark_seconds, mark_progress, mark_message = heartbeat_marks[next_heartbeat_index]
                if elapsed >= mark_seconds:
                    append_text_log(pipeline_log_path, f"heartbeat elapsed={int(elapsed)}s progress={mark_progress}")
                    set_job(job_id, phase="remixing", progress=mark_progress, statusMessage=mark_message, prompt=prompt, intent=intent, strength=strength)
                    next_heartbeat_index += 1
            if elapsed > 60 * 20:
                append_text_log(pipeline_log_path, "AI Remix V1 timeout reached; killing Wan process group")
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except Exception:
                    process.kill()
                raise TimeoutError("Wan generation timed out.")
            ready, _, _ = select.select([process.stdout], [], [], 1.0)
            if ready:
                line = process.stdout.readline()
                if line:
                    append_text_log(pipeline_log_path, line.rstrip("\n"))
            if process.poll() is not None:
                for line in process.stdout:
                    append_text_log(pipeline_log_path, line.rstrip("\n"))
                break
        return_code = process.returncode
        if return_code != 0:
            raise RuntimeError(tail_text(pipeline_log_path) or f"AI Remix pipeline exited with {return_code}")
        assert_playable_mp4(output_path)
        final_url = public_remix_output_url(job_id)
        append_text_log(pipeline_log_path, "AI Remix pipeline completed successfully")
        set_job(job_id, phase="completed", progress=100, statusMessage="AI Remix complete", outputUrl=final_url, finalCompositeUrl=final_url, compositeOutputUrl=final_url, fullVideoUrl=final_url, finalOutputUrl=final_url, outputKind="ai_remix_video", error=None, prompt=prompt, intent=intent, strength=strength)
    except Exception as exc:
        message = str(exc)
        append_text_log(pipeline_log_path, f"ERROR: {message}")
        diagnostic = tail_text(pipeline_log_path) or message
        error_log_path.write_text(diagnostic, encoding="utf-8")
        set_job(job_id, phase="failed", progress=100, statusMessage="Wan generation timed out." if isinstance(exc, TimeoutError) else "AI Remix failed. Check the job log for Wan/FFmpeg details.", error=diagnostic[-6000:], prompt=prompt, intent=intent, strength=strength)


def process_mix_transition(job_id: str, duration: str, quality: str) -> None:
    job_dir = TRANSITION_WORK_DIR / job_id
    clip_a = job_dir / "clip_a"
    clip_b = job_dir / "clip_b"
    output_path = job_dir / "output.mp4"
    try:
        set_job(job_id, phase="probing", progress=10, statusMessage="Reading clip timing and media streams")
        width, height, fps = ffprobe_video(clip_a)
        clip_a_duration = ffprobe_duration(clip_a)
        clip_b_duration = ffprobe_duration(clip_b)
        if clip_a_duration <= 0 or clip_b_duration <= 0:
            raise RuntimeError("Both clips must have a readable duration.")
        transition_duration = clean_float(duration, 1.0, 0.1, 5.0)
        transition_duration = min(transition_duration, max(clip_a_duration - 0.05, 0.1), max(clip_b_duration - 0.05, 0.1))
        offset = max(clip_a_duration - transition_duration, 0.0)
        audio_a = has_audio(clip_a)
        audio_b = has_audio(clip_b)
        crf = "18" if quality == "higher" else "21"
        set_job(job_id, phase="mixing", progress=45, statusMessage="Rendering CapCut-style Mix transition with FFmpeg xfade")
        v0 = f"[0:v]scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.3f},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v0]"
        v1 = f"[1:v]scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.3f},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v1]"
        xfade = f"[v0][v1]xfade=transition=fade:duration={transition_duration:.3f}:offset={offset:.3f},format=yuv420p[vout]"
        filters = [v0, v1, xfade]
        command = ["ffmpeg", "-y", "-i", str(clip_a), "-i", str(clip_b), "-filter_complex"]
        maps = ["-map", "[vout]"]
        if audio_a and audio_b:
            filters.append(f"[0:a]aresample=async=1:first_pts=0[a0]")
            filters.append(f"[1:a]aresample=async=1[first_pts=0][a1]")
            filters.append(f"[a0][a1]acrossfade=d={transition_duration:.3f}:c1=tri:c2=tri[aout]")
            maps += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        else:
            maps += ["-an"]
        command += [";".join(filters)] + maps + ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path)]
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60 * 20)
        if completed.returncode != 0:
            raise RuntimeError(completed.stdout[-6000:] or f"FFmpeg exited with {completed.returncode}")
        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise RuntimeError("Mix transition completed without writing output.mp4")
        set_job(job_id, phase="completed", progress=100, statusMessage="Mix transition render complete", outputUrl=public_transition_output_url(job_id), error=None)
    except Exception as exc:
        set_job(job_id, phase="failed", progress=100, statusMessage="Mix transition render failed", error=str(exc))


@app.get("/health")
async def health(request: Request):
    wan_root = Path(WAN_ROOT)
    wan_ckpt_dir = Path(WAN_CKPT_DIR)
    return {"ok": True, "worker": WORKER_NAME, "version": APP_VERSION, "has_wan_root": wan_root.exists(), "has_wan_generate": (wan_root / "generate.py").exists(), "has_wan_checkpoint": wan_ckpt_dir.exists(), "wan_root": str(wan_root), "wan_ckpt_dir": str(wan_ckpt_dir), "public_base_url": absolute_base_url(request), "ai_remix_pipeline_cmd": AI_REMIX_PIPELINE_CMD, "work_dir": str(WORK_DIR), "remix_work_dir": str(REMIX_WORK_DIR)}


@app.get("/v1/ai-remix/debug")
async def ai_remix_debug(request: Request):
    return {"ok": True, "max_recommended_upload_mb": MAX_AI_REMIX_UPLOAD_BYTES // (1024 * 1024), "max_duration_seconds": MAX_AI_REMIX_SECONDS, "routes": ["GET /health", "GET /v1/ai-remix/debug", "POST /v1/ai-remix/jobs", "GET /v1/ai-remix/jobs/{jobId}", "GET /v1/ai-remix/jobs/{jobId}/output", "GET /v1/ai-remix/jobs/{jobId}/log"], "cors": "enabled", "modal_worker_url_hint": absolute_base_url(request)}


@app.post("/v1/video-eraser/uploads")
async def create_chunked_upload(payload: ChunkUploadCreate, request: Request):
    expected_size = int(payload.size or 0)
    if expected_size <= 0 or expected_size > ERASER_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Video size must be between 1 byte and {ERASER_MAX_UPLOAD_BYTES} bytes")
    requested_chunk = int(payload.chunk_size or ERASER_UPLOAD_CHUNK_BYTES)
    chunk_size = max(256 * 1024, min(requested_chunk, 4 * 1024 * 1024))
    upload_id = f"upl_{uuid.uuid4().hex}"
    upload_dir = upload_dir_for(upload_id)
    upload_dir.mkdir(parents=True, exist_ok=False)
    expected_chunks = int(math.ceil(expected_size / chunk_size))
    manifest = {
        "upload_id": upload_id,
        "job_id": safe_job_id(payload.job_id),
        "filename": Path(payload.filename or "video.mp4").name,
        "mime_type": payload.mime_type or "video/mp4",
        "expected_size": expected_size,
        "chunk_size": chunk_size,
        "expected_chunks": expected_chunks,
        "created_at": time.time(),
    }
    upload_manifest_path(upload_id).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    base = absolute_base_url(request)
    return {
        **manifest,
        "chunk_upload_url_template": f"{base}/v1/video-eraser/uploads/{upload_id}/chunks/{{index}}",
        "complete_url": f"{base}/v1/video-eraser/uploads/{upload_id}/complete",
    }


@app.post("/v1/video-eraser/uploads/{upload_id}/chunks/{chunk_index}")
async def upload_video_chunk(upload_id: str, chunk_index: int, request: Request):
    manifest = read_upload_manifest(upload_id)
    expected_chunks = int(manifest["expected_chunks"])
    chunk_size = int(manifest["chunk_size"])
    expected_size = int(manifest["expected_size"])
    if chunk_index < 0 or chunk_index >= expected_chunks:
        raise HTTPException(status_code=400, detail="Chunk index is outside the upload range")
    body = await request.body()
    expected_chunk_size = chunk_size if chunk_index < expected_chunks - 1 else expected_size - (chunk_size * (expected_chunks - 1))
    if len(body) != expected_chunk_size:
        raise HTTPException(
            status_code=400,
            detail=f"Chunk {chunk_index} has {len(body)} bytes; expected {expected_chunk_size}",
        )
    supplied_hash = str(request.headers.get("x-chunk-sha256") or "").strip().lower()
    actual_hash = hashlib.sha256(body).hexdigest()
    if supplied_hash and supplied_hash != actual_hash:
        raise HTTPException(status_code=400, detail=f"Chunk {chunk_index} checksum mismatch")
    chunk_path = upload_dir_for(upload_id) / f"chunk-{chunk_index:06d}.part"
    temp_path = chunk_path.with_suffix(".tmp")
    temp_path.write_bytes(body)
    temp_path.replace(chunk_path)
    return {
        "ok": True,
        "upload_id": upload_id,
        "chunk_index": chunk_index,
        "bytes": len(body),
        "sha256": actual_hash,
    }


@app.post("/v1/video-eraser/uploads/{upload_id}/complete")
async def complete_chunked_upload(upload_id: str, payload: ChunkUploadComplete):
    manifest = read_upload_manifest(upload_id)
    upload_dir = upload_dir_for(upload_id)
    expected_chunks = int(manifest["expected_chunks"])
    expected_size = int(manifest["expected_size"])
    missing = [index for index in range(expected_chunks) if not (upload_dir / f"chunk-{index:06d}.part").exists()]
    if missing:
        raise HTTPException(status_code=409, detail=f"Upload is incomplete; missing chunks: {missing[:20]}")

    remote_job_id = safe_job_id(payload.job_id or str(manifest.get("job_id") or ""))
    job_dir = WORK_DIR / remote_job_id
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=False)
    assembled_temp = job_dir / "input_video.tmp"
    digest = hashlib.sha256()
    assembled_size = 0
    with assembled_temp.open("wb") as output:
        for index in range(expected_chunks):
            chunk_path = upload_dir / f"chunk-{index:06d}.part"
            with chunk_path.open("rb") as source:
                while True:
                    block = source.read(1024 * 1024)
                    if not block:
                        break
                    output.write(block)
                    digest.update(block)
                    assembled_size += len(block)
    if assembled_size != expected_size:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Assembled upload has {assembled_size} bytes; expected {expected_size}")
    assembled_temp.replace(job_dir / "input_video")
    (job_dir / "mask.png").write_bytes(decode_mask_data_url(payload.mask_base64))
    shutil.rmtree(upload_dir, ignore_errors=True)

    state = set_job(
        remote_job_id,
        phase="queued",
        progress=5,
        statusMessage="Chunked upload verified; queued optical-flow diffusion removal",
    )
    Thread(
        target=process_job,
        args=(
            remote_job_id,
            str(payload.selected_time),
            str(payload.selected_frame_index),
            str(payload.fps),
            str(payload.duration),
            str(payload.width),
            str(payload.height),
            "higher" if payload.quality == "higher" else "source",
        ),
        daemon=True,
    ).start()
    response = dump_job_payload(state)
    response.update({
        "upload_id": upload_id,
        "uploaded_bytes": assembled_size,
        "source_sha256": digest.hexdigest(),
        "statusUrl": f"/v1/video-eraser/jobs/{remote_job_id}",
        "status_url": f"/v1/video-eraser/jobs/{remote_job_id}",
        "outputUrl": f"/v1/video-eraser/jobs/{remote_job_id}/output",
        "output_url": f"/v1/video-eraser/jobs/{remote_job_id}/output",
    })
    return response


@app.post("/v1/video-eraser/jobs")
async def create_job(video: UploadFile = File(...), mask: UploadFile = File(...), job_id: str = Form(default=""), selected_time: str = Form(default="0"), selected_frame_index: str = Form(default="0"), fps: str = Form(default="30"), duration: str = Form(default="0"), width: str = Form(default="0"), height: str = Form(default="0"), pipeline: str = Form(default="optical-flow-vace-diffusion"), quality: str = Form(default="source"), preserve_resolution: str = Form(default="true"), preserve_fps: str = Form(default="true"), preserve_audio: str = Form(default="true")):
    remote_job_id = job_id.strip() or str(uuid.uuid4())
    job_dir = WORK_DIR / remote_job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    save_upload(video, job_dir / "input_video")
    save_upload(mask, job_dir / "mask.png")
    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued optical-flow diffusion removal")
    Thread(target=process_job, args=(remote_job_id, selected_time, selected_frame_index, fps, duration, width, height, quality), daemon=True).start()
    payload = dump_job_payload(state)
    payload["statusUrl"] = payload["status_url"] = f"/v1/video-eraser/jobs/{remote_job_id}"
    payload["outputUrl"] = payload["output_url"] = f"/v1/video-eraser/jobs/{remote_job_id}/output"
    return payload


@app.get("/v1/video-eraser/jobs/{job_id}")
async def get_video_job(job_id: str):
    return dump_job_payload(get_job(job_id))


@app.get("/v1/video-eraser/jobs/{job_id}/output")
async def get_video_job_output(job_id: str):
    job_dir = WORK_DIR / job_id
    output = job_dir / "output.mp4"
    if not output.exists():
        raise HTTPException(status_code=404, detail="Output not ready")
    return FileResponse(str(output), media_type="video/mp4", filename=f"{job_id}.mp4")


@app.post("/v1/ai-remix/jobs")
async def create_ai_remix_job(request: Request, video: UploadFile = File(...), prompt: str = Form(default=""), intent: str = Form(default="full_video_to_video"), strength: str = Form(default="medium"), preserve_audio: str = Form(default="true"), preserve_face: str = Form(default="true"), preserve_motion: str = Form(default="true"), quality: str = Form(default="source"), mask: UploadFile | None = File(default=None), job_id: str = Form(default="")):
    remote_job_id = job_id.strip() or f"remix_{uuid.uuid4().hex[:18]}"
    job_dir = REMIX_WORK_DIR / remote_job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    video_path = job_dir / "input_video"
    save_upload(video, video_path)
    if video_path.stat().st_size > MAX_AI_REMIX_UPLOAD_BYTES:
        video_path.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="AI Remix V1 supports short clips only. Trim to 2–5 seconds and try again.")
    if mask is not None and mask.filename:
        save_upload(mask, job_dir / "mask.png")
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="AI Remix prompt is required.")
    try:
        duration_seconds = ffprobe_duration(video_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read uploaded video duration: {exc}")
    if duration_seconds > MAX_AI_REMIX_SECONDS:
        raise HTTPException(status_code=413, detail="AI Remix V1 supports short clips only. Trim to 2–5 seconds and try again.")
    normalized_strength = strength if strength in {"light", "medium", "heavy"} else "medium"
    normalized_quality = quality or "source"
    metadata_path = job_dir / "metadata.txt"
    metadata_path.write_text(f"prompt={prompt}\nintent={intent}\nstrength={normalized_strength}\npreserve_audio={preserve_audio}\npreserve_face={preserve_face}\npreserve_motion={preserve_motion}\nquality={normalized_quality}\n", encoding="utf-8")
    append_text_log(job_dir / "wan_pipeline.log", f"job_id={remote_job_id}")
    append_text_log(job_dir / "wan_pipeline.log", f"queued_at={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    append_text_log(job_dir / "wan_pipeline.log", "queued AI Remix job; background worker thread will append lifecycle details")
    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued AI Remix", prompt=prompt, intent=intent, strength=normalized_strength)
    thread = Thread(target=process_ai_remix_job, args=(remote_job_id, prompt, intent, normalized_strength, preserve_audio, preserve_face, preserve_motion, normalized_quality), daemon=True)
    thread.start()
    payload = dump_job_payload(state, request)
    status_path = f"/v1/ai-remix/jobs/{remote_job_id}"
    payload["statusUrl"] = payload["status_url"] = absolute_url(status_path, request)
    payload["workerBase"] = payload["worker_base"] = absolute_base_url(request)
    return payload


@app.get("/v1/ai-remix/jobs/{job_id}")
async def get_ai_remix_job(job_id: str, request: Request):
    job = get_job(job_id)
    payload = dump_job_payload(job, request)
    payload["statusUrl"] = payload["status_url"] = absolute_url(f"/v1/ai-remix/jobs/{job_id}", request)
    payload["workerBase"] = payload["worker_base"] = absolute_base_url(request)
    if job.phase == "completed":
        final_url = public_remix_output_url(job_id, request)
        for key in ("outputUrl", "output_url", "finalCompositeUrl", "final_composite_url", "compositeOutputUrl", "composite_output_url", "fullVideoUrl", "full_video_url", "finalOutputUrl", "final_output_url"):
            payload[key] = final_url
    return payload


@app.get("/v1/ai-remix/jobs/{job_id}/output")
async def get_ai_remix_output(job_id: str):
    job = get_job(job_id)
    output = REMIX_WORK_DIR / job_id / "output.mp4"
    if job.phase != "completed":
        return JSONResponse(status_code=409, content={"error": "AI Remix output is not ready", "job_id": job_id, "phase": job.phase, "statusMessage": job.statusMessage})
    if not output.exists() or output.stat().st_size <= 0:
        return JSONResponse(status_code=500, content={"error": "AI Remix completed but output.mp4 is missing or empty", "job_id": job_id})
    try:
        assert_playable_mp4(output)
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": f"AI Remix output is not playable: {exc}", "job_id": job_id})
    return FileResponse(str(output), media_type="video/mp4", filename=f"{job_id}.mp4")


@app.get("/v1/ai-remix/jobs/{job_id}/log")
async def get_ai_remix_log(job_id: str):
    job_dir = REMIX_WORK_DIR / job_id
    for candidate in (job_dir / "error.log", job_dir / "wan_pipeline.log"):
        if candidate.exists():
            return PlainTextResponse(candidate.read_text(encoding="utf-8", errors="replace"), media_type="text/plain")
    return JSONResponse(status_code=404, content={"error": "No log file found", "job_id": job_id})


@app.post("/v1/video-transitions/mix")
async def create_transition_mix(clip_a: UploadFile = File(...), clip_b: UploadFile = File(...), duration: str = Form(default="1.0"), quality: str = Form(default="source"), job_id: str = Form(default="")):
    remote_job_id = job_id.strip() or f"mix_{uuid.uuid4().hex[:18]}"
    job_dir = TRANSITION_WORK_DIR / remote_job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    save_upload(clip_a, job_dir / "clip_a")
    save_upload(clip_b, job_dir / "clip_b")
    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued Mix transition render")
    Thread(target=process_mix_transition, args=(remote_job_id, duration, quality), daemon=True).start()
    payload = dump_job_payload(state)
    payload["statusUrl"] = payload["status_url"] = f"/v1/video-transitions/mix/jobs/{remote_job_id}"
    payload["outputUrl"] = payload["output_url"] = public_transition_output_url(remote_job_id)
    return payload


@app.get("/v1/video-transitions/mix/jobs/{job_id}")
async def get_transition_mix(job_id: str):
    return dump_job_payload(get_job(job_id))


@app.get("/v1/video-transitions/mix/jobs/{job_id}/output")
async def get_transition_mix_output(job_id: str):
    job_dir = TRANSITION_WORK_DIR / job_id
    output = job_dir / "output.mp4"
    if not output.exists():
        raise HTTPException(status_code=404, detail="Output not ready")
    return FileResponse(str(output), media_type="video/mp4", filename=f"{job_id}.mp4")
