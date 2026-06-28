"""First-pass real removal pipeline for the Modal video eraser worker.

This is not the final SAM2/ProPainter implementation yet. It performs an actual
mask-guided removal pass using OpenCV inpainting on every frame, then re-encodes
an MP4 with the original audio preserved when present.

Why this exists:
- The previous smoke test only proved the Vercel -> Modal -> output route.
- This version actually uses the user's mask and removes the marked region.
- The next upgrade can replace `inpaint_frame` with SAM2 mask propagation plus
  ProPainter/E2FGVI temporal inpainting without changing the worker API.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np


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


def mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask > 0)
    if len(xs) == 0 or len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def load_mask(mask_path: Path, width: int, height: int) -> np.ndarray:
    raw = cv2.imread(str(mask_path), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise RuntimeError(f"Could not read mask image: {mask_path}")

    if raw.ndim == 3 and raw.shape[2] == 4:
        alpha = raw[:, :, 3]
    elif raw.ndim == 3:
        # Fallback for RGB masks: any non-black pixel means remove.
        alpha = cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)
    else:
        alpha = raw

    if alpha.shape[1] != width or alpha.shape[0] != height:
        alpha = cv2.resize(alpha, (width, height), interpolation=cv2.INTER_NEAREST)

    mask = (alpha > 24).astype(np.uint8) * 255
    bbox = mask_bbox(mask)
    if bbox is None:
        raise RuntimeError("Uploaded mask is empty. Draw over the object before processing.")

    x1, y1, x2, y2 = bbox
    box_w = x2 - x1 + 1
    box_h = y2 - y1 + 1
    min_side = min(width, height)

    # Keep the operation tight, but give OpenCV enough edge context to remove
    # small logos/watermarks cleanly. This deliberately avoids the giant mask
    # growth that caused the loud patch in the browser pipeline.
    pad = max(3, min(18, int(max(box_w, box_h) * 0.18)))
    kernel_size = max(3, min(17, int(min_side * 0.006)))
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    mask = cv2.dilate(mask, kernel, iterations=1)

    bbox = mask_bbox(mask)
    if bbox is None:
        raise RuntimeError("Mask became empty after cleanup.")
    x1, y1, x2, y2 = bbox
    x1 = max(0, x1 - pad)
    y1 = max(0, y1 - pad)
    x2 = min(width - 1, x2 + pad)
    y2 = min(height - 1, y2 + pad)

    clipped = np.zeros_like(mask)
    clipped[y1 : y2 + 1, x1 : x2 + 1] = mask[y1 : y2 + 1, x1 : x2 + 1]
    return clipped


def inpaint_frame(frame: np.ndarray, mask: np.ndarray) -> np.ndarray:
    # Telea usually looks cleaner for small logos; NS is a fallback if the first
    # pass leaves too much edge ringing.
    result = cv2.inpaint(frame, mask, 3, cv2.INPAINT_TELEA)

    # Blend a tiny feathered edge back against the original so the repair is not
    # a hard sticker. Only the edge is feathered, not the whole filled region.
    edge = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
    edge = cv2.subtract(edge, cv2.erode(mask, np.ones((3, 3), np.uint8), iterations=1))
    if edge.max() > 0:
        alpha = cv2.GaussianBlur(edge.astype(np.float32) / 255.0, (5, 5), 0)
        alpha = alpha[:, :, None]
        result = (result.astype(np.float32) * alpha + frame.astype(np.float32) * (1.0 - alpha)).astype(np.uint8)
    return result


def extract_audio(input_video: Path, audio_path: Path) -> bool:
    try:
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(input_video),
            "-vn",
            "-acodec",
            "copy",
            str(audio_path),
        ])
        return audio_path.exists() and audio_path.stat().st_size > 0
    except Exception:
        return False


def encode_video(frames_dir: Path, audio_path: Path, has_audio: bool, fps: float, output_video: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-framerate",
        f"{fps:.6f}",
        "-i",
        str(frames_dir / "%06d.png"),
    ]
    if has_audio:
        cmd += ["-i", str(audio_path)]
    cmd += [
        "-map",
        "0:v:0",
    ]
    if has_audio:
        cmd += ["-map", "1:a:0"]
    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "160k", "-shortest"]
    cmd += [str(output_video)]
    run(cmd)


def main() -> None:
    input_video = Path(required_env("ERASER_INPUT_VIDEO"))
    input_mask = Path(required_env("ERASER_INPUT_MASK"))
    output_video = Path(required_env("ERASER_OUTPUT_VIDEO"))
    output_video.parent.mkdir(parents=True, exist_ok=True)

    if not input_video.exists() or input_video.stat().st_size <= 0:
        raise RuntimeError(f"Input video is missing or empty: {input_video}")
    if not input_mask.exists() or input_mask.stat().st_size <= 0:
        raise RuntimeError(f"Input mask is missing or empty: {input_mask}")

    work_dir = output_video.parent
    frames_dir = work_dir / "inpainted_frames"
    audio_path = work_dir / "audio_track.m4a"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(input_video))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {input_video}")

    fps = cap.get(cv2.CAP_PROP_FPS) or float(os.environ.get("ERASER_FPS", "24") or 24)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width <= 0 or height <= 0:
        raise RuntimeError("Could not read video dimensions")

    mask = load_mask(input_mask, width, height)

    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        repaired = inpaint_frame(frame, mask)
        cv2.imwrite(str(frames_dir / f"{index:06d}.png"), repaired)
        index += 1
    cap.release()

    if index == 0:
        raise RuntimeError("No frames decoded from input video")

    has_audio = extract_audio(input_video, audio_path)
    encode_video(frames_dir, audio_path, has_audio, fps, output_video)

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("Inpainting pipeline did not create output video")


if __name__ == "__main__":
    main()
