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
) -> dict[int, np.ndarray]:
    import torch

    state = predictor.init_state(
        video_path=str(frames_dir),
        offload_video_to_cpu=True,
        offload_state_to_cpu=True,
        async_loading_frames=False,
    )

    mode = os.environ.get("SAM2_PROMPT_MODE", "box").lower()
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
    # Upstream uses neighbor_stride = neighbor_length // 2. neighbor_length=1
    # therefore crashes with range() arg 3 must not be zero.
    return [
        (640, "12", "6", "8", "3"),
        (560, "10", "4", "8", "3"),
        (480, "8", "4", "6", "2"),
        (384, "6", "2", "4", "2"),
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


def temporal_motion_score(path: Path, sample_count: int = 10) -> float:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return 0.0

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frame_count < 2:
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
        scores.append(float(cv2.absdiff(gray_a, gray_b).mean()))

    cap.release()
    return float(sum(scores) / len(scores)) if scores else 0.0


def validate_video_liveness(source_video: Path, candidate_video: Path, label: str) -> dict[str, float]:
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

    source_motion = temporal_motion_score(source_video)
    candidate_motion = temporal_motion_score(candidate_video)
    frozen_limit = max(0.05, source_motion * FROZEN_OUTPUT_MOTION_RATIO)
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
    }
    print(f"{label} liveness validated: {json.dumps(stats, sort_keys=True)}", flush=True)
    return stats


def run_propainter(
    source_mp4: Path,
    mask_path: Path,
    result_root: Path,
    width: int,
    height: int,
    quality: str,
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
                f"Running resilient ProPainter attempt {index + 1}/{len(attempts)}: "
                f"{proc_w}x{proc_h}, subvideo={subvideo_length}, neighbor={neighbor_length}",
                flush=True,
            )
            core.run(cmd, cwd=core.PROPAINTER_ROOT, env=env)
            candidate = core.find_propainter_output(result_root)
            validate_video_liveness(source_mp4, candidate, f"ProPainter attempt {index + 1}")
            return candidate
        except RuntimeError as exc:
            message = str(exc)
            errors.append(message[-2000:])
            reason = "CUDA OOM" if core.is_cuda_oom(message) else exc.__class__.__name__
            action = "retrying smaller" if index < len(attempts) - 1 else "using tracked fallback"
            print(
                f"ProPainter attempt {index + 1} failed ({reason}); {action}: {message[-900:]}",
                flush=True,
            )

    raise RuntimeError("ProPainter failed all resilient attempts:\n" + "\n---\n".join(errors[-2:]))


def force_visible_fill(frame: np.ndarray, mask: np.ndarray) -> np.ndarray:
    k = max(31, min(91, (max(frame.shape[:2]) // 20) | 1))
    if k % 2 == 0:
        k += 1
    blurred = cv2.GaussianBlur(frame, (k, k), 0)
    out = frame.copy()
    out[mask > 24] = blurred[mask > 24]
    return out


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

        mask = resilient_clean_mask(mask, width, height, 0.12, allow_empty=True)
        if core.mask_bbox(mask) is not None:
            radius = max(5, min(14, int(max(width, height) * 0.012)))
            telea = cv2.inpaint(frame, mask, radius, cv2.INPAINT_TELEA)
            ns = cv2.inpaint(frame, mask, radius, cv2.INPAINT_NS)
            telea_score = float(cv2.absdiff(frame, telea)[mask > 24].mean())
            ns_score = float(cv2.absdiff(frame, ns)[mask > 24].mean())
            candidate = telea if telea_score >= ns_score else ns
            score = max(telea_score, ns_score)

            if score < core.UNCHANGED_THRESHOLD:
                candidate = force_visible_fill(candidate, mask)
                score = float(cv2.absdiff(frame, candidate)[mask > 24].mean())

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
        validate_video_liveness(source_mp4, normalized_output, "Tracked fallback")
        return normalized_output
    except Exception as exc:
        print(f"Tracked fallback normalization failed; validating raw MP4: {exc}", flush=True)
        validate_video_liveness(source_mp4, raw_output, "Raw tracked fallback")
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

    used_fallback = False
    try:
        inpainted = run_propainter(source_mp4, tracked_masks, result_root, width, height, output_quality)
        change_score = core.masked_change_score(source_mp4, inpainted, tracked_masks, width, height)
        print(f"ProPainter masked-region change score={change_score:.3f}", flush=True)
        if change_score < core.UNCHANGED_THRESHOLD:
            raise RuntimeError(
                f"ProPainter did not materially change the selected region (score={change_score:.3f})"
            )
    except RuntimeError as exc:
        used_fallback = True
        print(
            f"ProPainter could not produce a reliable moving result; using tracked fallback: {exc}",
            flush=True,
        )
        inpainted = run_opencv_tracked_inpaint(source_mp4, tracked_masks, work_dir, fps)

    core.mux_audio(inpainted, source_mp4, output_video, width, height, fps, output_quality)

    try:
        validate_video_liveness(source_mp4, output_video, "Final eraser output")
    except RuntimeError as exc:
        if used_fallback:
            raise
        print(
            f"Final ProPainter composite was invalid; rebuilding from source frames: {exc}",
            flush=True,
        )
        inpainted = run_opencv_tracked_inpaint(source_mp4, tracked_masks, work_dir, fps)
        core.mux_audio(inpainted, source_mp4, output_video, width, height, fps, output_quality)
        validate_video_liveness(source_mp4, output_video, "Final fallback output")

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
