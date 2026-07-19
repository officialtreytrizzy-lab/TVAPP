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


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="etreyser-timeline-"))
    verify_long_clip_chunk_plan()
    try:
        source, partial, complete, masks = build_videos(root)
        verify_adaptive_chunk_boundaries(masks)
        verify_static_mask_lock(root)
        verify_chunk_stitching(root, source, masks)

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
