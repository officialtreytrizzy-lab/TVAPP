import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

WORK_DIR = Path(os.environ.get("ERASER_WORK_DIR", "/tmp/video-eraser-jobs"))
TRANSITION_WORK_DIR = Path(os.environ.get("TRANSITION_WORK_DIR", "/tmp/video-transition-jobs"))
REMIX_WORK_DIR = Path(os.environ.get("AI_REMIX_WORK_DIR", "/tmp/ai-remix-jobs"))
PUBLIC_BASE_URL = os.environ.get("ERASER_PUBLIC_BASE_URL", "").rstrip("/")
PIPELINE_CMD = os.environ.get("ERASER_PIPELINE_CMD", "python /app/pipelines/sam2_propainter.py").strip()
AI_REMIX_PIPELINE_CMD = os.environ.get("AI_REMIX_PIPELINE_CMD", "python /app/pipelines/wan_vace_remix.py").strip()

WORK_DIR.mkdir(parents=True, exist_ok=True)
TRANSITION_WORK_DIR.mkdir(parents=True, exist_ok=True)
REMIX_WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="TVAPP GPU Worker", version="1.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class JobState(BaseModel):
    jobId: str
    phase: str = "queued"
    progress: int = 0
    statusMessage: str = "Queued"
    # Legacy/generic output URL kept for older clients.
    outputUrl: str | None = None
    # Explicit names for final full-frame video outputs. Newer clients/proxies
    # must prefer these over generic outputUrl to avoid patch/blob ambiguity.
    finalCompositeUrl: str | None = None
    compositeOutputUrl: str | None = None
    fullVideoUrl: str | None = None
    finalOutputUrl: str | None = None
    outputKind: str | None = None
    error: str | None = None
    prompt: str | None = None
    intent: str | None = None
    strength: str | None = None

jobs: dict[str, JobState] = {}
jobs_lock = Lock()


def set_job(job_id: str, **updates: Any) -> JobState:
    with jobs_lock:
        current = jobs.get(job_id) or JobState(jobId=job_id)
        data = current.model_dump()
        data.update(updates)
        updated = JobState(**data)
        jobs[job_id] = updated
        return updated


def get_job(job_id: str) -> JobState:
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def public_output_url(job_id: str) -> str:
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}/v1/video-eraser/jobs/{job_id}/output"
    return f"/v1/video-eraser/jobs/{job_id}/output"


def public_transition_output_url(job_id: str) -> str:
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}/v1/video-transitions/mix/jobs/{job_id}/output"
    return f"/v1/video-transitions/mix/jobs/{job_id}/output"


def public_remix_output_url(job_id: str) -> str:
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}/v1/ai-remix/jobs/{job_id}/output"
    return f"/v1/ai-remix/jobs/{job_id}/output"


def save_upload(upload: UploadFile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as out:
        shutil.copyfileobj(upload.file, out)


def run_json(command: list[str]) -> dict[str, Any]:
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-2000:] or f"Command failed: {' '.join(command)}")
    return json.loads(completed.stdout or "{}")


def ffprobe_duration(path: Path) -> float:
    payload = run_json([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path),
    ])
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
    payload = run_json([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=index", "-of", "json", str(path),
    ])
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
    payload = run_json([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_type,width,height", "-of", "json", str(path),
    ])
    streams = payload.get("streams") or []
    if not streams:
        raise RuntimeError("Output exists but does not contain a playable video stream.")


def process_job(job_id: str, selected_time: str, selected_frame_index: str, fps: str, duration: str, width: str, height: str, quality: str) -> None:
    job_dir = WORK_DIR / job_id
    video_path = job_dir / "input_video"
    mask_path = job_dir / "mask.png"
    output_path = job_dir / "output.mp4"

    try:
        set_job(job_id, phase="segmenting", progress=8, statusMessage="Preparing source-quality ProPainter job")
        if not PIPELINE_CMD:
            raise RuntimeError("ERASER_PIPELINE_CMD is not configured. Point it at the SAM2/ProPainter pipeline command.")

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
        })

        status = "Running ProPainter and restoring source-quality MP4"
        if quality == "higher":
            status = "Running ProPainter and exporting higher-quality MP4"
        set_job(job_id, phase="inpainting", progress=35, statusMessage=status)
        completed = subprocess.run(
            PIPELINE_CMD,
            shell=True,
            cwd=str(job_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60 * 45,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stdout[-6000:] or f"Pipeline exited with {completed.returncode}")
        assert_playable_mp4(output_path)

        final_url = public_output_url(job_id)
        set_job(
            job_id,
            phase="completed",
            progress=100,
            statusMessage="GPU AI removal complete",
            outputUrl=final_url,
            finalCompositeUrl=final_url,
            compositeOutputUrl=final_url,
            fullVideoUrl=final_url,
            finalOutputUrl=final_url,
            outputKind="final_composite_video",
            error=None,
        )
    except Exception as exc:
        set_job(job_id, phase="failed", progress=100, statusMessage="GPU AI removal failed", error=str(exc))


def process_ai_remix_job(job_id: str, prompt: str, intent: str, strength: str, preserve_audio: str, preserve_face: str, preserve_motion: str, quality: str) -> None:
    job_dir = REMIX_WORK_DIR / job_id
    video_path = job_dir / "input_video"
    mask_path = job_dir / "mask.png"
    output_path = job_dir / "output.mp4"

    try:
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
            "WAN_ROOT": os.environ.get("WAN_ROOT", "/opt/Wan2.1"),
            "WAN_CKPT_DIR": os.environ.get("WAN_CKPT_DIR", "/models/Wan2.1-VACE-1.3B"),
        })

        set_job(job_id, phase="remixing", progress=35, statusMessage="Generating prompt-based AI remix with Wan2.1")
        completed = subprocess.run(
            AI_REMIX_PIPELINE_CMD,
            shell=True,
            cwd=str(job_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60 * 45,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stdout[-6000:] or f"AI Remix pipeline exited with {completed.returncode}")
        assert_playable_mp4(output_path)

        final_url = public_remix_output_url(job_id)
        set_job(
            job_id,
            phase="completed",
            progress=100,
            statusMessage="AI Remix complete",
            outputUrl=final_url,
            finalCompositeUrl=final_url,
            compositeOutputUrl=final_url,
            fullVideoUrl=final_url,
            finalOutputUrl=final_url,
            outputKind="ai_remix_video",
            error=None,
            prompt=prompt,
            intent=intent,
            strength=strength,
        )
    except Exception as exc:
        set_job(job_id, phase="failed", progress=100, statusMessage="AI Remix failed", error=str(exc), prompt=prompt, intent=intent, strength=strength)


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
            filters.append(f"[1:a]aresample=async=1:first_pts=0[a1]")
            filters.append(f"[a0][a1]acrossfade=d={transition_duration:.3f}:c1=tri:c2=tri[aout]")
            maps += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        else:
            maps += ["-an"]

        command += [";".join(filters)] + maps + [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path),
        ]
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60 * 20)
        if completed.returncode != 0:
            raise RuntimeError(completed.stdout[-6000:] or f"FFmpeg exited with {completed.returncode}")
        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise RuntimeError("Mix transition completed without writing output.mp4")

        set_job(
            job_id,
            phase="completed",
            progress=100,
            statusMessage="Mix transition render complete",
            outputUrl=public_transition_output_url(job_id),
            error=None,
        )
    except Exception as exc:
        set_job(job_id, phase="failed", progress=100, statusMessage="Mix transition render failed", error=str(exc))


@app.post("/v1/video-eraser/jobs")
async def create_job(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    mask: UploadFile = File(...),
    job_id: str = Form(default=""),
    selected_time: str = Form(default="0"),
    selected_frame_index: str = Form(default="0"),
    fps: str = Form(default="30"),
    duration: str = Form(default="0"),
    width: str = Form(default="0"),
    height: str = Form(default="0"),
    pipeline: str = Form(default="sam2-propainter"),
    quality: str = Form(default="source"),
    preserve_resolution: str = Form(default="true"),
    preserve_fps: str = Form(default="true"),
    preserve_audio: str = Form(default="true"),
):
    remote_job_id = job_id.strip() or str(uuid.uuid4())
    job_dir = WORK_DIR / remote_job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    normalized_quality = quality if quality in {"source", "higher"} else "source"

    save_upload(video, job_dir / "input_video")
    save_upload(mask, job_dir / "mask.png")
    (job_dir / "request.txt").write_text(
        f"pipeline={pipeline}\nquality={normalized_quality}\npreserve_resolution={preserve_resolution}\npreserve_fps={preserve_fps}\npreserve_audio={preserve_audio}\nselected_time={selected_time}\nselected_frame_index={selected_frame_index}\nfps={fps}\nduration={duration}\nwidth={width}\nheight={height}\n",
        encoding="utf-8",
    )

    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued on GPU worker")
    background_tasks.add_task(process_job, remote_job_id, selected_time, selected_frame_index, fps, duration, width, height, normalized_quality)
    return {
        **state.model_dump(),
        "statusUrl": f"/v1/video-eraser/jobs/{remote_job_id}",
    }


@app.get("/v1/video-eraser/jobs/{job_id}")
async def read_job(job_id: str):
    return get_job(job_id).model_dump()


@app.post("/v1/video-eraser/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    return set_job(job_id, phase="cancelled", progress=100, statusMessage="Cancelled").model_dump()


@app.get("/v1/video-eraser/jobs/{job_id}/output")
async def read_output(job_id: str):
    get_job(job_id)
    output_path = WORK_DIR / job_id / "output.mp4"
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Output not ready")
    assert_playable_mp4(output_path)
    return FileResponse(output_path, media_type="video/mp4", filename=f"{job_id}-erased.mp4")


@app.post("/v1/ai-remix/jobs")
async def create_ai_remix_job(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    mask: UploadFile | None = File(default=None),
    job_id: str = Form(default=""),
    prompt: str = Form(default=""),
    intent: str = Form(default="full_video_to_video"),
    strength: str = Form(default="medium"),
    preserve_audio: str = Form(default="true"),
    preserve_face: str = Form(default="true"),
    preserve_motion: str = Form(default="true"),
    quality: str = Form(default="source"),
):
    remote_job_id = job_id.strip() or f"remix_{uuid.uuid4().hex[:18]}"
    job_dir = REMIX_WORK_DIR / remote_job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    normalized_strength = strength if strength in {"light", "medium", "heavy"} else "medium"
    normalized_quality = quality if quality in {"draft", "source", "high"} else "source"

    save_upload(video, job_dir / "input_video")
    if mask is not None:
        save_upload(mask, job_dir / "mask.png")
    (job_dir / "request.txt").write_text(
        f"prompt={prompt}\nintent={intent}\nstrength={normalized_strength}\npreserve_audio={preserve_audio}\npreserve_face={preserve_face}\npreserve_motion={preserve_motion}\nquality={normalized_quality}\n",
        encoding="utf-8",
    )

    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued AI Remix", prompt=prompt, intent=intent, strength=normalized_strength)
    background_tasks.add_task(process_ai_remix_job, remote_job_id, prompt, intent, normalized_strength, preserve_audio, preserve_face, preserve_motion, normalized_quality)
    return {
        **state.model_dump(),
        "statusUrl": f"/v1/ai-remix/jobs/{remote_job_id}",
    }


@app.get("/v1/ai-remix/jobs/{job_id}")
async def read_ai_remix_job(job_id: str):
    return get_job(job_id).model_dump()


@app.get("/v1/ai-remix/jobs/{job_id}/output")
async def read_ai_remix_output(job_id: str):
    get_job(job_id)
    output_path = REMIX_WORK_DIR / job_id / "output.mp4"
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Output not ready")
    assert_playable_mp4(output_path)
    return FileResponse(output_path, media_type="video/mp4", filename=f"{job_id}-ai-remix.mp4")


@app.post("/v1/video-transitions/mix/jobs")
async def create_mix_transition_job(
    background_tasks: BackgroundTasks,
    clip_a: UploadFile = File(...),
    clip_b: UploadFile = File(...),
    job_id: str = Form(default=""),
    duration: str = Form(default="1.0"),
    quality: str = Form(default="source"),
):
    remote_job_id = job_id.strip() or str(uuid.uuid4())
    job_dir = TRANSITION_WORK_DIR / remote_job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    normalized_quality = quality if quality in {"source", "higher"} else "source"

    save_upload(clip_a, job_dir / "clip_a")
    save_upload(clip_b, job_dir / "clip_b")
    (job_dir / "request.txt").write_text(
        f"transition=mix\nduration={duration}\nquality={normalized_quality}\n",
        encoding="utf-8",
    )

    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued Mix transition render")
    background_tasks.add_task(process_mix_transition, remote_job_id, duration, normalized_quality)
    return {
        **state.model_dump(),
        "statusUrl": f"/v1/video-transitions/mix/jobs/{remote_job_id}",
    }


@app.get("/v1/video-transitions/mix/jobs/{job_id}")
async def read_mix_transition_job(job_id: str):
    return get_job(job_id).model_dump()


@app.get("/v1/video-transitions/mix/jobs/{job_id}/output")
async def read_mix_transition_output(job_id: str):
    get_job(job_id)
    output_path = TRANSITION_WORK_DIR / job_id / "output.mp4"
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Output not ready")
    return FileResponse(output_path, media_type="video/mp4", filename=f"{job_id}-mix.mp4")
