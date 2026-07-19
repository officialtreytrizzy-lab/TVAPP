from __future__ import annotations

"""Verified eTreyser production entrypoint.

This layer keeps the resilient SAM2/ProPainter implementation, but adds the
missing acceptance test that matters to the user: the exact painted selection
must actually change on the selected frame. A moving, playable MP4 is not
considered successful when the marked object/spot is still present.
"""

import json
import os
import shutil
from pathlib import Path

import cv2
import numpy as np

import sam2_propainter as locked_core
import sam2_propainter_resilient as pipeline

ANCHOR_MIN_MEAN_CHANGE = float(os.environ.get("ERASER_ANCHOR_MIN_MEAN_CHANGE", "3.0"))
ANCHOR_CHANGED_PIXEL_THRESHOLD = float(os.environ.get("ERASER_ANCHOR_PIXEL_THRESHOLD", "7.0"))
ANCHOR_MIN_CHANGED_RATIO = float(os.environ.get("ERASER_ANCHOR_MIN_CHANGED_RATIO", "0.12"))
RECOVERY_MASK_DILATION_PX = int(os.environ.get("ERASER_RECOVERY_MASK_DILATION_PX", "3"))
ALLOW_OPENCV_FALLBACK = os.environ.get("ERASER_ALLOW_OPENCV_FALLBACK", "false").lower() == "true"
PATCH_DELTA_THRESHOLD = float(os.environ.get("ERASER_PATCH_DELTA_THRESHOLD", "10.0"))
PATCH_MAX_SPILL_MEAN = float(os.environ.get("ERASER_PATCH_MAX_SPILL_MEAN", "6.0"))
PATCH_MAX_SPILL_RATIO = float(os.environ.get("ERASER_PATCH_MAX_SPILL_RATIO", "0.12"))
PATCH_MAX_EXTENT_RATIO = float(os.environ.get("ERASER_PATCH_MAX_EXTENT_RATIO", "5.0"))
TIMELINE_SAMPLE_COUNT = max(7, int(os.environ.get("ERASER_TIMELINE_SAMPLE_COUNT", "11")))
TIMELINE_MIN_PASS_RATIO = float(os.environ.get("ERASER_TIMELINE_MIN_PASS_RATIO", "0.82"))
TIMELINE_BOUNDARY_FRAMES = max(24, int(os.environ.get("ERASER_PROPAINTER_CHUNK_FRAMES", "120")))
TIMELINE_CONTEXT_MIN_CONTRAST = float(os.environ.get("ERASER_CONTEXT_MIN_CONTRAST", "4.0"))
TIMELINE_CONTEXT_MAX_RESIDUAL_RATIO = float(os.environ.get("ERASER_CONTEXT_MAX_RESIDUAL_RATIO", "0.90"))
TIMELINE_CONTEXT_MIN_GAIN = float(os.environ.get("ERASER_CONTEXT_MIN_GAIN", "0.75"))
TIMELINE_MIN_VERIFIABLE_FRAMES = max(2, int(os.environ.get("ERASER_MIN_VERIFIABLE_FRAMES", "3")))


class SelectionNotRemovedError(RuntimeError):
    """The selected frame rendered, but the painted region stayed unchanged."""


def read_frame(path: Path, frame_index: int) -> np.ndarray:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video for selection verification: {path}")

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    safe_index = max(0, min(frame_index, max(frame_count - 1, 0)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, safe_index)
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        raise RuntimeError(f"Could not decode verification frame {safe_index} from {path.name}")
    return frame


def verification_mask(input_mask: Path, width: int, height: int) -> np.ndarray:
    raw = locked_core.read_mask_alpha(input_mask, width, height)
    mask = (raw > 24).astype(np.uint8) * 255
    if locked_core.mask_bbox(mask) is None:
        raise RuntimeError("Selection verification mask is empty")
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)


def local_context_residual(frame: np.ndarray, mask: np.ndarray) -> float:
    """Estimate how visibly the selected pixels differ from nearby background.

    The source and result are each compared with a tight context-only inpaint.
    This lets subtle successful removals pass even when the replacement color is
    numerically close to the source, while an unchanged visible object still
    retains a high residual and fails.
    """
    height, width = frame.shape[:2]
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    binary = (mask > 24).astype(np.uint8) * 255
    selector = binary > 0
    if not np.any(selector):
        return 0.0

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    context_mask = cv2.dilate(binary, kernel, iterations=1)
    radius = max(2, min(7, int(round(max(width, height) * 0.004))))
    predicted_background = cv2.inpaint(frame, context_mask, radius, cv2.INPAINT_TELEA)
    residual = cv2.absdiff(frame, predicted_background).astype(np.float32).mean(axis=2)
    return float(residual[selector].mean())


def selection_outcome(stats: dict[str, float], *, allow_inconclusive: bool) -> str:
    direct_change = (
        stats["mean_change"] >= ANCHOR_MIN_MEAN_CHANGE
        or stats["changed_ratio"] >= ANCHOR_MIN_CHANGED_RATIO
    )
    context_gain = stats["source_context_residual"] - stats["candidate_context_residual"]
    context_ratio = stats["context_residual_ratio"]
    context_improved = (
        stats["source_context_residual"] >= TIMELINE_CONTEXT_MIN_CONTRAST
        and context_gain >= TIMELINE_CONTEXT_MIN_GAIN
        and context_ratio <= TIMELINE_CONTEXT_MAX_RESIDUAL_RATIO
    )
    if direct_change or context_improved:
        return "passed"
    if allow_inconclusive and stats["source_context_residual"] < TIMELINE_CONTEXT_MIN_CONTRAST:
        return "inconclusive"
    return "failed"



def selection_change_metrics(
    source_video: Path,
    candidate_video: Path,
    mask: np.ndarray,
    frame_index: int,
) -> dict[str, float]:
    source = read_frame(source_video, frame_index)
    candidate = read_frame(candidate_video, frame_index)

    height, width = source.shape[:2]
    if candidate.shape[1] != width or candidate.shape[0] != height:
        candidate = cv2.resize(candidate, (width, height), interpolation=cv2.INTER_LINEAR)
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)

    selector = mask > 24
    selected_pixels = int(np.count_nonzero(selector))
    if selected_pixels <= 0:
        raise RuntimeError("Selection verification mask is empty")

    pixel_delta = cv2.absdiff(source, candidate).astype(np.float32).mean(axis=2)
    selected_delta = pixel_delta[selector]
    mean_change = float(selected_delta.mean())
    median_change = float(np.median(selected_delta))
    changed_ratio = float(np.mean(selected_delta >= ANCHOR_CHANGED_PIXEL_THRESHOLD))
    source_context_residual = local_context_residual(source, mask)
    candidate_context_residual = local_context_residual(candidate, mask)
    context_residual_ratio = float(
        candidate_context_residual / max(source_context_residual, 0.001)
    )

    return {
        "frame_index": float(frame_index),
        "selected_pixels": float(selected_pixels),
        "mean_change": mean_change,
        "median_change": median_change,
        "changed_ratio": changed_ratio,
        "source_context_residual": source_context_residual,
        "candidate_context_residual": candidate_context_residual,
        "context_residual_ratio": context_residual_ratio,
    }


def validate_selection_changed(
    source_video: Path,
    candidate_video: Path,
    mask: np.ndarray,
    frame_index: int,
    label: str,
) -> dict[str, float]:
    stats = selection_change_metrics(source_video, candidate_video, mask, frame_index)
    print(f"{label} selected-region verification: {json.dumps(stats, sort_keys=True)}", flush=True)

    # The user-selected anchor must be positively verified. Unlike timeline
    # samples, it is never allowed to become merely inconclusive.
    if selection_outcome(stats, allow_inconclusive=False) != "passed":
        raise SelectionNotRemovedError(
            f"{label} left the painted selection unchanged: "
            f"mean_change={stats['mean_change']:.3f}, "
            f"changed_ratio={stats['changed_ratio']:.3f}, "
            f"source_context={stats['source_context_residual']:.3f}, "
            f"candidate_context={stats['candidate_context_residual']:.3f}"
        )
    return stats


def read_timeline_mask(mask_dir: Path, frame_index: int, width: int, height: int) -> np.ndarray:
    mask = cv2.imread(str(mask_dir / f"{frame_index:05d}.png"), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        return np.zeros((height, width), dtype=np.uint8)
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    return (mask > 24).astype(np.uint8) * 255


def chunk_boundary_indexes(mask_dir: Path, frame_count: int) -> list[int]:
    manifest_path = mask_dir.parent / pipeline.CHUNK_MANIFEST_NAME
    if not manifest_path.exists():
        return []
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"Could not read ProPainter chunk manifest: {exc}", flush=True)
        return []

    boundaries: list[int] = []
    for value in payload.get("boundaries", []):
        try:
            boundary = int(value)
        except Exception:
            continue
        if 0 < boundary < frame_count:
            boundaries.append(boundary)
    return sorted(set(boundaries))


def timeline_sample_indexes(
    frame_count: int,
    anchor_index: int,
    chunk_boundaries: list[int] | None = None,
) -> list[int]:
    if frame_count <= 0:
        return []

    indexes = {
        0,
        max(0, frame_count - 1),
        max(0, min(anchor_index, frame_count - 1)),
    }
    sample_total = min(TIMELINE_SAMPLE_COUNT, frame_count)
    indexes.update(int(round(value)) for value in np.linspace(0, frame_count - 1, sample_total))

    # Explicitly sample both sides of every 120-frame/approximately-five-second
    # processing boundary. This catches the exact failure where chunk one is
    # repaired but later chunks silently return to the original frames.
    for boundary in range(TIMELINE_BOUNDARY_FRAMES, frame_count, TIMELINE_BOUNDARY_FRAMES):
        indexes.update({boundary - 1, boundary, boundary + 1})
    for boundary in chunk_boundaries or []:
        indexes.update({boundary - 1, boundary, boundary + 1})

    return sorted(index for index in indexes if 0 <= index < frame_count)


def validate_timeline_selection_changed(
    source_video: Path,
    candidate_video: Path,
    mask_dir: Path,
    anchor_index: int,
    label: str,
) -> dict[str, float]:
    source_frames = pipeline.video_frame_count(source_video)
    candidate_frames = pipeline.video_frame_count(candidate_video)
    if candidate_frames < max(1, source_frames - 1):
        raise SelectionNotRemovedError(
            f"{label} ended early: source_frames={source_frames}, candidate_frames={candidate_frames}"
        )

    source_frame = read_frame(source_video, 0)
    height, width = source_frame.shape[:2]
    anchor_timeline_mask = read_timeline_mask(mask_dir, anchor_index, width, height)
    static_overlay = locked_core.is_probably_static_overlay(anchor_timeline_mask, width, height)

    results: list[dict[str, float | str]] = []
    missing_masks: list[int] = []
    failed_frames: list[int] = []
    inconclusive_frames: list[int] = []

    for frame_index in timeline_sample_indexes(
        source_frames,
        anchor_index,
        chunk_boundary_indexes(mask_dir, source_frames),
    ):
        mask = read_timeline_mask(mask_dir, frame_index, width, height)
        if locked_core.mask_bbox(mask) is None:
            missing_masks.append(frame_index)
            if static_overlay:
                failed_frames.append(frame_index)
            continue

        stats = selection_change_metrics(source_video, candidate_video, mask, frame_index)
        outcome = selection_outcome(stats, allow_inconclusive=True)
        results.append({**stats, "outcome": outcome})
        if outcome == "failed":
            failed_frames.append(frame_index)
        elif outcome == "inconclusive":
            inconclusive_frames.append(frame_index)

    checked = len(results)
    passed_count = sum(1 for row in results if row["outcome"] == "passed")
    failed_count = sum(1 for row in results if row["outcome"] == "failed")
    verifiable_count = passed_count + failed_count
    pass_ratio = float(passed_count / verifiable_count) if verifiable_count else 0.0
    required_ratio = 1.0 if static_overlay else TIMELINE_MIN_PASS_RATIO
    summary = {
        "source_frames": float(source_frames),
        "candidate_frames": float(candidate_frames),
        "checked_frames": float(checked),
        "verifiable_frames": float(verifiable_count),
        "passed_frames": float(passed_count),
        "inconclusive_frames": float(len(inconclusive_frames)),
        "pass_ratio": pass_ratio,
        "required_ratio": required_ratio,
        "static_overlay": float(static_overlay),
        "missing_masks": float(len(missing_masks)),
        "failed_frames": float(len(failed_frames)),
    }
    print(
        f"{label} full-timeline verification: {json.dumps(summary, sort_keys=True)} "
        f"samples={json.dumps(results, sort_keys=True)}",
        flush=True,
    )

    if checked <= 0:
        raise SelectionNotRemovedError(f"{label} had no tracked timeline frames to verify")
    if verifiable_count < min(TIMELINE_MIN_VERIFIABLE_FRAMES, checked):
        raise SelectionNotRemovedError(
            f"{label} did not have enough visible timeline samples to verify: "
            f"verifiable={verifiable_count}, checked={checked}"
        )
    if pass_ratio < required_ratio or (static_overlay and missing_masks):
        raise SelectionNotRemovedError(
            f"{label} did not keep the selection removed for the full clip: "
            f"pass_ratio={pass_ratio:.3f}, required={required_ratio:.3f}, "
            f"failed_frames={sorted(set(failed_frames))}, "
            f"inconclusive_frames={inconclusive_frames}, missing_masks={missing_masks}"
        )
    return summary


def patch_quality_metrics(
    source_video: Path,
    candidate_video: Path,
    mask: np.ndarray,
    frame_index: int,
) -> dict[str, float]:
    """Measure change leaking beyond the selected object into a patch-shaped area."""
    source = read_frame(source_video, frame_index)
    candidate = read_frame(candidate_video, frame_index)
    height, width = source.shape[:2]
    if candidate.shape[1] != width or candidate.shape[0] != height:
        candidate = cv2.resize(candidate, (width, height), interpolation=cv2.INTER_LINEAR)
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)

    binary = (mask > 24).astype(np.uint8)
    selected_pixels = int(np.count_nonzero(binary))
    if selected_pixels <= 0:
        raise RuntimeError("Patch quality mask is empty")

    delta = cv2.absdiff(source, candidate).astype(np.float32).mean(axis=2)
    guard_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17))
    outer_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (49, 49))
    guard = cv2.dilate(binary, guard_kernel, iterations=1) > 0
    outer = cv2.dilate(binary, outer_kernel, iterations=1) > 0
    spill_ring = outer & ~guard

    spill_mean = float(delta[spill_ring].mean()) if np.any(spill_ring) else 0.0
    spill_ratio = float(np.mean(delta[spill_ring] >= PATCH_DELTA_THRESHOLD)) if np.any(spill_ring) else 0.0

    changed = (delta >= PATCH_DELTA_THRESHOLD).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(changed, connectivity=8)
    touching_area = 0
    for component in range(1, count):
        component_pixels = labels == component
        if np.any(component_pixels & guard):
            touching_area += int(stats[component, cv2.CC_STAT_AREA])
    extent_ratio = float(touching_area / max(selected_pixels, 1))

    return {
        "spill_mean": spill_mean,
        "spill_ratio": spill_ratio,
        "extent_ratio": extent_ratio,
        "selected_pixels": float(selected_pixels),
    }


def validate_patch_quality(
    source_video: Path,
    candidate_video: Path,
    mask: np.ndarray,
    frame_index: int,
    label: str,
) -> dict[str, float]:
    stats = patch_quality_metrics(source_video, candidate_video, mask, frame_index)
    print(f"{label} patch-quality verification: {json.dumps(stats, sort_keys=True)}", flush=True)
    broad_spill = (
        stats["spill_mean"] > PATCH_MAX_SPILL_MEAN
        and stats["spill_ratio"] > PATCH_MAX_SPILL_RATIO
    )
    if broad_spill:
        raise SelectionNotRemovedError(
            f"{label} created a visible patch outside the selection: "
            f"spill_mean={stats['spill_mean']:.3f}, "
            f"spill_ratio={stats['spill_ratio']:.3f}, "
            f"extent_ratio={stats['extent_ratio']:.3f}"
        )
    return stats


def build_recovery_masks(
    source_dir: Path,
    output_dir: Path,
    anchor_index: int,
    anchor_mask: np.ndarray,
    width: int,
    height: int,
) -> Path:
    """Create a tight second-pass mask for ProPainter, never a blur patch."""
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    radius = max(1, min(6, RECOVERY_MASK_DILATION_PX))
    kernel_size = radius * 2 + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    mask_files = sorted(source_dir.glob("*.png"))
    if not mask_files:
        raise RuntimeError(f"No tracked masks were found under {source_dir}")

    for path in mask_files:
        mask = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            mask = np.zeros((height, width), dtype=np.uint8)
        elif mask.shape[1] != width or mask.shape[0] != height:
            mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
        mask = (mask > 24).astype(np.uint8) * 255
        try:
            idx = int(path.stem)
        except ValueError:
            idx = -1
        if idx == anchor_index:
            mask = cv2.bitwise_or(mask, anchor_mask)
        if locked_core.mask_bbox(mask) is not None:
            mask = cv2.dilate(mask, kernel, iterations=1)
        cv2.imwrite(str(output_dir / path.name), mask)

    print(f"Built tight ProPainter recovery masks with radius={radius}px", flush=True)
    return output_dir


def verified_recovery(
    source_video: Path,
    tracked_masks: Path,
    work_dir: Path,
    fps: float,
    anchor_index: int,
    anchor_mask: np.ndarray,
    width: int,
    height: int,
    output_quality: str,
) -> tuple[Path, Path]:
    recovery_masks = build_recovery_masks(
        tracked_masks,
        work_dir / "sam2_remove_masks_recovery",
        anchor_index,
        anchor_mask,
        width,
        height,
    )
    try:
        candidate = pipeline.run_propainter(
            source_video,
            recovery_masks,
            work_dir / "propainter_recovery_results",
            width,
            height,
            output_quality,
        )
        pipeline.validate_video_liveness(source_video, candidate, "ProPainter recovery", recovery_masks)
        validate_selection_changed(source_video, candidate, anchor_mask, anchor_index, "ProPainter recovery")
        validate_patch_quality(source_video, candidate, anchor_mask, anchor_index, "ProPainter recovery")
        validate_timeline_selection_changed(
            source_video, candidate, recovery_masks, anchor_index, "ProPainter recovery"
        )
        return candidate, recovery_masks
    except RuntimeError as exc:
        if not ALLOW_OPENCV_FALLBACK:
            raise SelectionNotRemovedError(
                "Quality-safe ProPainter recovery failed; refusing to return a blurred patch"
            ) from exc
        candidate = pipeline.run_opencv_tracked_inpaint(source_video, recovery_masks, work_dir, fps)
        validate_selection_changed(source_video, candidate, anchor_mask, anchor_index, "Opt-in OpenCV fallback")
        validate_patch_quality(source_video, candidate, anchor_mask, anchor_index, "Opt-in OpenCV fallback")
        validate_timeline_selection_changed(
            source_video, candidate, recovery_masks, anchor_index, "Opt-in OpenCV fallback"
        )
        return candidate, recovery_masks


def main() -> None:
    input_video = Path(locked_core.required_env("ERASER_INPUT_VIDEO"))
    input_mask = Path(locked_core.required_env("ERASER_INPUT_MASK"))
    output_video = Path(locked_core.required_env("ERASER_OUTPUT_VIDEO"))

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

    locked_core.prepare_source_mp4(input_video, source_mp4)
    fps, width, height = locked_core.read_video_meta(source_mp4)
    frame_count = pipeline.video_frame_count(source_mp4)
    anchor_index = locked_core.selected_frame_index(fps, frame_count)
    anchor_mask = verification_mask(input_mask, width, height)

    tracked_masks = locked_core.build_tracked_masks(
        source_mp4,
        input_mask,
        mask_dir,
        fps,
        width,
        height,
    )

    used_fallback = False
    active_masks = tracked_masks
    try:
        inpainted = pipeline.run_propainter(
            source_mp4,
            tracked_masks,
            result_root,
            width,
            height,
            output_quality,
        )
        change_score = locked_core.masked_change_score(
            source_mp4,
            inpainted,
            tracked_masks,
            width,
            height,
        )
        print(f"ProPainter masked-region change score={change_score:.3f}", flush=True)
        validate_selection_changed(
            source_mp4,
            inpainted,
            anchor_mask,
            anchor_index,
            "ProPainter",
        )
        validate_patch_quality(
            source_mp4,
            inpainted,
            anchor_mask,
            anchor_index,
            "ProPainter",
        )
        validate_timeline_selection_changed(
            source_mp4,
            inpainted,
            tracked_masks,
            anchor_index,
            "ProPainter",
        )
    except RuntimeError as exc:
        used_fallback = True
        print(
            f"ProPainter failed selection or patch-quality verification; using quality-safe recovery: {exc}",
            flush=True,
        )
        inpainted, active_masks = verified_recovery(
            source_mp4,
            tracked_masks,
            work_dir,
            fps,
            anchor_index,
            anchor_mask,
            width,
            height,
            output_quality,
        )

    composite_video = locked_core.composite_inpainted_region(
        source_mp4,
        inpainted,
        active_masks,
        work_dir / "source_preserving_composite.mp4",
        fps,
    )
    locked_core.mux_audio(
        composite_video,
        source_mp4,
        output_video,
        width,
        height,
        fps,
        output_quality,
    )

    try:
        pipeline.validate_video_liveness(source_mp4, output_video, "Final eraser output", active_masks)
        validate_selection_changed(
            source_mp4,
            output_video,
            anchor_mask,
            anchor_index,
            "Final eraser output",
        )
        validate_patch_quality(
            source_mp4,
            output_video,
            anchor_mask,
            anchor_index,
            "Final eraser output",
        )
        validate_timeline_selection_changed(
            source_mp4,
            output_video,
            active_masks,
            anchor_index,
            "Final eraser output",
        )
    except RuntimeError as exc:
        if used_fallback:
            raise
        print(
            f"Final ProPainter composite failed exact-selection verification; rebuilding: {exc}",
            flush=True,
        )
        inpainted, active_masks = verified_recovery(
            source_mp4,
            tracked_masks,
            work_dir,
            fps,
            anchor_index,
            anchor_mask,
            width,
            height,
            output_quality,
        )
        composite_video = locked_core.composite_inpainted_region(
            source_mp4,
            inpainted,
            active_masks,
            work_dir / "source_preserving_recovery_composite.mp4",
            fps,
        )
        locked_core.mux_audio(
            composite_video,
            source_mp4,
            output_video,
            width,
            height,
            fps,
            output_quality,
        )
        pipeline.validate_video_liveness(source_mp4, output_video, "Final quality-safe recovery output", active_masks)
        validate_selection_changed(
            source_mp4,
            output_video,
            anchor_mask,
            anchor_index,
            "Final quality-safe recovery output",
        )
        validate_patch_quality(
            source_mp4,
            output_video,
            anchor_mask,
            anchor_index,
            "Final quality-safe recovery output",
        )
        validate_timeline_selection_changed(
            source_mp4,
            output_video,
            active_masks,
            anchor_index,
            "Final quality-safe recovery output",
        )

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("Eraser pipeline did not create output video")


if __name__ == "__main__":
    main()
