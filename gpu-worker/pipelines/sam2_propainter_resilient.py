from __future__ import annotations

"""Resilient production entrypoint for the locked SAM2 + ProPainter pipeline.

The core implementation remains in sam2_propainter.py. This entrypoint patches
three failure modes seen in production without replacing the locked SAM2 path:

1. A valid SAM2 track may become empty when the object leaves a frame. Empty
   predictions are preserved as empty masks instead of aborting the whole job.
2. ProPainter is retried with valid, progressively smaller temporal windows.
   neighbor_length is never 1 because upstream computes a zero range step.
3. Every candidate and final MP4 is checked for frame count, duration, and
   temporal motion. A failed or frozen ProPainter render is rebuilt from source
   frames with the existing tracked OpenCV inpaint fallback.
"""

import json
import os
import shutil
from pathlib import Path

import cv2
import numpy as np

import sam2_propainter as core

MIN_OUTPUT_DURATION_RATIO = float(os.environ.get("ERASER_MIN_OUTPUT_DURATION_RATIO", "0.80"))
MAX_OUTPUT_DURATION_RATIO = float(os.environ.get("ERASER_MAX_OUTPUT_DURATION_RATIO", "1.20"))
FROZEN_SOURCE_MOTION_THRESHOLD = float(os.environ.get("ERASER_SOURCE_MOTION_THRESHOLD", "0.35"))
FROZEN_OUTPUT_MOTION_RATIO = float(os.environ.get("ERASER_OUTPUT_MOTION_RATIO", "0.035"))
LONG_CLIP_PIXEL_BUDGET = max(
    8_000_000,
    int(os.environ.get("ERASER_PROPAINTER_CHUNK_PIXEL_BUDGET", "20000000")),
)
LONG_CLIP_MIN_CORE_FRAMES = max(
    12,
    int(os.environ.get("ERASER_PROPAINTER_MIN_CHUNK_FRAMES", "24")),
)
LONG_CLIP_MAX_CORE_FRAMES = max(
    LONG_CLIP_MIN_CORE_FRAMES,
    int(os.environ.get("ERASER_PROPAINTER_CHUNK_FRAMES", "120")),
)
LONG_CLIP_OVERLAP_FRAMES = max(
    2,
    int(os.environ.get("ERASER_PROPAINTER_CHUNK_OVERLAP", "6")),
)
CHUNK_MANIFEST_NAME = "propainter_chunk_boundaries.json"


class FrozenVideoError(RuntimeError):
    """The file decodes, but its frames are repeated or nearly static."""


_original_clean_mask = core.clean_mask


def resilient_clean_mask(
    mask: np.ndarray,
    width: int,
    height: int,
    pad_ratio: float = 0.18,
    *,
    allow_empty: bool = False,
) -> np.ndarray:
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    binary = (mask > 24).astype(np.uint8) * 255
    if core.mask_bbox(binary) is None:
        if allow_empty:
            return np.zeros((height, width), dtype=np.uint8)
        raise RuntimeError("Painted mask is empty")
    return _original_clean_mask(binary, width, height, pad_ratio)


def tensor_to_mask(mask_logits, width: int, height: int) -> np.ndarray:
    if isinstance(mask_logits, (list, tuple)):
        mask_logits = mask_logits[0]
    if mask_logits.dim() == 4:
        mask_logits = mask_logits[0, 0]
    elif mask_logits.dim() == 3:
        mask_logits = mask_logits[0]

    mask = (mask_logits > 0).detach().to("cpu").numpy().astype(np.uint8) * 255
    # Empty predictions are normal when the target leaves view. They should not
    # throw "Painted mask is empty" and discard the valid track built so far.
    return resilient_clean_mask(mask, width, height, 0.10, allow_empty=True)


def sam2_direction(
    predictor,
    frames_dir: Path,
    anchor: int,
    anchor_mask: np.ndarray,
    reverse: bool,
    frame_count: int,
    width: int,
    height: int,
    prompt_mode: str | None = None,
) -> dict[int, np.ndarray]:
    import torch

    state = predictor.init_state(
        video_path=str(frames_dir),
        offload_video_to_cpu=True,
        offload_state_to_cpu=True,
        async_loading_frames=False,
    )

    mode = (prompt_mode or os.environ.get("SAM2_PROMPT_MODE", "hybrid")).lower()
    if mode == "mask":
        predictor.add_new_mask(
            inference_state=state,
            frame_idx=anchor,
            obj_id=1,
            mask=anchor_mask.astype(bool),
        )
    else:
        box, points, labels = core.prompt_from_mask(anchor_mask, width, height)
        predictor.add_new_points_or_box(
            inference_state=state,
            frame_idx=anchor,
            obj_id=1,
            points=points,
            labels=labels,
            box=box,
        )

    masks: dict[int, np.ndarray] = {}
    direction = "reverse" if reverse else "forward"
    try:
        for frame_idx, _obj_ids, logits in predictor.propagate_in_video(
            inference_state=state,
            start_frame_idx=anchor,
            max_frame_num_to_track=frame_count,
            reverse=reverse,
        ):
            idx = int(frame_idx)
            if 0 <= idx < frame_count:
                masks[idx] = tensor_to_mask(logits, width, height)
    except Exception as exc:
        if not masks:
            raise
        print(
            f"SAM2 {direction} propagation stopped after {len(masks)} frames; "
            f"preserving partial masks: {exc}",
            flush=True,
        )
    finally:
        try:
            predictor.reset_state(state)
        except Exception:
            pass
        del state
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    return masks


def propainter_attempts() -> list[tuple[int, str, str, str, str]]:
    # Quality-first on A10G, then progressively reduce resolution only when
    # memory pressure requires it. Keep ProPainter's own dilation subtle.
    return [
        (960, "12", "6", "8", "1"),
        (768, "10", "4", "8", "1"),
        (640, "8", "4", "6", "1"),
        (560, "6", "2", "4", "1"),
    ]


def video_frame_count(path: Path) -> int:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return 0
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    return max(count, 0)


def video_duration(path: Path) -> float:
    payload = core.ffprobe_json(path)
    try:
        value = float(payload.get("format", {}).get("duration") or 0)
        if value > 0:
            return value
    except Exception:
        pass

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return 0.0
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    cap.release()
    return float(frames / fps) if fps > 0 else 0.0


def tracking_mask_for_motion(
    mask_dir: Path | None,
    frame_index: int,
    source_width: int,
    source_height: int,
) -> np.ndarray | None:
    if mask_dir is None or not mask_dir.is_dir():
        return None
    mask = cv2.imread(str(mask_dir / f"{frame_index:05d}.png"), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        return None
    if mask.shape[1] != source_width or mask.shape[0] != source_height:
        mask = cv2.resize(mask, (source_width, source_height), interpolation=cv2.INTER_NEAREST)
    mask = (mask > 24).astype(np.uint8) * 255
    if core.mask_bbox(mask) is None:
        return None
    # Ignore a narrow guard ring around the replacement so inpainting-edge
    # changes are not mistaken for scene motion.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    return cv2.dilate(mask, kernel, iterations=1)


def temporal_motion_score(
    path: Path,
    sample_count: int = 10,
    mask_dir: Path | None = None,
) -> float:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return 0.0

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    source_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    source_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if frame_count < 2 or source_width <= 0 or source_height <= 0:
        cap.release()
        return 0.0

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    gap = max(1, min(frame_count - 1, int(round(fps * 0.25))))
    last_start = max(frame_count - gap - 1, 0)
    indexes = sorted(
        set(
            int(round(value))
            for value in np.linspace(0, last_start, min(sample_count, last_start + 1))
        )
    )
    scores: list[float] = []

    for idx in indexes:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok_a, frame_a = cap.read()
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx + gap)
        ok_b, frame_b = cap.read()
        if not ok_a or not ok_b:
            continue

        frame_a = cv2.resize(frame_a, (160, 90), interpolation=cv2.INTER_AREA)
        frame_b = cv2.resize(frame_b, (160, 90), interpolation=cv2.INTER_AREA)
        gray_a = cv2.cvtColor(frame_a, cv2.COLOR_BGR2GRAY)
        gray_b = cv2.cvtColor(frame_b, cv2.COLOR_BGR2GRAY)
        delta = cv2.absdiff(gray_a, gray_b)

        mask_a = tracking_mask_for_motion(mask_dir, idx, source_width, source_height)
        mask_b = tracking_mask_for_motion(mask_dir, idx + gap, source_width, source_height)
        if mask_a is not None or mask_b is not None:
            if mask_a is None:
                mask_a = np.zeros((source_height, source_width), dtype=np.uint8)
            if mask_b is None:
                mask_b = np.zeros((source_height, source_width), dtype=np.uint8)
            excluded = cv2.bitwise_or(mask_a, mask_b)
            excluded = cv2.resize(excluded, (160, 90), interpolation=cv2.INTER_NEAREST) > 24
            valid = ~excluded
            if int(np.count_nonzero(valid)) >= int(valid.size * 0.20):
                scores.append(float(delta[valid].mean()))
                continue

        scores.append(float(delta.mean()))

    cap.release()
    return float(sum(scores) / len(scores)) if scores else 0.0


def validate_video_liveness(
    source_video: Path,
    candidate_video: Path,
    label: str,
    mask_dir: Path | None = None,
) -> dict[str, float]:
    if not candidate_video.exists() or candidate_video.stat().st_size <= 0:
        raise RuntimeError(f"{label} is missing or empty")

    source_frames = video_frame_count(source_video)
    candidate_frames = video_frame_count(candidate_video)
    if candidate_frames < 2:
        raise FrozenVideoError(f"{label} contains fewer than two decodable frames")

    source_duration = video_duration(source_video)
    candidate_duration = video_duration(candidate_video)
    if source_duration > 0 and candidate_duration > 0:
        ratio = candidate_duration / source_duration
        if ratio < MIN_OUTPUT_DURATION_RATIO or ratio > MAX_OUTPUT_DURATION_RATIO:
            raise RuntimeError(
                f"{label} duration mismatch: source={source_duration:.3f}s "
                f"output={candidate_duration:.3f}s ratio={ratio:.3f}"
            )

    if source_frames > 2 and candidate_frames < max(2, int(source_frames * 0.75)):
        raise RuntimeError(
            f"{label} lost too many frames: source={source_frames} output={candidate_frames}"
        )

    # Measure liveness outside the tracked removal region. A correct eraser
    # result may become nearly static when the selected object was the only
    # moving element in the shot; that is valid, not a frozen render.
    source_motion = temporal_motion_score(source_video, mask_dir=mask_dir)
    candidate_motion = temporal_motion_score(candidate_video, mask_dir=mask_dir)
    frozen_limit = max(0.02 if mask_dir is not None else 0.05, source_motion * FROZEN_OUTPUT_MOTION_RATIO)
    if source_motion >= FROZEN_SOURCE_MOTION_THRESHOLD and candidate_motion <= frozen_limit:
        raise FrozenVideoError(
            f"{label} appears frozen: source_motion={source_motion:.4f} "
            f"output_motion={candidate_motion:.4f}"
        )

    stats = {
        "source_frames": float(source_frames),
        "candidate_frames": float(candidate_frames),
        "source_duration": source_duration,
        "candidate_duration": candidate_duration,
        "source_motion": source_motion,
        "candidate_motion": candidate_motion,
        "motion_scope": "outside_tracked_mask" if mask_dir is not None else "full_frame",
    }
    print(f"{label} liveness validated: {json.dumps(stats, sort_keys=True)}", flush=True)
    return stats


def long_clip_chunk_plan(
    frame_count: int,
    width: int,
    height: int,
    quality: str,
) -> dict[str, int | bool]:
    first_cap = propainter_attempts()[0][0]
    proc_w, proc_h = core.processing_size(width, height, quality, first_cap)
    pixels_per_frame = max(proc_w * proc_h, 1)
    max_context_frames = max(18, LONG_CLIP_PIXEL_BUDGET // pixels_per_frame)
    overlap = min(
        LONG_CLIP_OVERLAP_FRAMES,
        max(2, (max_context_frames - 12) // 2),
    )
    core_frames = max_context_frames - (overlap * 2)
    core_frames = max(LONG_CLIP_MIN_CORE_FRAMES, min(core_frames, LONG_CLIP_MAX_CORE_FRAMES))
    should_chunk = frame_count > max_context_frames
    return {
        "chunked": should_chunk,
        "core_frames": core_frames,
        "overlap_frames": overlap,
        "max_context_frames": core_frames + (overlap * 2),
        "processing_width": proc_w,
        "processing_height": proc_h,
        "pixels_per_frame": pixels_per_frame,
    }


def run_propainter_single(
    source_mp4: Path,
    mask_path: Path,
    result_root: Path,
    width: int,
    height: int,
    quality: str,
    label_prefix: str = "ProPainter",
) -> Path:
    inference = core.PROPAINTER_ROOT / "inference_propainter.py"
    if not inference.exists():
        raise RuntimeError(f"ProPainter is not installed at {core.PROPAINTER_ROOT}")

    env = dict(os.environ)
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True,max_split_size_mb:128")
    attempts = propainter_attempts()
    errors: list[str] = []

    for index, (max_side_cap, subvideo_length, neighbor_length, ref_stride, mask_dilation) in enumerate(attempts):
        if result_root.exists():
            shutil.rmtree(result_root)
        result_root.mkdir(parents=True, exist_ok=True)

        proc_w, proc_h = core.processing_size(width, height, quality, max_side_cap)
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
            neighbor_length,
            "--ref_stride",
            ref_stride,
            "--mask_dilation",
            mask_dilation,
        ]

        try:
            print(
                f"Running {label_prefix} attempt {index + 1}/{len(attempts)}: "
                f"{proc_w}x{proc_h}, subvideo={subvideo_length}, neighbor={neighbor_length}",
                flush=True,
            )
            core.run(cmd, cwd=core.PROPAINTER_ROOT, env=env)
            candidate = core.find_propainter_output(result_root)
            validate_video_liveness(
                source_mp4,
                candidate,
                f"{label_prefix} attempt {index + 1}",
                mask_path,
            )
            return candidate
        except RuntimeError as exc:
            message = str(exc)
            errors.append(message[-2000:])
            reason = "CUDA OOM" if core.is_cuda_oom(message) else exc.__class__.__name__
            action = "retrying smaller" if index < len(attempts) - 1 else "failing this segment"
            print(
                f"{label_prefix} attempt {index + 1} failed ({reason}); {action}: {message[-900:]}",
                flush=True,
            )

    raise RuntimeError(
        f"{label_prefix} failed all resilient attempts:\n" + "\n---\n".join(errors[-2:])
    )


def trim_propainter_chunk(
    candidate: Path,
    destination: Path,
    keep_start: int,
    keep_end: int,
) -> Path:
    if keep_end <= keep_start:
        raise RuntimeError(
            f"Invalid ProPainter chunk trim: start={keep_start}, end={keep_end}"
        )
    core.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(candidate),
            "-vf",
            f"trim=start_frame={keep_start}:end_frame={keep_end},setpts=PTS-STARTPTS",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(destination),
        ]
    )
    expected = keep_end - keep_start
    actual = video_frame_count(destination)
    if actual < max(1, expected - 1) or actual > expected + 1:
        raise RuntimeError(
            f"Trimmed ProPainter chunk frame mismatch: expected={expected}, actual={actual}"
        )
    return destination


def run_propainter_chunked(
    source_mp4: Path,
    mask_path: Path,
    result_root: Path,
    width: int,
    height: int,
    quality: str,
    plan: dict[str, int | bool],
) -> Path:
    frame_count = video_frame_count(source_mp4)
    core_frames = int(plan["core_frames"])
    overlap = int(plan["overlap_frames"])
    chunk_workspace = result_root.parent / "propainter_chunk_work"
    if chunk_workspace.exists():
        shutil.rmtree(chunk_workspace)
    chunk_workspace.mkdir(parents=True, exist_ok=True)

    outputs: list[Path] = []
    boundaries: list[int] = []
    chunk_total = (frame_count + core_frames - 1) // core_frames
    print(
        "Long high-resolution clip detected; using overlapping memory-safe ProPainter segments: "
        f"frames={frame_count}, chunks={chunk_total}, core_frames={core_frames}, "
        f"overlap={overlap}, processing={plan['processing_width']}x{plan['processing_height']}",
        flush=True,
    )

    for chunk_index, core_start in enumerate(range(0, frame_count, core_frames), start=1):
        core_end = min(frame_count, core_start + core_frames)
        context_start = max(0, core_start - overlap)
        context_end = min(frame_count, core_end + overlap)
        chunk_root = chunk_workspace / f"chunk_{chunk_index:03d}"
        chunk_video, chunk_masks = core.make_propainter_chunk(
            source_mp4,
            mask_path,
            chunk_root,
            context_start,
            context_end,
        )
        print(
            f"Running memory-safe ProPainter segment {chunk_index}/{chunk_total}: "
            f"context={context_start}-{context_end - 1}, keep={core_start}-{core_end - 1}",
            flush=True,
        )
        candidate = run_propainter_single(
            chunk_video,
            chunk_masks,
            chunk_root / "results",
            width,
            height,
            quality,
            f"ProPainter segment {chunk_index}/{chunk_total}",
        )
        keep_start = core_start - context_start
        keep_end = keep_start + (core_end - core_start)
        completed = trim_propainter_chunk(
            candidate,
            chunk_root / "completed.mp4",
            keep_start,
            keep_end,
        )
        outputs.append(completed)
        if core_end < frame_count:
            boundaries.append(core_end)

    joined = result_root.parent / "propainter_chunked_joined.mp4"
    if joined.exists():
        joined.unlink()
    core.concatenate_propainter_chunks(outputs, joined)
    manifest = {
        "frame_count": frame_count,
        "core_frames": core_frames,
        "overlap_frames": overlap,
        "boundaries": boundaries,
        "chunk_count": len(outputs),
        "processing_width": int(plan["processing_width"]),
        "processing_height": int(plan["processing_height"]),
    }
    (result_root.parent / CHUNK_MANIFEST_NAME).write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    validate_video_liveness(source_mp4, joined, "Chunked ProPainter output", mask_path)
    return joined


def run_propainter(
    source_mp4: Path,
    mask_path: Path,
    result_root: Path,
    width: int,
    height: int,
    quality: str,
) -> Path:
    frame_count = video_frame_count(source_mp4)
    if frame_count <= 0:
        raise RuntimeError("Could not determine ProPainter source frame count")
    plan = long_clip_chunk_plan(frame_count, width, height, quality)
    manifest_path = result_root.parent / CHUNK_MANIFEST_NAME
    if manifest_path.exists():
        manifest_path.unlink()
    if bool(plan["chunked"]):
        return run_propainter_chunked(
            source_mp4,
            mask_path,
            result_root,
            width,
            height,
            quality,
            plan,
        )
    return run_propainter_single(
        source_mp4,
        mask_path,
        result_root,
        width,
        height,
        quality,
    )


def run_opencv_tracked_inpaint(source_mp4: Path, mask_dir: Path, work_dir: Path, fps: float) -> Path:
    fallback_dir = work_dir / "opencv_tracked_inpaint"
    if fallback_dir.exists():
        shutil.rmtree(fallback_dir)
    fallback_dir.mkdir(parents=True, exist_ok=True)

    raw_output = fallback_dir / "opencv_raw.mp4"
    normalized_output = fallback_dir / "opencv_h264.mp4"

    cap = cv2.VideoCapture(str(source_mp4))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open source video for tracked fallback: {source_mp4}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fallback_fps = fps if fps and fps > 0 else cap.get(cv2.CAP_PROP_FPS) or 30.0
    writer = cv2.VideoWriter(
        str(raw_output),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fallback_fps,
        (width, height),
    )
    if not writer.isOpened():
        cap.release()
        raise RuntimeError("Could not open tracked fallback video writer")

    frame_index = 0
    written = 0
    changes: list[float] = []

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        mask = cv2.imread(str(mask_dir / f"{frame_index:05d}.png"), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            mask = np.zeros((height, width), dtype=np.uint8)
        elif mask.shape[1] != width or mask.shape[0] != height:
            mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)

        mask = (mask > 24).astype(np.uint8) * 255
        if core.mask_bbox(mask) is not None:
            close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel, iterations=1)
            radius = max(3, min(7, int(max(width, height) * 0.006)))
            telea = cv2.inpaint(frame, mask, radius, cv2.INPAINT_TELEA)
            ns = cv2.inpaint(frame, mask, radius, cv2.INPAINT_NS)
            telea_score = float(cv2.absdiff(frame, telea)[mask > 24].mean())
            ns_score = float(cv2.absdiff(frame, ns)[mask > 24].mean())
            valid = [(telea_score, telea), (ns_score, ns)]
            valid = [item for item in valid if item[0] >= core.UNCHANGED_THRESHOLD]
            if not valid:
                raise RuntimeError("Tracked OpenCV fallback could not remove the selected region cleanly")
            score, candidate = min(valid, key=lambda item: item[0])
            frame = candidate
            changes.append(score)

        writer.write(frame)
        frame_index += 1
        written += 1

    cap.release()
    writer.release()

    if written <= 0 or not raw_output.exists() or raw_output.stat().st_size <= 0:
        raise RuntimeError("Tracked fallback did not write any frames")

    avg_change = sum(changes) / len(changes) if changes else 0.0
    print(f"Tracked fallback wrote frames={written} avg_mask_change={avg_change:.3f}", flush=True)

    try:
        core.run([
            "ffmpeg",
            "-y",
            "-fflags",
            "+genpts",
            "-i",
            str(raw_output),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "16",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
            str(normalized_output),
        ])
        validate_video_liveness(source_mp4, normalized_output, "Tracked fallback", mask_dir)
        return normalized_output
    except Exception as exc:
        print(f"Tracked fallback normalization failed; validating raw MP4: {exc}", flush=True)
        validate_video_liveness(source_mp4, raw_output, "Raw tracked fallback", mask_dir)
        return raw_output


def main() -> None:
    input_video = Path(core.required_env("ERASER_INPUT_VIDEO"))
    input_mask = Path(core.required_env("ERASER_INPUT_MASK"))
    output_video = Path(core.required_env("ERASER_OUTPUT_VIDEO"))

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
    mask_dir = work_dir / "sam2_remove_masks"
    result_root = work_dir / "propainter_results"

    core.prepare_source_mp4(input_video, source_mp4)
    fps, width, height = core.read_video_meta(source_mp4)

    # Validate the painted mask before either model starts.
    resilient_clean_mask(core.read_mask_alpha(input_mask, width, height), width, height, 0.18)
    tracked_masks = core.build_tracked_masks(source_mp4, input_mask, mask_dir, fps, width, height)

    allow_opencv_fallback = os.environ.get("ERASER_ALLOW_OPENCV_FALLBACK", "false").lower() == "true"
    used_fallback = False
    try:
        inpainted = run_propainter(source_mp4, tracked_masks, result_root, width, height, output_quality)
        change_score = core.masked_change_score(source_mp4, inpainted, tracked_masks, width, height)
        print(f"ProPainter masked-region change score={change_score:.3f}", flush=True)
    except RuntimeError as exc:
        if not allow_opencv_fallback:
            raise RuntimeError(
                "ProPainter failed and the low-quality OpenCV patch fallback is disabled"
            ) from exc
        used_fallback = True
        print(f"ProPainter failed; using explicitly enabled tracked fallback: {exc}", flush=True)
        inpainted = run_opencv_tracked_inpaint(source_mp4, tracked_masks, work_dir, fps)

    core.mux_audio(inpainted, source_mp4, output_video, width, height, fps, output_quality)

    try:
        validate_video_liveness(source_mp4, output_video, "Final eraser output", tracked_masks)
    except RuntimeError as exc:
        if used_fallback:
            raise
        print(
            f"Final ProPainter composite was invalid; rebuilding from source frames: {exc}",
            flush=True,
        )
        inpainted = run_opencv_tracked_inpaint(source_mp4, tracked_masks, work_dir, fps)
        core.mux_audio(inpainted, source_mp4, output_video, width, height, fps, output_quality)
        validate_video_liveness(source_mp4, output_video, "Final fallback output", tracked_masks)

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("Eraser pipeline did not create output video")


# Patch the locked core module's global lookups before it builds masks.
core.clean_mask = resilient_clean_mask
core.tensor_to_mask = tensor_to_mask
core.sam2_direction = sam2_direction
core.run_propainter = run_propainter
core.run_opencv_tracked_inpaint = run_opencv_tracked_inpaint


if __name__ == "__main__":
    main()
