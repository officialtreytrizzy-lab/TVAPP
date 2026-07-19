#!/usr/bin/env python3
"""Regression guard for the Video ETreyser SAM2 pipeline.

This script intentionally checks for source-level invariants that must remain
true for the working SAM2 eraser implementation. It is not a full integration
test; it prevents accidental rollback to the old OpenCV-template-tracking path.
"""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / "gpu-worker" / "pipelines" / "sam2_propainter.py"
MODAL_APP = ROOT / "gpu-worker" / "modal_app.py"
LOCKDOC = ROOT / "docs" / "video-eraser-sam2-lockdown.md"

REQUIRED_PIPELINE_MARKERS = [
    "SAM2_CHECKPOINT",
    "SAM2_MODEL_CFG",
    "from sam2.build_sam import build_sam2_video_predictor",
    "build_sam2_video_predictor(",
    "SAM2 initialized",
    "SAM2 propagated masks for",
    "Using SAM2 mask sequence for ProPainter",
    "ProPainter masked-region change score",
    "run_opencv_tracked_inpaint",
]

FORBIDDEN_PIPELINE_MARKERS = [
    "cv2.matchTemplate",
    "read_video_gray_frames",
    "track_next_mask",
    "Tracked remove mask sequence",
]

REQUIRED_MODAL_MARKERS = [
    "github.com/facebookresearch/sam2.git",
    "pip install -e /opt/sam2",
    "sam2.1_hiera_tiny.pt",
    "/opt/sam2_checkpoints",
]

REQUIRED_DOC_MARKERS = [
    "Video ETreyser SAM2 Lockdown",
    "Status: working and locked",
    "Do not replace SAM2 propagation with OpenCV template matching",
]


def read(path: Path) -> str:
    if not path.exists():
        raise AssertionError(f"Missing required file: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def require_all(text: str, markers: list[str], label: str) -> list[str]:
    return [f"{label}: missing required marker: {marker}" for marker in markers if marker not in text]


def forbid_all(text: str, markers: list[str], label: str) -> list[str]:
    return [f"{label}: forbidden rollback marker is present: {marker}" for marker in markers if marker in text]


def main() -> int:
    problems: list[str] = []

    try:
        pipeline_text = read(PIPELINE)
        modal_text = read(MODAL_APP)
        doc_text = read(LOCKDOC)
    except AssertionError as exc:
        print(f"SAM2 lock check failed: {exc}", file=sys.stderr)
        return 1

    problems.extend(require_all(pipeline_text, REQUIRED_PIPELINE_MARKERS, "pipeline"))
    problems.extend(forbid_all(pipeline_text, FORBIDDEN_PIPELINE_MARKERS, "pipeline"))
    problems.extend(require_all(modal_text, REQUIRED_MODAL_MARKERS, "modal_app"))
    problems.extend(require_all(doc_text, REQUIRED_DOC_MARKERS, "lockdoc"))

    if problems:
        print("SAM2 video eraser lock check FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1

    print("SAM2 video eraser lock check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
