from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PIPELINES = ROOT / "gpu-worker" / "pipelines"
sys.path.insert(0, str(PIPELINES))

import sam2_propainter as core  # noqa: E402
import sam2_propainter_resilient as resilient  # noqa: E402
import sam2_propainter_verified as verified  # noqa: E402


FPS = 24.0
FRAME_COUNT = 150
WIDTH = 320
HEIGHT = 180
MASK_X1, MASK_Y1, MASK_X2, MASK_Y2 = 286, 145, 319, 179


def writer(path: Path) -> cv2.VideoWriter:
    output = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        FPS,
        (WIDTH, HEIGHT),
    )
    if not output.isOpened():
        raise RuntimeError(f"Could not create test video: {path}")
    return output


def frame_for(index: int, remove_overlay: bool) -> np.ndarray:
    scene_two = index >= 120
    base = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    if scene_two:
        base[:] = (80, 35, 145)
    else:
        base[:] = (25, 110, 45)
    cv2.rectangle(base, (20 + index % 80, 35), (70 + index % 80, 95), (190, 180, 40), -1)
    if not remove_overlay:
        cv2.rectangle(base, (MASK_X1, MASK_Y1), (MASK_X2, MASK_Y2), (20, 20, 245), -1)
    return base


def build_videos(root: Path) -> tuple[Path, Path, Path, Path]:
    source = root / "source.mp4"
    partial = root / "partial.mp4"
    complete = root / "complete.mp4"
    masks = root / "masks"
    masks.mkdir(parents=True)

    source_writer = writer(source)
    partial_writer = writer(partial)
    complete_writer = writer(complete)
    mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(mask, (MASK_X1, MASK_Y1), (MASK_X2, MASK_Y2), 255, -1)

    for index in range(FRAME_COUNT):
        source_writer.write(frame_for(index, remove_overlay=False))
        partial_writer.write(frame_for(index, remove_overlay=index < 120))
        complete_writer.write(frame_for(index, remove_overlay=True))
        cv2.imwrite(str(masks / f"{index:05d}.png"), mask)

    source_writer.release()
    partial_writer.release()
    complete_writer.release()
    return source, partial, complete, masks


def verify_static_mask_lock(root: Path) -> None:
    frames = root / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    anchor = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(anchor, (MASK_X1, MASK_Y1), (MASK_X2, MASK_Y2), 255, -1)
    drifting = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(drifting, (100, 60), (135, 100), 255, -1)

    normalized: dict[int, np.ndarray] = {0: anchor}
    for index in range(12):
        cv2.imwrite(str(frames / f"{index:05d}.jpg"), frame_for(index, remove_overlay=False))
        if index > 0:
            normalized[index] = drifting

    tracked, _ = core.propagate_missing_masks(
        normalized,
        frames,
        12,
        WIDTH,
        HEIGHT,
        0,
        anchor,
        FPS,
    )
    for index in range(12):
        if not np.array_equal(tracked[index], anchor):
            raise AssertionError(f"Static overlay drifted at frame {index}")


def verify_long_clip_chunk_plan() -> None:
    high_resolution = resilient.long_clip_chunk_plan(450, 1920, 1080, "source")
    if not bool(high_resolution["chunked"]):
        raise AssertionError(f"15-second high-resolution clip was not segmented: {high_resolution}")
    if int(high_resolution["max_context_frames"]) > 48:
        raise AssertionError(f"High-resolution segment exceeds the memory-safe budget: {high_resolution}")
    if int(high_resolution["overlap_frames"]) < 2:
        raise AssertionError(f"Long-clip segments have no temporal overlap: {high_resolution}")

    short_low_resolution = resilient.long_clip_chunk_plan(192, 320, 180, "source")
    if bool(short_low_resolution["chunked"]):
        raise AssertionError(f"Small eight-second clip was segmented unnecessarily: {short_low_resolution}")


def verify_adaptive_chunk_boundaries(masks: Path) -> None:
    boundaries = [26, 52, 78]
    manifest = masks.parent / resilient.CHUNK_MANIFEST_NAME
    manifest.write_text(json.dumps({"boundaries": boundaries}), encoding="utf-8")
    discovered = verified.chunk_boundary_indexes(masks, FRAME_COUNT)
    if discovered != boundaries:
        raise AssertionError(f"Adaptive chunk manifest was not read correctly: {discovered}")

    samples = verified.timeline_sample_indexes(FRAME_COUNT, 0, discovered)
    for boundary in boundaries:
        required = {boundary - 1, boundary, boundary + 1}
        if not required.issubset(samples):
            raise AssertionError(
                f"Adaptive chunk boundary {boundary} is not fully verified: samples={samples}"
            )


def verify_chunk_stitching(root: Path, source: Path, masks: Path) -> None:
    original_runner = resilient.run_propainter_single

    def copy_segment(
        source_mp4: Path,
        _mask_path: Path,
        result_root: Path,
        _width: int,
        _height: int,
        _quality: str,
        _label_prefix: str = "ProPainter",
    ) -> Path:
        result_root.mkdir(parents=True, exist_ok=True)
        candidate = result_root / "inpaint_out.mp4"
        shutil.copy2(source_mp4, candidate)
        return candidate

    plan: dict[str, int | bool] = {
        "chunked": True,
        "core_frames": 26,
        "overlap_frames": 6,
        "max_context_frames": 38,
        "processing_width": WIDTH,
        "processing_height": HEIGHT,
        "pixels_per_frame": WIDTH * HEIGHT,
    }
    try:
        resilient.run_propainter_single = copy_segment
        joined = resilient.run_propainter_chunked(
            source,
            masks,
            root / "chunk_stitch_results",
            WIDTH,
            HEIGHT,
            "source",
            plan,
        )
    finally:
        resilient.run_propainter_single = original_runner

    joined_frames = resilient.video_frame_count(joined)
    if joined_frames != FRAME_COUNT:
        raise AssertionError(
            f"Overlapping ProPainter segment stitch changed frame count: {joined_frames}"
        )
    boundaries = verified.chunk_boundary_indexes(masks, FRAME_COUNT)
    if boundaries != [26, 52, 78, 104, 130]:
        raise AssertionError(f"Unexpected stitched segment boundaries: {boundaries}")


def verify_inset_static_overlay_lock(root: Path) -> None:
    inset = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(inset, (280, 136), (304, 160), 255, -1)
    central = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(central, (145, 72), (170, 97), 255, -1)

    if not core.is_probably_static_overlay(inset, WIDTH, HEIGHT):
        raise AssertionError("Small inset edge mark was not recognized as screen-space content")
    if core.is_probably_static_overlay(central, WIDTH, HEIGHT):
        raise AssertionError("Small central moving subject was incorrectly locked to the screen")

    frames = root / "inset_frames"
    frames.mkdir(parents=True, exist_ok=True)
    drifting = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(drifting, (110, 55), (165, 115), 255, -1)
    normalized: dict[int, np.ndarray] = {0: inset}
    for index in range(12):
        cv2.imwrite(str(frames / f"{index:05d}.jpg"), frame_for(index, remove_overlay=False))
        if index > 0:
            normalized[index] = drifting

    tracked, _ = core.propagate_missing_masks(
        normalized,
        frames,
        12,
        WIDTH,
        HEIGHT,
        0,
        inset,
        FPS,
    )
    for index in range(12):
        if not np.array_equal(tracked[index], inset):
            raise AssertionError(f"Inset screen-space mark drifted at frame {index}")


def context_stats(frame_index: int, outcome: str) -> dict[str, float]:
    common = {
        "frame_index": float(frame_index),
        "selected_pixels": 1200.0,
        "median_change": 1.0,
    }
    if outcome == "passed":
        return {
            **common,
            "mean_change": 8.0,
            "changed_ratio": 0.5,
            "source_context_residual": 12.0,
            "candidate_context_residual": 3.0,
            "context_residual_ratio": 0.25,
        }
    if outcome == "inconclusive":
        return {
            **common,
            "mean_change": 1.0,
            "changed_ratio": 0.0,
            "source_context_residual": 2.0,
            "candidate_context_residual": 1.9,
            "context_residual_ratio": 0.95,
        }
    return {
        **common,
        "mean_change": 1.0,
        "changed_ratio": 0.0,
        "source_context_residual": 12.0,
        "candidate_context_residual": 11.8,
        "context_residual_ratio": 11.8 / 12.0,
    }


def verify_context_aware_timeline(source: Path, complete: Path, masks: Path) -> None:
    original_metrics = verified.selection_change_metrics
    samples = verified.timeline_sample_indexes(
        FRAME_COUNT,
        0,
        verified.chunk_boundary_indexes(masks, FRAME_COUNT),
    )
    low_contrast = set(samples[3:8])

    def mixed_metrics(
        _source: Path,
        _candidate: Path,
        _mask: np.ndarray,
        frame_index: int,
    ) -> dict[str, float]:
        return context_stats(
            frame_index,
            "inconclusive" if frame_index in low_contrast else "passed",
        )

    try:
        verified.selection_change_metrics = mixed_metrics
        stats = verified.validate_timeline_selection_changed(
            source,
            complete,
            masks,
            0,
            "Low-contrast timeline",
        )
        if stats["pass_ratio"] != 1.0 or stats["inconclusive_frames"] <= 0:
            raise AssertionError(f"Low-contrast frames were not handled safely: {stats}")

        returned_frame = next(index for index in samples if index not in low_contrast and index != 0)

        def returned_metrics(
            _source: Path,
            _candidate: Path,
            _mask: np.ndarray,
            frame_index: int,
        ) -> dict[str, float]:
            if frame_index == returned_frame:
                return context_stats(frame_index, "failed")
            return mixed_metrics(_source, _candidate, _mask, frame_index)

        verified.selection_change_metrics = returned_metrics
        try:
            verified.validate_timeline_selection_changed(
                source,
                complete,
                masks,
                0,
                "Returned visible mark",
            )
        except verified.SelectionNotRemovedError:
            pass
        else:
            raise AssertionError("A visible returned mark was hidden by inconclusive-frame handling")
    finally:
        verified.selection_change_metrics = original_metrics



def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="etreyser-timeline-"))
    verify_long_clip_chunk_plan()
    try:
        source, partial, complete, masks = build_videos(root)
        verify_adaptive_chunk_boundaries(masks)
        verify_static_mask_lock(root)
        verify_inset_static_overlay_lock(root)
        verify_chunk_stitching(root, source, masks)
        verify_context_aware_timeline(source, complete, masks)

        try:
            verified.validate_timeline_selection_changed(
                source,
                partial,
                masks,
                0,
                "Intentional five-second regression",
            )
        except verified.SelectionNotRemovedError:
            pass
        else:
            raise AssertionError("Five-second-only removal incorrectly passed timeline verification")

        stats = verified.validate_timeline_selection_changed(
            source,
            complete,
            masks,
            0,
            "Full-clip removal",
        )
        if stats["pass_ratio"] != 1.0:
            raise AssertionError(f"Full-clip removal did not pass every sample: {stats}")

        print("E-Tracer timeline regression passed: partial removal rejected, full removal accepted.")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
