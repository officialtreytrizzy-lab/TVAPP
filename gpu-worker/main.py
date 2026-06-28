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
PUBLIC_BASE_URL = os.environ.get("ERASER_PUBLIC_BASE_URL", "").rstrip("/")
PIPELINE_CMD = os.environ.get("ERASER_PIPELINE_CMD", "").strip()

WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Video Eraser GPU Worker", version="1.0.0")
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
    outputUrl: str | None = None
    error: str | None = None

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


def save_upload(upload: UploadFile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as out:
        shutil.copyfileobj(upload.file, out)


def process_job(job_id: str, selected_time: str, selected_frame_index: str, fps: str, duration: str, width: str, height: str) -> None:
    job_dir = WORK_DIR / job_id
    video_path = job_dir / "input_video"
    mask_path = job_dir / "mask.png"
    output_path = job_dir / "output.mp4"

    try:
        set_job(job_id, phase="segmenting", progress=8, statusMessage="Starting GPU segmentation pipeline")
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
        })

        set_job(job_id, phase="tracking_mask", progress=20, statusMessage="Running video mask tracking")
        completed = subprocess.run(
            PIPELINE_CMD,
            shell=True,
            cwd=str(job_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60 * 30,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stdout[-4000:] or f"Pipeline exited with {completed.returncode}")
        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise RuntimeError("Pipeline completed without writing output.mp4")

        set_job(
            job_id,
            phase="completed",
            progress=100,
            statusMessage="GPU AI removal complete",
            outputUrl=public_output_url(job_id),
            error=None,
        )
    except Exception as exc:
        set_job(job_id, phase="failed", progress=100, statusMessage="GPU AI removal failed", error=str(exc))


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
    quality: str = Form(default="commercial"),
):
    remote_job_id = job_id.strip() or str(uuid.uuid4())
    job_dir = WORK_DIR / remote_job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    save_upload(video, job_dir / "input_video")
    save_upload(mask, job_dir / "mask.png")
    (job_dir / "request.txt").write_text(
        f"pipeline={pipeline}\nquality={quality}\nselected_time={selected_time}\nselected_frame_index={selected_frame_index}\nfps={fps}\nduration={duration}\nwidth={width}\nheight={height}\n",
        encoding="utf-8",
    )

    state = set_job(remote_job_id, phase="queued", progress=5, statusMessage="Queued on GPU worker")
    background_tasks.add_task(process_job, remote_job_id, selected_time, selected_frame_index, fps, duration, width, height)
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
    return FileResponse(output_path, media_type="video/mp4", filename=f"{job_id}-erased.mp4")
