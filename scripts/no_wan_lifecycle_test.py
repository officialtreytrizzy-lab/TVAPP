#!/usr/bin/env python3
"""Submit a dry-run AI Remix job and verify status/log lifecycle without Wan."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK_DIR = Path(tempfile.mkdtemp(prefix="tvapp-ai-remix-lifecycle-"))
PORT = int(os.environ.get("AI_REMIX_TEST_PORT", "8019"))
BASE = f"http://127.0.0.1:{PORT}"

def http_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read().decode() or "{}")

def main() -> int:
    env = os.environ.copy()
    env.update({
        "AI_REMIX_WORK_DIR": str(WORK_DIR),
        "AI_REMIX_PIPELINE_CMD": f"{sys.executable} {ROOT / 'gpu-worker' / 'pipelines' / 'wan_vace_remix.py'}",
        "AI_REMIX_DRY_RUN": "true",
        "AI_REMIX_MAX_SECONDS": "2",
        "AI_REMIX_TIMEOUT_SECONDS": "60",
        "AI_REMIX_MAX_CONCURRENT_JOBS": "1",
        "AI_REMIX_PROVIDER": "lightning-gpu",
        "AI_REMIX_ALLOW_MODAL": "false",
    })
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT)], cwd=ROOT / "gpu-worker", env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(60):
            try:
                if http_json(BASE + "/health").get("ok"):
                    break
            except Exception:
                time.sleep(0.25)
        else:
            raise RuntimeError("worker did not start")
        video = WORK_DIR / "tiny.mp4"
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=8:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        curl = subprocess.run(["curl", "-sS", "-F", "prompt=Dry run lifecycle", "-F", f"video=@{video}", BASE + "/v1/ai-remix/jobs"], check=True, stdout=subprocess.PIPE, text=True)
        submit = json.loads(curl.stdout)
        job_id = submit.get("job_id") or submit.get("jobId")
        assert job_id, submit
        job_dir = WORK_DIR / job_id
        assert (job_dir / "status.json").exists(), "status.json not written immediately"
        assert (job_dir / "job.log").exists(), "job.log not written immediately"
        first = http_json(BASE + f"/v1/ai-remix/jobs/{job_id}")
        assert first and first != {}, "status endpoint returned empty payload"
        final = first
        for _ in range(120):
            final = http_json(BASE + f"/v1/ai-remix/jobs/{job_id}")
            if final.get("phase") in {"completed", "failed", "timed_out"}:
                break
            time.sleep(0.5)
        assert final.get("phase") in {"completed", "failed", "timed_out"}, final
        assert final.get("message") or final.get("statusMessage") or final.get("error"), final
        print(json.dumps({"ok": True, "work_dir": str(WORK_DIR), "job_id": job_id, "final": final}, indent=2))
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

if __name__ == "__main__":
    raise SystemExit(main())
