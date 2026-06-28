"""Static-mask ProPainter pipeline for the Modal video eraser worker.

This version targets the current failing case: a small fixed sparkle/logo near
the bottom-right of the video. It prepares the uploaded mask as a static video
mask, calls the real ProPainter inference script when available, and muxes the
result back with the original audio.

For moving objects, the next layer is SAM2 mask propagation before this
ProPainter step. For fixed logos/watermarks, this static mask path is the right
first production route.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

PROPAINTER_ROOT = Path(os.environ.get("PROPAINTER_ROOT", "/opt/ProPainter"))


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def run(cmd: list[str], cwd: Path | None = None) -> None:
    completed = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout[-6000:] or f"Command failed: {' '.join(cmd)}")


def mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask > 0)
    if len(xs) == 0 or len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def read_video_meta(input_video: Path) -> tuple[float, int, int]:
    cap = cv2.VideoCapture(str(input_video))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {input_video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or float(os.environ.get("ERASER_FPS", "24") or 24)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    if width <= 0 or height <= 0:
        raise RuntimeError("Could not read video dimensions")
    return fps, width, height


def prepare_source_mp4(input_video: Path, source_mp4: Path) -> None:
    if source_mp4.exists():
        source_mp4.unlink()
    try:
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(input_video),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c",
            "copy",
            str(source_mp4),
        ])
    except Exception:
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
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            str(source_mp4),
        ])



def prepare_static_mask(mask_path: Path, output_mask: Path, width: int, height: int) -> None:
    raw = cv2.imread(str(mask_path), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise RuntimeError(f"Could not read mask image: {mask_path}")

    if raw.ndim == 3 and raw.shape[2] == 4:
        alpha = raw[:, :, 3]
    elif raw.ndim == 3:
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

    # Fixed logo/static-mark path: keep it local but make sure the full mark is
    # covered. ProPainter handles the fill; this just defines the remove area.
    pad = max(4, min(24, int(max(box_w, box_h) * 0.22)))
    kernel_size = max(3, min(19, int(min_side * 0.008)))
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
    cv2.imwrite(str(output_mask), clipped)


def processing_size(width: int, height: int) -> tuple[int, int]:
    # ProPainter memory requirements are high. Keep vertical clips reasonable for
    # A10G while preserving aspect ratio. Values must be divisible by 8.
    max_side = int(os.environ.get("ERASER_PROPAINTER_MAX_SIDE", "768"))
    scale = min(1.0, max_side / max(width, height))
    proc_w = max(8, int(width * scale) // 8 * 8)
    proc_h = max(8, int(height * scale) // 8 * 8)
    return proc_w, proc_h


def find_propainter_output(result_root: Path) -> Path:
    candidates = list(result_root.rglob("inpaint_out.mp4"))
    if not candidates:
        raise RuntimeError(f"ProPainter completed but no inpaint_out.mp4 was found under {result_root}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def mux_audio(inpainted_video: Path, source_video: Path, output_video: Path) -> None:
    try:
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(inpainted_video),
            "-i",
            str(source_video),
            "-map",
            "0:v:0",
            "-map",
            "1:a?",
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
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            str(output_video),
        ])
    except Exception:
        # No audio or mux failure: still return playable video.
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(inpainted_video),
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
            str(output_video),
        ])


def run_propainter(source_mp4: Path, mask_png: Path, result_root: Path, width: int, height: int) -> Path:
    inference = PROPAINTER_ROOT / "inference_propainter.py"
    if not inference.exists():
        raise RuntimeError(
            f"ProPainter is not installed at {PROPAINTER_ROOT}. "
            "The Modal image must clone https://github.com/sczhou/ProPainter.git."
        )

    if result_root.exists():
        shutil.rmtree(result_root)
    result_root.mkdir(parents=True, exist_ok=True)

    proc_w, proc_h = processing_size(width, height)
    cmd = [
        "python",
        str(inference),
        "--video",
        str(source_mp4),
        "--mask",
        str(mask_png),
        "--output",
        str(result_root),
        "--height",
        str(proc_h),
        "--width",
        str(proc_w),
        "--fp16",
        "--subvideo_length",
        "50",
        "--neighbor_length",
        "6",
        "--ref_stride",
        "10",
        "--mask_dilation",
        "4",
    ]
    run(cmd, cwd=PROPAINTER_ROOT)
    return find_propainter_output(result_root)


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
    source_mp4 = work_dir / "source_for_propainter.mp4"
    mask_png = work_dir / "static_remove_mask.png"
    result_root = work_dir / "propainter_results"

    prepare_source_mp4(input_video, source_mp4)
    _fps, width, height = read_video_meta(source_mp4)
    prepare_static_mask(input_mask, mask_png, width, height)
    inpainted = run_propainter(source_mp4, mask_png, result_root, width, height)
    mux_audio(inpainted, source_mp4, output_video)

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("ProPainter pipeline did not create output video")


if __name__ == "__main__":
    main()
