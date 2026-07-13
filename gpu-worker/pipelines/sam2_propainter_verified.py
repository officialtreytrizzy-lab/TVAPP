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

ANCHOR_MIN_MEAN_CHANGE = float(os.environ.get("ERASER_ANCHOR_MIN_MEAN_CHANGE", "4.0"))
ANCHOR_CHANGED_PIXEL_THRESHOLD = float(os.environ.get("ERASER_ANCHOR_PIXEL_THRESHOLD", "8.0"))
ANCHOR_MIN_CHANGED_RATIO = float(os.environ.get("ERASER_ANCHOR_MIN_CHANGED_RATIO", "0.20"))
STRONG_MASK_RADIUS_RATIO = float(os.environ.get("ERASER_STRONG_MASK_RADIUS_RATIO", "0.012"))


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
    mask = pipeline.resilient_clean_mask(raw, width, height, 0.18)

    # Include the immediate boundary of the user's painted selection. This stops
    # a renderer from changing only a couple of center pixels while leaving the
    # visible selected spot untouched around its edges.
    radius = max(2, min(12, int(round(max(width, height) * 0.004))))
    kernel_size = radius * 2 + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    return cv2.dilate(mask, kernel, iterations=1)


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

    return {
        "frame_index": float(frame_index),
        "selected_pixels": float(selected_pixels),
        "mean_change": mean_change,
        "median_change": median_change,
        "changed_ratio": changed_ratio,
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

    # Require either meaningful average replacement or broad pixel replacement.
    # A tiny codec fluctuation is not enough to call the object removed.
    if (
        stats["mean_change"] < ANCHOR_MIN_MEAN_CHANGE
        and stats["changed_ratio"] < ANCHOR_MIN_CHANGED_RATIO
    ):
        raise SelectionNotRemovedError(
            f"{label} left the painted selection unchanged: "
            f"mean_change={stats['mean_change']:.3f}, "
            f"changed_ratio={stats['changed_ratio']:.3f}"
        )
    return stats


def build_stronger_masks(
    source_dir: Path,
    output_dir: Path,
    anchor_index: int,
    anchor_mask: np.ndarray,
    width: int,
    height: int,
) -> Path:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    radius = max(5, min(28, int(round(max(width, height) * STRONG_MASK_RADIUS_RATIO))))
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
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
            mask = cv2.dilate(mask, kernel, iterations=1)

        cv2.imwrite(str(output_dir / path.name), mask)

    print(
        f"Built stronger tracked masks with radius={radius}px for selected-region recovery",
        flush=True,
    )
    return output_dir


def verified_fallback(
    source_video: Path,
    tracked_masks: Path,
    work_dir: Path,
    fps: float,
    anchor_index: int,
    anchor_mask: np.ndarray,
    width: int,
    height: int,
) -> Path:
    first_error: RuntimeError | None = None
    try:
        candidate = pipeline.run_opencv_tracked_inpaint(source_video, tracked_masks, work_dir, fps)
        validate_selection_changed(
            source_video,
            candidate,
            anchor_mask,
            anchor_index,
            "Tracked fallback",
        )
        return candidate
    except RuntimeError as exc:
        first_error = exc
        print(
            f"Normal tracked fallback did not remove the painted selection; expanding masks: {exc}",
            flush=True,
        )

    stronger_dir = work_dir / "sam2_remove_masks_strong"
    build_stronger_masks(
        tracked_masks,
        stronger_dir,
        anchor_index,
        anchor_mask,
        width,
        height,
    )
    candidate = pipeline.run_opencv_tracked_inpaint(source_video, stronger_dir, work_dir, fps)
    try:
        validate_selection_changed(
            source_video,
            candidate,
            anchor_mask,
            anchor_index,
            "Strong tracked fallback",
        )
    except RuntimeError as exc:
        raise SelectionNotRemovedError(
            "eTreyser refused to return another unchanged result. "
            f"Normal fallback: {first_error}; strong fallback: {exc}"
        ) from exc
    return candidate


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
        if change_score < locked_core.UNCHANGED_THRESHOLD:
            raise SelectionNotRemovedError(
                f"ProPainter did not materially change tracked regions (score={change_score:.3f})"
            )
        validate_selection_changed(
            source_mp4,
            inpainted,
            anchor_mask,
            anchor_index,
            "ProPainter",
        )
    except RuntimeError as exc:
        used_fallback = True
        print(
            f"ProPainter did not remove the exact painted selection; using verified fallback: {exc}",
            flush=True,
        )
        inpainted = verified_fallback(
            source_mp4,
            tracked_masks,
            work_dir,
            fps,
            anchor_index,
            anchor_mask,
            width,
            height,
        )

    locked_core.mux_audio(
        inpainted,
        source_mp4,
        output_video,
        width,
        height,
        fps,
        output_quality,
    )

    try:
        pipeline.validate_video_liveness(source_mp4, output_video, "Final eraser output")
        validate_selection_changed(
            source_mp4,
            output_video,
            anchor_mask,
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
        inpainted = verified_fallback(
            source_mp4,
            tracked_masks,
            work_dir,
            fps,
            anchor_index,
            anchor_mask,
            width,
            height,
        )
        locked_core.mux_audio(
            inpainted,
            source_mp4,
            output_video,
            width,
            height,
            fps,
            output_quality,
        )
        pipeline.validate_video_liveness(source_mp4, output_video, "Final verified fallback output")
        validate_selection_changed(
            source_mp4,
            output_video,
            anchor_mask,
            anchor_index,
            "Final verified fallback output",
        )

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("Eraser pipeline did not create output video")


if __name__ == "__main__":
    main()
