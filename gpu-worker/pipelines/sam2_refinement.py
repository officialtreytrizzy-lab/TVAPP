from __future__ import annotations

"""SAM2-assisted matte refinement for the optical-flow/VACE pipeline.

Optical flow remains authoritative for position and temporal continuity. SAM2 is
used only to tighten the semantic edge of compact fixed screen-space marks. Its
result is constrained to a small envelope around the flow mask and must retain
the flow core, so it cannot move, grow, or replace the tracker.
"""

import gc
import os
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

SAM2_ROOT = Path(os.environ.get("SAM2_ROOT", "/opt/sam2"))
SAM2_CHECKPOINT = Path(
    os.environ.get("SAM2_CHECKPOINT", "/opt/sam2_checkpoints/sam2.1_hiera_tiny.pt")
)
SAM2_MODEL_CFG = os.environ.get(
    "SAM2_MODEL_CFG", "configs/sam2.1/sam2.1_hiera_t.yaml"
)
SAM2_REFINEMENT_ENABLED = os.environ.get("ERASER_SAM2_REFINEMENT", "true").lower() == "true"


def mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask > 24)
    if len(xs) == 0 or len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def mask_area(mask: np.ndarray) -> int:
    return int(np.count_nonzero(mask > 24))


def mask_iou(left: np.ndarray, right: np.ndarray) -> float:
    left_binary = left > 24
    right_binary = right > 24
    union = int(np.count_nonzero(left_binary | right_binary))
    if union <= 0:
        return 0.0
    return float(np.count_nonzero(left_binary & right_binary)) / float(union)


def fuse_semantic_mask(flow_mask: np.ndarray, semantic_mask: np.ndarray) -> np.ndarray:
    """Constrain SAM2 to the optical-flow envelope and preserve the removal core."""
    flow = (flow_mask > 24).astype(np.uint8) * 255
    semantic = (semantic_mask > 24).astype(np.uint8) * 255
    bbox = mask_bbox(flow)
    if bbox is None or mask_bbox(semantic) is None:
        return flow

    x1, y1, x2, y2 = bbox
    minimum_side = max(1, min(x2 - x1 + 1, y2 - y1 + 1))
    envelope_radius = max(3, min(12, int(round(minimum_side * 0.18))))
    envelope_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (envelope_radius * 2 + 1, envelope_radius * 2 + 1),
    )
    envelope = cv2.dilate(flow, envelope_kernel, iterations=1)
    constrained = cv2.bitwise_and(semantic, envelope)

    core_radius = max(1, min(3, int(round(minimum_side * 0.05))))
    core_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (core_radius * 2 + 1, core_radius * 2 + 1),
    )
    core = cv2.erode(flow, core_kernel, iterations=1)
    fused = cv2.bitwise_or(constrained, core)
    fused = cv2.morphologyEx(
        fused,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )

    flow_area = max(mask_area(flow), 1)
    area_ratio = mask_area(fused) / float(flow_area)
    overlap = mask_iou(fused, flow)
    if not (0.72 <= area_ratio <= 1.30 and overlap >= 0.68):
        return flow
    return fused


def _prompt_points(mask: np.ndarray) -> np.ndarray:
    binary = (mask > 24).astype(np.uint8)
    distance = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    points: list[tuple[float, float]] = []
    working = distance.copy()
    for _ in range(3):
        _minimum, maximum, _minimum_location, maximum_location = cv2.minMaxLoc(working)
        if maximum <= 0:
            break
        points.append((float(maximum_location[0]), float(maximum_location[1])))
        cv2.circle(
            working,
            maximum_location,
            max(3, int(round(maximum * 0.75))),
            0,
            -1,
        )
    if not points:
        bbox = mask_bbox(mask)
        if bbox is None:
            return np.zeros((0, 2), dtype=np.float32)
        x1, y1, x2, y2 = bbox
        points.append(((x1 + x2) / 2.0, (y1 + y2) / 2.0))
    return np.asarray(points, dtype=np.float32)


def _refine_anchor(predictor, frame: np.ndarray, flow_mask: np.ndarray) -> tuple[np.ndarray, dict[str, float]]:
    bbox = mask_bbox(flow_mask)
    if bbox is None:
        return flow_mask, {"accepted": 0.0}
    x1, y1, x2, y2 = bbox
    padding = max(3, int(round(min(x2 - x1 + 1, y2 - y1 + 1) * 0.10)))
    box = np.asarray(
        [
            max(0, x1 - padding),
            max(0, y1 - padding),
            min(frame.shape[1] - 1, x2 + padding),
            min(frame.shape[0] - 1, y2 + padding),
        ],
        dtype=np.float32,
    )
    points = _prompt_points(flow_mask)
    labels = np.ones((len(points),), dtype=np.int32)

    predictor.set_image(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    masks, scores, _logits = predictor.predict(
        point_coords=points,
        point_labels=labels,
        box=box,
        multimask_output=True,
    )

    best_mask = flow_mask
    best_rank = float("-inf")
    best_metrics = {"accepted": 0.0}
    for raw_mask, raw_score in zip(masks, scores):
        candidate = (np.asarray(raw_mask) > 0).astype(np.uint8) * 255
        if candidate.shape != flow_mask.shape:
            candidate = cv2.resize(
                candidate,
                (flow_mask.shape[1], flow_mask.shape[0]),
                interpolation=cv2.INTER_NEAREST,
            )
        fused = fuse_semantic_mask(flow_mask, candidate)
        overlap = mask_iou(fused, flow_mask)
        area_ratio = mask_area(fused) / float(max(mask_area(flow_mask), 1))
        rank = float(raw_score) + overlap * 1.25 - abs(1.0 - area_ratio) * 0.6
        if rank > best_rank:
            best_rank = rank
            best_mask = fused
            best_metrics = {
                "accepted": float(not np.array_equal(fused, flow_mask)),
                "model_score": float(raw_score),
                "iou": float(overlap),
                "area_ratio": float(area_ratio),
            }
    try:
        predictor.reset_image()
    except Exception:
        pass
    return best_mask, best_metrics


def build_semantic_composite_masks(
    frames_dir: Path,
    flow_masks_dir: Path,
    destination: Path,
    frame_count: int,
    width: int,
    height: int,
    anchor_index: int,
    fixed_screen_position: bool,
) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)

    def copy_flow_masks() -> Path:
        for index in range(frame_count):
            source = flow_masks_dir / f"{index:06d}.png"
            if not source.exists():
                raise RuntimeError(f"Flow mask missing during composite-matte build: {index}")
            shutil.copy2(source, destination / source.name)
        return destination

    # Moving objects already have authoritative temporal masks. Limiting SAM2 to
    # compact fixed marks avoids boundary flicker and preserves perfect tracking.
    if not SAM2_REFINEMENT_ENABLED or not fixed_screen_position:
        copy_flow_masks()
        print(
            "SAM2 boundary refinement skipped: "
            f"enabled={SAM2_REFINEMENT_ENABLED}, fixed_screen_position={fixed_screen_position}",
            flush=True,
        )
        return destination

    try:
        import torch

        if str(SAM2_ROOT) not in sys.path:
            sys.path.insert(0, str(SAM2_ROOT))
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        if not SAM2_CHECKPOINT.exists():
            raise RuntimeError(f"SAM2 checkpoint is missing: {SAM2_CHECKPOINT}")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = build_sam2(
            SAM2_MODEL_CFG,
            str(SAM2_CHECKPOINT),
            device=device,
            apply_postprocessing=True,
        )
        predictor = SAM2ImagePredictor(model)
        frame = cv2.imread(str(frames_dir / f"{anchor_index:06d}.png"), cv2.IMREAD_COLOR)
        flow_mask = cv2.imread(
            str(flow_masks_dir / f"{anchor_index:06d}.png"),
            cv2.IMREAD_GRAYSCALE,
        )
        if frame is None or flow_mask is None:
            raise RuntimeError("Could not read SAM2 refinement anchor frame or flow mask")
        if frame.shape[1] != width or frame.shape[0] != height:
            frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_LANCZOS4)
        refined, metrics = _refine_anchor(predictor, frame, flow_mask)
        for index in range(frame_count):
            if not cv2.imwrite(str(destination / f"{index:06d}.png"), refined):
                raise RuntimeError(f"Could not write semantic composite mask {index}")
        print(
            "SAM2 boundary refinement complete: "
            f"anchor={anchor_index}, flow_area={mask_area(flow_mask)}, refined_area={mask_area(refined)}, "
            f"metrics={metrics}",
            flush=True,
        )
        del predictor
        del model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return destination
    except Exception as exc:
        shutil.rmtree(destination, ignore_errors=True)
        destination.mkdir(parents=True, exist_ok=True)
        copy_flow_masks()
        print(f"SAM2 boundary refinement unavailable; preserving optical-flow matte: {exc}", flush=True)
        return destination
