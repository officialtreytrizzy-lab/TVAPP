"""Tracked-mask ProPainter pipeline for the Modal video eraser worker.

The first production worker used a single static PNG mask for every frame,
which is fine for logos but drifts badly for moving objects. This pipeline now
uses the user-selected frame/time as the anchor, tracks the masked patch forward
and backward with local template matching, writes a frame-wise mask folder, and
passes that folder into ProPainter.

It still preserves the source video's resolution, frame rate, and audio. If
tracking confidence drops on a frame, the previous mask is reused instead of
jumping to the wrong region.
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


def read_video_gray_frames(input_video: Path) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(input_video))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video for tracking: {input_video}")

    frames: list[np.ndarray] = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        frames.append(gray)
    cap.release()

    if not frames:
        raise RuntimeError("No frames could be read for mask tracking")
    return frames


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


def clean_int(value: str | None, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(round(float(str(value))))
    except Exception:
        parsed = fallback
    return max(min(parsed, maximum), minimum)


def selected_frame_index(fps: float, frame_count: int) -> int:
    raw_index = os.environ.get("ERASER_SELECTED_FRAME_INDEX", "").strip()
    raw_time = os.environ.get("ERASER_SELECTED_TIME", "").strip()

    if raw_index:
        return clean_int(raw_index, 0, 0, max(frame_count - 1, 0))

    try:
        seconds = float(raw_time or "0")
        return clean_int(str(seconds * fps), 0, 0, max(frame_count - 1, 0))
    except Exception:
        return 0


def read_mask_alpha(mask_path: Path, width: int, height: int) -> np.ndarray:
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

    return alpha


def clean_remove_mask(alpha: np.ndarray, width: int, height: int) -> np.ndarray:
    mask = (alpha > 24).astype(np.uint8) * 255
    bbox = mask_bbox(mask)
    if bbox is None:
        raise RuntimeError("Uploaded mask is empty. Draw over the object before processing.")

    x1, y1, x2, y2 = bbox
    box_w = x2 - x1 + 1
    box_h = y2 - y1 + 1
    min_side = min(width, height)

    # Cover the whole marked object, not just the exact brush stroke. This is
    # intentionally conservative because ProPainter needs a full remove region.
    pad = max(4, min(28, int(max(box_w, box_h) * 0.25)))
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
    return clipped


def expand_bbox(bbox: tuple[int, int, int, int], width: int, height: int, ratio: float = 0.45) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    box_w = x2 - x1 + 1
    box_h = y2 - y1 + 1
    pad = max(8, int(max(box_w, box_h) * ratio))
    return max(0, x1 - pad), max(0, y1 - pad), min(width - 1, x2 + pad), min(height - 1, y2 + pad)


def crop(gray: np.ndarray, bbox: tuple[int, int, int, int]) -> np.ndarray:
    x1, y1, x2, y2 = bbox
    return gray[y1 : y2 + 1, x1 : x2 + 1]


def shift_mask(mask: np.ndarray, dx: int, dy: int, width: int, height: int) -> np.ndarray:
    if dx == 0 and dy == 0:
        return mask.copy()
    matrix = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(mask, matrix, (width, height), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def track_next_mask(
    prev_frame: np.ndarray,
    next_frame: np.ndarray,
    prev_mask: np.ndarray,
    width: int,
    height: int,
) -> tuple[np.ndarray, float]:
    bbox = mask_bbox(prev_mask)
    if bbox is None:
        return prev_mask.copy(), 0.0

    template_bbox = expand_bbox(bbox, width, height, ratio=0.45)
    template = crop(prev_frame, template_bbox)
    if template.shape[0] < 6 or template.shape[1] < 6:
        return prev_mask.copy(), 0.0

    x1, y1, x2, y2 = template_bbox
    template_w = x2 - x1 + 1
    template_h = y2 - y1 + 1
    motion_radius = max(32, min(260, int(max(template_w, template_h) * 1.15)))

    sx1 = max(0, x1 - motion_radius)
    sy1 = max(0, y1 - motion_radius)
    sx2 = min(width - 1, x2 + motion_radius)
    sy2 = min(height - 1, y2 + motion_radius)
    search = next_frame[sy1 : sy2 + 1, sx1 : sx2 + 1]

    if search.shape[0] < template.shape[0] or search.shape[1] < template.shape[1]:
        return prev_mask.copy(), 0.0

    # Stabilize contrast. This improves tracking on dark phone videos and clips
    # with soft compression, without adding extra dependencies.
    template_eq = cv2.equalizeHist(template)
    search_eq = cv2.equalizeHist(search)

    result = cv2.matchTemplate(search_eq, template_eq, cv2.TM_CCOEFF_NORMED)
    _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(result)
    if not np.isfinite(max_val) or max_val < 0.14:
        return prev_mask.copy(), float(max_val if np.isfinite(max_val) else 0.0)

    new_x1 = sx1 + max_loc[0]
    new_y1 = sy1 + max_loc[1]
    dx = int(round(new_x1 - x1))
    dy = int(round(new_y1 - y1))

    # Prevent one bad match from jumping across the clip.
    max_step = max(24, int(max(template_w, template_h) * 1.35))
    dx = max(-max_step, min(max_step, dx))
    dy = max(-max_step, min(max_step, dy))
    return shift_mask(prev_mask, dx, dy, width, height), float(max_val)


def build_tracked_masks(source_mp4: Path, input_mask: Path, output_dir: Path, fps: float, width: int, height: int) -> Path:
    frames = read_video_gray_frames(source_mp4)
    alpha = read_mask_alpha(input_mask, width, height)
    base_mask = clean_remove_mask(alpha, width, height)
    anchor = selected_frame_index(fps, len(frames))

    masks: list[np.ndarray | None] = [None] * len(frames)
    masks[anchor] = base_mask

    scores: list[float] = []

    # Track forward from the selected frame.
    prev_mask = base_mask
    for idx in range(anchor + 1, len(frames)):
        next_mask, score = track_next_mask(frames[idx - 1], frames[idx], prev_mask, width, height)
        masks[idx] = next_mask
        prev_mask = next_mask
        scores.append(score)

    # Track backward from the selected frame.
    prev_mask = base_mask
    for idx in range(anchor - 1, -1, -1):
        next_mask, score = track_next_mask(frames[idx + 1], frames[idx], prev_mask, width, height)
        masks[idx] = next_mask
        prev_mask = next_mask
        scores.append(score)

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    for idx, mask in enumerate(masks):
        if mask is None:
            mask = base_mask
        cv2.imwrite(str(output_dir / f"{idx:05d}.png"), mask)

    avg_score = sum(scores) / len(scores) if scores else 1.0
    print(
        f"Tracked remove mask sequence: frames={len(frames)} anchor={anchor} avg_match={avg_score:.3f} dir={output_dir}",
        flush=True,
    )
    return output_dir


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


def run_propainter(source_mp4: Path, mask_path: Path, result_root: Path, width: int, height: int, quality: str) -> Path:
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
            str(mask_path),
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
    mask_dir = work_dir / "tracked_remove_masks"
    result_root = work_dir / "propainter_results"

    prepare_source_mp4(input_video, source_mp4)
    fps, width, height = read_video_meta(source_mp4)
    tracked_masks = build_tracked_masks(source_mp4, input_mask, mask_dir, fps, width, height)
    inpainted = run_propainter(source_mp4, tracked_masks, result_root, width, height, output_quality)
    mux_audio(inpainted, source_mp4, output_video, width, height, fps, output_quality)

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("ProPainter pipeline did not create output video")


if __name__ == "__main__":
    main()
