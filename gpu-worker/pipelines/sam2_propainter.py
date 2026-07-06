"""Static-mask ProPainter pipeline for the Modal video eraser worker.

This version targets fixed logo/watermark cleanup first. It prepares the
uploaded mask as a static video mask, calls ProPainter, then restores the result
back to the source video's resolution, frame rate, and audio. The frontend can
request either source-quality export or a higher-quality/lower-compression MP4.
"""

from __future__ import annotations

import json
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


def run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout[-6000:] or f"Command failed: {' '.join(cmd)}")
    return completed.stdout


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


def ffprobe_json(input_video: Path) -> dict:
    try:
        out = run([
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(input_video),
        ])
        return json.loads(out)
    except Exception:
        return {}


def source_video_bitrate(input_video: Path) -> int | None:
    meta = ffprobe_json(input_video)
    for stream in meta.get("streams", []):
        if stream.get("codec_type") == "video":
            bit_rate = stream.get("bit_rate")
            if bit_rate and str(bit_rate).isdigit():
                return int(bit_rate)
    bit_rate = meta.get("format", {}).get("bit_rate")
    if bit_rate and str(bit_rate).isdigit():
        return int(bit_rate)
    return None


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
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
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


def processing_size(width: int, height: int, quality: str, max_side_cap: int | None = None) -> tuple[int, int]:
    # Default to source dimensions for 720x1280-style clips so ProPainter does
    # not unnecessarily downgrade the render. Env override is still available
    # if a GPU needs a lower cap.
    default_max_side = max(width, height)
    if quality == "higher":
        default_max_side = max(default_max_side, 1440)
    max_side = int(os.environ.get("ERASER_PROPAINTER_MAX_SIDE", str(default_max_side)))
    if max_side_cap:
        max_side = min(max_side, max_side_cap)
    scale = min(1.0, max_side / max(width, height))
    proc_w = max(8, int(width * scale) // 8 * 8)
    proc_h = max(8, int(height * scale) // 8 * 8)
    return proc_w, proc_h


def even_dimension(value: int) -> int:
    return value if value % 2 == 0 else value - 1


def find_propainter_output(result_root: Path) -> Path:
    candidates = list(result_root.rglob("inpaint_out.mp4"))
    if not candidates:
        raise RuntimeError(f"ProPainter completed but no inpaint_out.mp4 was found under {result_root}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def export_settings(quality: str, source_bitrate: int | None) -> tuple[str, str, list[str]]:
    if quality == "higher":
        # Lower CRF = less compression. Higher mode can create a larger file,
        # but it avoids adding compression noise after inpainting.
        return "slow", "11", ["-b:a", "256k"]

    # Source mode keeps the same dimensions/fps/audio and uses a high-quality
    # encode. If source bitrate is known, avoid going below it.
    if source_bitrate and source_bitrate > 0:
        target = max(source_bitrate, 8_000_000)
        return "medium", "14", ["-b:a", "192k", "-maxrate", str(int(target * 1.35)), "-bufsize", str(int(target * 2))]
    return "medium", "14", ["-b:a", "192k"]


def mux_audio(inpainted_video: Path, source_video: Path, output_video: Path, width: int, height: int, fps: float, quality: str) -> None:
    out_w = even_dimension(width)
    out_h = even_dimension(height)
    preset, crf, audio_args = export_settings(quality, source_video_bitrate(source_video))
    vf = f"scale={out_w}:{out_h}:flags=lanczos,fps={fps:.6f}"

    try:
        cmd = [
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
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            crf,
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            *audio_args,
            "-shortest",
            str(output_video),
        ]
        run(cmd)
    except Exception:
        # No audio or mux failure: still return a playable video at source size/fps.
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(inpainted_video),
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            crf,
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output_video),
        ])


def is_cuda_oom(message: str) -> bool:
    lowered = message.lower()
    return "out of memory" in lowered or "outofmemoryerror" in lowered


def run_propainter(source_mp4: Path, mask_png: Path, result_root: Path, width: int, height: int, quality: str) -> Path:
    inference = PROPAINTER_ROOT / "inference_propainter.py"
    if not inference.exists():
        raise RuntimeError(
            f"ProPainter is not installed at {PROPAINTER_ROOT}. "
            "The Modal image must clone https://github.com/sczhou/ProPainter.git."
        )

    env = dict(os.environ)
    # Reduces fragmentation OOMs on long clips (recommended by PyTorch when
    # reserved-but-unallocated memory is large).
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    # Attempt ladder: full requested size first, then progressively smaller
    # internal processing sizes if the GPU runs out of memory. mux_audio
    # scales the result back to source dimensions, so output size/fps/audio
    # are preserved either way.
    attempts: list[tuple[int | None, str]] = [(None, "50"), (960, "30"), (720, "20")]
    last_error: RuntimeError | None = None

    for index, (max_side_cap, subvideo_length) in enumerate(attempts):
        if result_root.exists():
            shutil.rmtree(result_root)
        result_root.mkdir(parents=True, exist_ok=True)

        proc_w, proc_h = processing_size(width, height, quality, max_side_cap)
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
            subvideo_length,
            "--neighbor_length",
            "6",
            "--ref_stride",
            "10",
            "--mask_dilation",
            "4",
        ]
        try:
            run(cmd, cwd=PROPAINTER_ROOT, env=env)
            return find_propainter_output(result_root)
        except RuntimeError as exc:
            last_error = exc
            if index == len(attempts) - 1 or not is_cuda_oom(str(exc)):
                raise
            print(
                f"ProPainter ran out of GPU memory at {proc_w}x{proc_h} "
                f"(subvideo_length={subvideo_length}); retrying smaller...",
                flush=True,
            )

    raise last_error or RuntimeError("ProPainter failed without output")


def main() -> None:
    input_video = Path(required_env("ERASER_INPUT_VIDEO"))
    input_mask = Path(required_env("ERASER_INPUT_MASK"))
    output_video = Path(required_env("ERASER_OUTPUT_VIDEO"))
    output_quality = os.environ.get("ERASER_OUTPUT_QUALITY", "source").strip().lower()
    if output_quality not in {"source", "higher"}:
        output_quality = "source"
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
    fps, width, height = read_video_meta(source_mp4)
    prepare_static_mask(input_mask, mask_png, width, height)
    inpainted = run_propainter(source_mp4, mask_png, result_root, width, height, output_quality)
    mux_audio(inpainted, source_mp4, output_video, width, height, fps, output_quality)

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("ProPainter pipeline did not create output video")


if __name__ == "__main__":
    main()
