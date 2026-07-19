from __future__ import annotations

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


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="etreyser-timeline-"))
    try:
        source, partial, complete, masks = build_videos(root)
        verify_static_mask_lock(root)

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
