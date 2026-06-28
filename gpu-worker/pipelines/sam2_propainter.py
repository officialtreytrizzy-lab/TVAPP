"""Smoke-test pipeline for the Modal GPU video eraser worker.

This is intentionally conservative: it proves the production path works end to
end by writing a playable MP4 to ERASER_OUTPUT_VIDEO. It does not perform object
removal yet. Replace the internals with SAM2/ProPainter once the transport path
is verified.
"""

import os
import subprocess
from pathlib import Path


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def run(cmd: list[str]) -> None:
    completed = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout[-4000:] or f"Command failed: {' '.join(cmd)}")


def main() -> None:
    input_video = Path(required_env("ERASER_INPUT_VIDEO"))
    output_video = Path(required_env("ERASER_OUTPUT_VIDEO"))
    output_video.parent.mkdir(parents=True, exist_ok=True)

    if not input_video.exists() or input_video.stat().st_size <= 0:
        raise RuntimeError(f"Input video is missing or empty: {input_video}")

    # Smoke test: rewrap/re-encode into a browser-friendly MP4 with audio preserved
    # when present. This verifies Vercel -> Modal upload, worker processing,
    # output serving, and frontend playback before we install heavy AI models.
    run([
        "ffmpeg",
        "-y",
        "-i",
        str(input_video),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        str(output_video),
    ])

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("Smoke-test pipeline did not create output video")


if __name__ == "__main__":
    main()
