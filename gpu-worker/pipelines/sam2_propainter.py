from __future__ import annotations

import json
import os
import shutil
import subprocess
from contextlib import nullcontext
from pathlib import Path

import cv2
import numpy as np

PROPAINTER_ROOT = Path(os.environ.get("PROPAINTER_ROOT", "/opt/ProPainter"))
SAM2_CHECKPOINT = os.environ.get("SAM2_CHECKPOINT", "/opt/sam2_checkpoints/sam2.1_hiera_small.pt")
SAM2_MODEL_CFG = os.environ.get("SAM2_MODEL_CFG", "configs/sam2.1/sam2.1_hiera_s.yaml")
UNCHANGED_THRESHOLD = float(os.environ.get("ERASER_UNCHANGED_THRESHOLD", "2.25"))


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
        output = (completed.stdout or "")[-6000:]
        killed_hint = " (process was killed, usually by memory pressure)" if completed.returncode in {-9, 137} else ""
        detail = f"Command exited with return code {completed.returncode}{killed_hint}: {' '.join(cmd)}"
        raise RuntimeError(f"{detail}\n{output}".rstrip())
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
        return clean_int(str(float(raw_time or "0") * fps), 0, 0, max(frame_count - 1, 0))
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


def clean_mask(mask: np.ndarray, width: int, height: int, pad_ratio: float = 0.18) -> np.ndarray:
    """Normalize a mask without expanding it into a visible repair patch."""
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)

    mask = (mask > 24).astype(np.uint8) * 255
    if mask_bbox(mask) is None:
        raise RuntimeError("Painted mask is empty")

    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel, iterations=1)

    count, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), connectivity=8)
    if count > 1:
        largest_area = int(stats[1:, cv2.CC_STAT_AREA].max())
        minimum_component_area = max(3, int(round(largest_area * 0.01)))
        kept = np.zeros_like(mask)
        for component in range(1, count):
            if int(stats[component, cv2.CC_STAT_AREA]) >= minimum_component_area:
                kept[labels == component] = 255
        mask = kept

    configured = clean_int(os.environ.get("ERASER_MASK_DILATION_PX"), 1, 0, 6)
    dilation_px = min(6, configured + (1 if pad_ratio >= 0.24 else 0))
    if dilation_px > 0:
        kernel_size = dilation_px * 2 + 1
        dilate_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
        mask = cv2.dilate(mask, dilate_kernel, iterations=1)

    return mask


def extract_frames(video_path: Path, frames_dir: Path) -> tuple[int, int, int]:
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"SAM2 could not open video: {video_path}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    count = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        cv2.imwrite(str(frames_dir / f"{count:05d}.jpg"), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        count += 1

    cap.release()

    if count <= 0 or width <= 0 or height <= 0:
        raise RuntimeError("SAM2 could not extract frames")

    return count, width, height


def prompt_from_mask(mask: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    bbox = mask_bbox(mask)
    if bbox is None:
        raise RuntimeError("Mask prompt is empty")

    x1, y1, x2, y2 = bbox
    pad = max(2, int(max(x2 - x1 + 1, y2 - y1 + 1) * 0.08))
    box = np.array([
        max(0, x1 - pad),
        max(0, y1 - pad),
        min(width - 1, x2 + pad),
        min(height - 1, y2 + pad),
    ], dtype=np.float32)

    binary = (mask > 0).astype(np.uint8)
    moments = cv2.moments(binary)
    candidates: list[tuple[float, float]] = []
    if moments["m00"] > 0:
        candidates.append((float(moments["m10"] / moments["m00"]), float(moments["m01"] / moments["m00"])))

    distance = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    for _ in range(4):
        _, peak, _, location = cv2.minMaxLoc(distance)
        if peak <= 0:
            break
        px, py = location
        candidates.append((float(px), float(py)))
        cv2.circle(distance, (px, py), max(3, int(peak)), 0, -1)

    deduped: list[tuple[float, float]] = []
    for point in candidates:
        if all((point[0] - prior[0]) ** 2 + (point[1] - prior[1]) ** 2 >= 16 for prior in deduped):
            deduped.append(point)
    if not deduped:
        deduped.append((float((box[0] + box[2]) / 2), float((box[1] + box[3]) / 2)))

    positive_points = deduped[:5]
    extent = max(x2 - x1 + 1, y2 - y1 + 1)
    negative_margin = max(6, int(round(extent * 0.22)))
    negative_candidates = [
        (x1 - negative_margin, y1 - negative_margin),
        ((x1 + x2) / 2, y1 - negative_margin),
        (x2 + negative_margin, y1 - negative_margin),
        (x1 - negative_margin, (y1 + y2) / 2),
        (x2 + negative_margin, (y1 + y2) / 2),
        (x1 - negative_margin, y2 + negative_margin),
        ((x1 + x2) / 2, y2 + negative_margin),
        (x2 + negative_margin, y2 + negative_margin),
    ]
    negative_points: list[tuple[float, float]] = []
    for nx, ny in negative_candidates:
        px = int(round(max(0, min(width - 1, nx))))
        py = int(round(max(0, min(height - 1, ny))))
        if binary[py, px] == 0 and all((px - qx) ** 2 + (py - qy) ** 2 >= 9 for qx, qy in negative_points):
            negative_points.append((float(px), float(py)))

    all_points = positive_points + negative_points
    points = np.array(all_points, dtype=np.float32)
    labels = np.array([1] * len(positive_points) + [0] * len(negative_points), dtype=np.int32)
    return box, points, labels


def tensor_to_mask(mask_logits, width: int, height: int) -> np.ndarray:
    if isinstance(mask_logits, (list, tuple)):
        mask_logits = mask_logits[0]
    if mask_logits.dim() == 4:
        mask_logits = mask_logits[0, 0]
    elif mask_logits.dim() == 3:
        mask_logits = mask_logits[0]

    mask = (mask_logits > 0).detach().to("cpu").numpy().astype(np.uint8) * 255
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)

    # A tracked object can briefly disappear, become occluded, or produce an
    # empty SAM2 logit frame. That is a recoverable gap, not a reason to throw
    # away every valid mask propagated before it.
    if mask_bbox(mask) is None:
        return np.zeros((height, width), dtype=np.uint8)

    return clean_mask(mask, width, height, 0.10)


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
        box, points, labels = prompt_from_mask(anchor_mask, width, height)
        predictor.add_new_points_or_box(
            inference_state=state,
            frame_idx=anchor,
            obj_id=1,
            points=points,
            labels=labels,
            box=box,
        )

    masks: dict[int, np.ndarray] = {}
    for frame_idx, _obj_ids, logits in predictor.propagate_in_video(
        inference_state=state,
        start_frame_idx=anchor,
        max_frame_num_to_track=frame_count,
        reverse=reverse,
    ):
        idx = int(frame_idx)
        if 0 <= idx < frame_count:
            masks[idx] = tensor_to_mask(logits, width, height)

    try:
        predictor.reset_state(state)
    except Exception:
        pass

    del state
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    return masks


def mask_area(mask: np.ndarray) -> int:
    return int(np.count_nonzero(mask > 24))


def is_probably_static_overlay(mask: np.ndarray, width: int, height: int) -> bool:
    bbox = mask_bbox(mask)
    if bbox is None:
        return False
    x1, y1, x2, y2 = bbox
    area_ratio = mask_area(mask) / max(width * height, 1)
    box_width = x2 - x1 + 1
    box_height = y2 - y1 + 1
    edge_margin = max(3, int(round(min(width, height) * 0.025)))
    touches_frame_edge = (
        x1 <= edge_margin
        or y1 <= edge_margin
        or x2 >= width - 1 - edge_margin
        or y2 >= height - 1 - edge_margin
    )
    compact = box_width <= width * 0.25 and box_height <= height * 0.25
    return touches_frame_edge and compact and area_ratio <= 0.06


def read_tracking_frame(frames_dir: Path, index: int, width: int, height: int) -> np.ndarray:
    frame = cv2.imread(str(frames_dir / f"{index:05d}.jpg"), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError(f"Could not read SAM2 tracking frame {index}")
    if frame.shape[1] != width or frame.shape[0] != height:
        frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    return frame


def translate_mask(mask: np.ndarray, dx: float, dy: float) -> np.ndarray:
    height, width = mask.shape[:2]
    matrix = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], dtype=np.float32)
    translated = cv2.warpAffine(
        mask,
        matrix,
        (width, height),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    return (translated > 24).astype(np.uint8) * 255


def template_translation(previous_frame: np.ndarray, current_frame: np.ndarray, previous_mask: np.ndarray) -> tuple[float, float, float] | None:
    bbox = mask_bbox(previous_mask)
    if bbox is None:
        return None
    x1, y1, x2, y2 = bbox
    box_width = x2 - x1 + 1
    box_height = y2 - y1 + 1
    search_pad_x = max(12, int(round(box_width * 0.55)))
    search_pad_y = max(10, int(round(box_height * 0.45)))
    sx1 = max(0, x1 - search_pad_x)
    sy1 = max(0, y1 - search_pad_y)
    sx2 = min(current_frame.shape[1], x2 + search_pad_x + 1)
    sy2 = min(current_frame.shape[0], y2 + search_pad_y + 1)

    template = previous_frame[y1 : y2 + 1, x1 : x2 + 1]
    template_mask = previous_mask[y1 : y2 + 1, x1 : x2 + 1]
    search = current_frame[sy1:sy2, sx1:sx2]
    if (
        template.size == 0
        or search.shape[0] < template.shape[0]
        or search.shape[1] < template.shape[1]
    ):
        return None

    result = cv2.matchTemplate(search, template, cv2.TM_CCORR_NORMED, mask=template_mask)
    _minimum, score, _minimum_location, location = cv2.minMaxLoc(result)
    matched_x = sx1 + location[0]
    matched_y = sy1 + location[1]
    return float(matched_x - x1), float(matched_y - y1), float(score)


def sparse_flow_translation(previous_frame: np.ndarray, current_frame: np.ndarray, previous_mask: np.ndarray) -> tuple[float, float] | None:
    prev_gray = cv2.cvtColor(previous_frame, cv2.COLOR_BGR2GRAY)
    curr_gray = cv2.cvtColor(current_frame, cv2.COLOR_BGR2GRAY)
    feature_mask = cv2.dilate(
        (previous_mask > 24).astype(np.uint8) * 255,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
        iterations=1,
    )
    points = cv2.goodFeaturesToTrack(
        prev_gray,
        maxCorners=100,
        qualityLevel=0.005,
        minDistance=3,
        mask=feature_mask,
        blockSize=5,
    )
    if points is None or len(points) < 3:
        return None
    tracked, status, errors = cv2.calcOpticalFlowPyrLK(
        prev_gray,
        curr_gray,
        points,
        None,
        winSize=(25, 25),
        maxLevel=3,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
    )
    if tracked is None or status is None:
        return None
    valid = status.reshape(-1) > 0
    if errors is not None:
        valid &= errors.reshape(-1) < 30
    if int(np.count_nonzero(valid)) < 3:
        return None
    displacement = tracked.reshape(-1, 2)[valid] - points.reshape(-1, 2)[valid]
    dx = float(np.median(displacement[:, 0]))
    dy = float(np.median(displacement[:, 1]))
    return dx, dy


def warp_mask_with_optical_flow(previous_frame: np.ndarray, current_frame: np.ndarray, previous_mask: np.ndarray) -> np.ndarray:
    template_motion = template_translation(previous_frame, current_frame, previous_mask)
    sparse_motion = sparse_flow_translation(previous_frame, current_frame, previous_mask)

    if template_motion is not None and template_motion[2] >= 0.72:
        dx, dy, _score = template_motion
        if sparse_motion is not None:
            sparse_dx, sparse_dy = sparse_motion
            if abs(dx - sparse_dx) <= 8 and abs(dy - sparse_dy) <= 8:
                dx = (dx * 0.7) + (sparse_dx * 0.3)
                dy = (dy * 0.7) + (sparse_dy * 0.3)
        warped = translate_mask(previous_mask, dx, dy)
    elif sparse_motion is not None:
        warped = translate_mask(previous_mask, sparse_motion[0], sparse_motion[1])
    else:
        prev_gray = cv2.cvtColor(previous_frame, cv2.COLOR_BGR2GRAY)
        curr_gray = cv2.cvtColor(current_frame, cv2.COLOR_BGR2GRAY)
        flow = cv2.calcOpticalFlowFarneback(curr_gray, prev_gray, None, 0.5, 4, 21, 4, 7, 1.5, 0)
        height, width = previous_mask.shape[:2]
        grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
        warped = cv2.remap(
            previous_mask,
            grid_x + flow[..., 0],
            grid_y + flow[..., 1],
            interpolation=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        warped = (warped > 24).astype(np.uint8) * 255

    if mask_bbox(warped) is not None:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        warped = cv2.morphologyEx(warped, cv2.MORPH_CLOSE, kernel, iterations=1)
    return warped


def reacquire_from_anchor(
    anchor_frame: np.ndarray,
    current_frame: np.ndarray,
    anchor_mask: np.ndarray,
    predicted_mask: np.ndarray,
) -> tuple[np.ndarray, float] | None:
    anchor_bbox = mask_bbox(anchor_mask)
    predicted_bbox = mask_bbox(predicted_mask)
    if anchor_bbox is None or predicted_bbox is None:
        return None
    ax1, ay1, ax2, ay2 = anchor_bbox
    px1, py1, px2, py2 = predicted_bbox
    template = anchor_frame[ay1 : ay2 + 1, ax1 : ax2 + 1]
    template_mask = anchor_mask[ay1 : ay2 + 1, ax1 : ax2 + 1]
    if template.size == 0:
        return None

    box_width = ax2 - ax1 + 1
    box_height = ay2 - ay1 + 1
    search_pad_x = max(24, int(round(box_width * 2.5)))
    search_pad_y = max(20, int(round(box_height * 2.0)))
    sx1 = max(0, px1 - search_pad_x)
    sy1 = max(0, py1 - search_pad_y)
    sx2 = min(current_frame.shape[1], px2 + search_pad_x + 1)
    sy2 = min(current_frame.shape[0], py2 + search_pad_y + 1)
    search = current_frame[sy1:sy2, sx1:sx2]
    if search.shape[0] < template.shape[0] or search.shape[1] < template.shape[1]:
        return None

    result = cv2.matchTemplate(search, template, cv2.TM_CCORR_NORMED, mask=template_mask)
    _minimum, score, _minimum_location, location = cv2.minMaxLoc(result)
    if not np.isfinite(score):
        return None
    matched_x = sx1 + location[0]
    matched_y = sy1 + location[1]
    return translate_mask(anchor_mask, float(matched_x - ax1), float(matched_y - ay1)), float(score)


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    aa = a > 24
    bb = b > 24
    union = int(np.count_nonzero(aa | bb))
    return float(np.count_nonzero(aa & bb) / union) if union else 0.0


def choose_tracked_mask(sam2_mask: np.ndarray | None, flow_mask: np.ndarray) -> np.ndarray:
    sam_bbox = mask_bbox(sam2_mask) if sam2_mask is not None else None
    flow_bbox = mask_bbox(flow_mask)
    if sam_bbox is None:
        return flow_mask
    if flow_bbox is None:
        return sam2_mask

    sam_area = mask_area(sam2_mask)
    flow_area = max(mask_area(flow_mask), 1)
    area_ratio = sam_area / flow_area
    overlap = mask_iou(sam2_mask, flow_mask)

    sx1, sy1, sx2, sy2 = sam_bbox
    fx1, fy1, fx2, fy2 = flow_bbox
    sam_center = np.array([(sx1 + sx2) / 2.0, (sy1 + sy2) / 2.0])
    flow_center = np.array([(fx1 + fx2) / 2.0, (fy1 + fy2) / 2.0])
    center_distance = float(np.linalg.norm(sam_center - flow_center))
    flow_extent = max(fx2 - fx1 + 1, fy2 - fy1 + 1, 1)

    consistent = (
        0.50 <= area_ratio <= 2.0
        and overlap >= 0.35
        and center_distance <= max(5.0, flow_extent * 0.25)
    )
    if not consistent:
        return flow_mask

    envelope = cv2.dilate(
        flow_mask,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
        iterations=1,
    )
    constrained = cv2.bitwise_and(sam2_mask, envelope)
    if mask_area(constrained) >= flow_area * 0.55:
        return constrained
    return flow_mask


def propagate_missing_masks(
    normalized: dict[int, np.ndarray],
    frames_dir: Path,
    frame_count: int,
    width: int,
    height: int,
    anchor: int,
    anchor_mask: np.ndarray,
    fps: float,
) -> tuple[dict[int, np.ndarray], int]:
    result: dict[int, np.ndarray] = {anchor: anchor_mask}
    static_overlay = is_probably_static_overlay(anchor_mask, width, height)
    anchor_frame = read_tracking_frame(frames_dir, anchor, width, height)
    reanchor_interval = clean_int(
        os.environ.get("ERASER_TRACK_REANCHOR_FRAMES"),
        max(8, int(round(max(fps, 1.0) * 2.0))),
        6,
        240,
    )
    recovered = 0

    for direction in (1, -1):
        previous_frame = read_tracking_frame(frames_dir, anchor, width, height)
        previous_mask = anchor_mask
        index = anchor + direction
        while 0 <= index < frame_count:
            current_frame = read_tracking_frame(frames_dir, index, width, height)
            sam2_mask = normalized.get(index)
            if static_overlay:
                # Small edge/corner selections are fixed screen-space content
                # such as watermarks, logos, or persistent blemishes. SAM2 can
                # jump to a similarly shaped person/object after a scene cut.
                # Keep the exact painted screen position active for every frame.
                chosen = anchor_mask.copy()
                if (
                    sam2_mask is None
                    or mask_bbox(sam2_mask) is None
                    or mask_iou(sam2_mask, anchor_mask) < 0.85
                ):
                    recovered += 1
            else:
                flow_mask = warp_mask_with_optical_flow(previous_frame, current_frame, previous_mask)
                if abs(index - anchor) % reanchor_interval == 0 and mask_bbox(flow_mask) is not None:
                    reacquired = reacquire_from_anchor(anchor_frame, current_frame, anchor_mask, flow_mask)
                    if reacquired is not None and reacquired[1] >= 0.80:
                        candidate, score = reacquired
                        if mask_iou(candidate, flow_mask) >= 0.08:
                            flow_mask = candidate
                            print(f"Tracker re-anchored frame={index} score={score:.3f}", flush=True)
                chosen = choose_tracked_mask(sam2_mask, flow_mask)
                if sam2_mask is None or mask_bbox(sam2_mask) is None or chosen is flow_mask:
                    recovered += 1
            result[index] = chosen
            previous_frame = current_frame
            previous_mask = chosen
            index += direction

    return result, recovered


def write_masks(
    masks: dict[int, np.ndarray],
    output_dir: Path,
    frames_dir: Path,
    frame_count: int,
    width: int,
    height: int,
    anchor: int,
    anchor_mask: np.ndarray,
    fps: float,
) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    normalized: dict[int, np.ndarray] = {}
    for idx, raw_mask in masks.items():
        if not (0 <= idx < frame_count) or raw_mask is None:
            continue
        mask = raw_mask
        if mask.shape[1] != width or mask.shape[0] != height:
            mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
        mask = (mask > 24).astype(np.uint8) * 255
        if mask_bbox(mask) is not None:
            normalized[idx] = mask

    anchor_mask = clean_mask(anchor_mask, width, height, 0.10)
    normalized[anchor] = anchor_mask
    tracked, recovered = propagate_missing_masks(normalized, frames_dir, frame_count, width, height, anchor, anchor_mask, fps)

    for idx in range(frame_count):
        cv2.imwrite(str(output_dir / f"{idx:05d}.png"), tracked.get(idx, np.zeros((height, width), dtype=np.uint8)))

    sample_indexes = sorted(set([0, anchor, frame_count // 4, frame_count // 2, (frame_count * 3) // 4, max(0, frame_count - 1)]))
    sample_stats = []
    for sample_index in sample_indexes:
        sample_mask = tracked.get(sample_index, np.zeros((height, width), dtype=np.uint8))
        sample_stats.append({
            "frame": sample_index,
            "bbox": mask_bbox(sample_mask),
            "area": mask_area(sample_mask),
        })
    print(f"Tracking mask samples: {json.dumps(sample_stats)}", flush=True)

    usable_sam2 = sum(1 for mask in normalized.values() if mask_bbox(mask) is not None)
    print(
        f"Tracking masks ready: sam2_usable={usable_sam2}/{frame_count} motion_recovered={recovered} "
        f"static_overlay={is_probably_static_overlay(anchor_mask, width, height)}",
        flush=True,
    )


def build_sam2_masks(source_mp4: Path, input_mask: Path, output_dir: Path, fps: float, width: int, height: int) -> Path:
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    frames_dir = output_dir.parent / "sam2_frames"
    frame_count, width, height = extract_frames(source_mp4, frames_dir)

    anchor = selected_frame_index(fps, frame_count)
    anchor_mask = clean_mask(read_mask_alpha(input_mask, width, height), width, height, 0.18)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"SAM2 initialized: cfg={SAM2_MODEL_CFG} checkpoint={SAM2_CHECKPOINT} device={device}", flush=True)
    print(f"Anchor frame index: {anchor}", flush=True)

    predictor = build_sam2_video_predictor(
        SAM2_MODEL_CFG,
        SAM2_CHECKPOINT,
        device=device,
        vos_optimized=False,
        apply_postprocessing=True,
    )

    masks: dict[int, np.ndarray] = {}
    ctx = torch.autocast("cuda", dtype=torch.bfloat16) if device == "cuda" else nullcontext()
    requested_mode = os.environ.get("SAM2_PROMPT_MODE", "hybrid").lower()
    primary_mode = "mask" if requested_mode == "hybrid" else requested_mode

    with torch.inference_mode(), ctx:
        masks.update(sam2_direction(predictor, frames_dir, anchor, anchor_mask, False, frame_count, width, height, primary_mode))
        masks.update(sam2_direction(predictor, frames_dir, anchor, anchor_mask, True, frame_count, width, height, primary_mode))

        usable = sum(1 for mask in masks.values() if mask_bbox(mask) is not None)
        minimum_usable = max(3, int(round(frame_count * 0.55)))
        if usable < minimum_usable and primary_mode != "box":
            print(f"SAM2 mask prompt tracked only {usable}/{frame_count} frames; retrying tight box-and-points prompt", flush=True)
            box_masks: dict[int, np.ndarray] = {}
            box_masks.update(sam2_direction(predictor, frames_dir, anchor, anchor_mask, False, frame_count, width, height, "box"))
            box_masks.update(sam2_direction(predictor, frames_dir, anchor, anchor_mask, True, frame_count, width, height, "box"))
            for idx, box_mask in box_masks.items():
                current = masks.get(idx)
                if current is None or mask_bbox(current) is None:
                    masks[idx] = box_mask

    del predictor
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    write_masks(masks, output_dir, frames_dir, frame_count, width, height, anchor, anchor_mask, fps)

    print(f"SAM2 propagated masks for {frame_count} frames", flush=True)
    print("Using SAM2 mask sequence for ProPainter", flush=True)
    return output_dir


def build_static_masks(source_mp4: Path, input_mask: Path, output_dir: Path, fps: float, width: int, height: int) -> Path:
    cap = cv2.VideoCapture(str(source_mp4))
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) or 1
    cap.release()

    mask = clean_mask(read_mask_alpha(input_mask, width, height), width, height, 0.25)

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    for idx in range(frame_count):
        cv2.imwrite(str(output_dir / f"{idx:05d}.png"), mask)

    print(f"SAM2 unavailable; wrote static fallback masks for {frame_count} frames", flush=True)
    return output_dir


def build_tracked_masks(source_mp4: Path, input_mask: Path, output_dir: Path, fps: float, width: int, height: int) -> Path:
    if os.environ.get("ERASER_DISABLE_SAM2", "false").lower() == "true":
        return build_static_masks(source_mp4, input_mask, output_dir, fps, width, height)

    try:
        return build_sam2_masks(source_mp4, input_mask, output_dir, fps, width, height)
    except Exception as exc:
        print(f"SAM2 propagation failed; using static fallback masks: {exc}", flush=True)
        return build_static_masks(source_mp4, input_mask, output_dir, fps, width, height)


def processing_size(width: int, height: int, quality: str, max_side_cap: int | None = None) -> tuple[int, int]:
    default_max_side = 1080 if quality == "higher" else 960
    max_side = int(os.environ.get("ERASER_PROPAINTER_MAX_SIDE", str(default_max_side)))
    if max_side_cap:
        max_side = min(max_side, max_side_cap)
    scale = min(1.0, max_side / max(width, height))
    return max(8, int(width * scale) // 8 * 8), max(8, int(height * scale) // 8 * 8)


def even_dimension(value: int) -> int:
    return value if value % 2 == 0 else value - 1


def is_cuda_oom(message: str) -> bool:
    lowered = message.lower()
    return "out of memory" in lowered or "outofmemoryerror" in lowered or "cuda oom" in lowered

def find_propainter_output(result_root: Path) -> Path:
    candidates = list(result_root.rglob("inpaint_out.mp4"))
    if not candidates:
        raise RuntimeError(f"ProPainter completed but no inpaint_out.mp4 was found under {result_root}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def export_settings(quality: str, source_bitrate: int | None) -> tuple[str, str, list[str]]:
    if quality == "higher":
        return "slow", "11", ["-b:a", "256k"]

    if source_bitrate and source_bitrate > 0:
        target = max(source_bitrate, 8_000_000)
        return "medium", "14", [
            "-b:a",
            "192k",
            "-maxrate",
            str(int(target * 1.35)),
            "-bufsize",
            str(int(target * 2)),
        ]

    return "medium", "14", ["-b:a", "192k"]


def composite_inpainted_region(
    source_video: Path,
    candidate_video: Path,
    mask_dir: Path,
    output_video: Path,
    fps: float,
) -> Path:
    source_cap = cv2.VideoCapture(str(source_video))
    candidate_cap = cv2.VideoCapture(str(candidate_video))
    if not source_cap.isOpened() or not candidate_cap.isOpened():
        source_cap.release()
        candidate_cap.release()
        raise RuntimeError("Could not open videos for source-preserving composite")

    width = int(source_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(source_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    composite_fps = fps if fps > 0 else source_cap.get(cv2.CAP_PROP_FPS) or 30.0
    raw_output = output_video.with_suffix(".raw.mp4")
    writer = cv2.VideoWriter(str(raw_output), cv2.VideoWriter_fourcc(*"mp4v"), composite_fps, (width, height))
    if not writer.isOpened():
        source_cap.release()
        candidate_cap.release()
        raise RuntimeError("Could not create source-preserving composite")

    index = 0
    written = 0
    while True:
        ok_source, source = source_cap.read()
        ok_candidate, candidate = candidate_cap.read()
        if not ok_source or not ok_candidate:
            break
        if candidate.shape[1] != width or candidate.shape[0] != height:
            candidate = cv2.resize(candidate, (width, height), interpolation=cv2.INTER_LANCZOS4)

        mask = cv2.imread(str(mask_dir / f"{index:05d}.png"), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            mask = np.zeros((height, width), dtype=np.uint8)
        elif mask.shape[1] != width or mask.shape[0] != height:
            mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
        binary = (mask > 24).astype(np.uint8) * 255
        if mask_bbox(binary) is None:
            output = source
        else:
            edge_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            outer = cv2.dilate(binary, edge_kernel, iterations=1)
            alpha = cv2.GaussianBlur(outer, (0, 0), sigmaX=1.25, sigmaY=1.25).astype(np.float32) / 255.0
            alpha[binary > 0] = 1.0
            alpha = alpha[:, :, None]
            output = np.clip(candidate.astype(np.float32) * alpha + source.astype(np.float32) * (1.0 - alpha), 0, 255).astype(np.uint8)

        writer.write(output)
        index += 1
        written += 1

    source_cap.release()
    candidate_cap.release()
    writer.release()
    if written <= 0:
        raise RuntimeError("Source-preserving composite wrote no frames")

    run([
        "ffmpeg", "-y", "-i", str(raw_output), "-an",
        "-c:v", "libx264", "-preset", "medium", "-crf", "12",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_video),
    ])
    print(f"Source-preserving mask composite wrote {written} frames", flush=True)
    return output_video


def mux_audio(inpainted_video: Path, source_video: Path, output_video: Path, width: int, height: int, fps: float, quality: str) -> None:
    out_w = even_dimension(width)
    out_h = even_dimension(height)
    preset, crf, audio_args = export_settings(quality, source_video_bitrate(source_video))
    vf = f"scale={out_w}:{out_h}:flags=lanczos,fps={fps:.6f}"

    try:
        run([
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
        ])
    except Exception:
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


def is_resource_pressure_failure(message: str) -> bool:
    lowered = message.lower()
    return any(
        marker in lowered
        for marker in (
            "out of memory",
            "outofmemoryerror",
            "cuda oom",
            "return code -9",
            "return code 137",
            "process was killed",
            "sigkill",
            "cannot allocate memory",
        )
    )


def run_propainter_single(source_mp4: Path, mask_path: Path, result_root: Path, width: int, height: int, quality: str) -> Path:
    inference = PROPAINTER_ROOT / "inference_propainter.py"
    if not inference.exists():
        raise RuntimeError(f"ProPainter is not installed at {PROPAINTER_ROOT}")

    env = dict(os.environ)
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True,max_split_size_mb:128")
    env.setdefault("OMP_NUM_THREADS", "2")
    env.setdefault("MKL_NUM_THREADS", "2")

    attempts: list[tuple[int, str, str, str, str]] = [
        (640, "12", "3", "8", "3"),
        (560, "10", "2", "8", "3"),
        (480, "8", "1", "6", "2"),
        (384, "6", "1", "4", "2"),
        (320, "4", "1", "4", "1"),
        (256, "4", "1", "4", "1"),
    ]

    last_error: RuntimeError | None = None

    for index, (max_side_cap, subvideo_length, neighbor_length, ref_stride, mask_dilation) in enumerate(attempts):
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
            neighbor_length,
            "--ref_stride",
            ref_stride,
            "--mask_dilation",
            mask_dilation,
        ]

        try:
            print(
                f"Running ProPainter attempt {index + 1}/{len(attempts)}: {proc_w}x{proc_h}, subvideo={subvideo_length}, neighbor={neighbor_length}",
                flush=True,
            )
            run(cmd, cwd=PROPAINTER_ROOT, env=env)
            return find_propainter_output(result_root)
        except RuntimeError as exc:
            last_error = exc
            if index == len(attempts) - 1 or not is_resource_pressure_failure(str(exc)):
                raise
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            print(
                f"ProPainter resource-pressure failure at {proc_w}x{proc_h}; retrying with a smaller/shorter pass...",
                flush=True,
            )

    raise last_error or RuntimeError("ProPainter failed without output")


def video_frame_count(video_path: Path) -> int:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video to count frames: {video_path}")
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    if count <= 0:
        raise RuntimeError("Could not determine video frame count")
    return count


def make_propainter_chunk(
    source_mp4: Path,
    source_masks: Path,
    chunk_root: Path,
    start_frame: int,
    end_frame: int,
) -> tuple[Path, Path]:
    chunk_root.mkdir(parents=True, exist_ok=True)
    chunk_video = chunk_root / "source.mp4"
    chunk_masks = chunk_root / "masks"
    chunk_masks.mkdir(parents=True, exist_ok=True)

    # Frame-exact trim. Audio is restored once after all AI chunks are joined.
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_mp4),
            "-vf",
            f"trim=start_frame={start_frame}:end_frame={end_frame},setpts=PTS-STARTPTS",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            str(chunk_video),
        ]
    )

    for local_idx, source_idx in enumerate(range(start_frame, end_frame)):
        source_mask = source_masks / f"{source_idx:05d}.png"
        if not source_mask.exists():
            raise RuntimeError(f"Tracked mask is missing for frame {source_idx}")
        shutil.copy2(source_mask, chunk_masks / f"{local_idx:05d}.png")

    return chunk_video, chunk_masks


def concatenate_propainter_chunks(outputs: list[Path], destination: Path) -> Path:
    if not outputs:
        raise RuntimeError("No ProPainter chunk outputs were produced")
    if len(outputs) == 1:
        shutil.copy2(outputs[0], destination)
        return destination

    concat_file = destination.parent / "propainter_chunks.txt"
    concat_file.write_text(
        "".join(f"file '{path.as_posix()}'\n" for path in outputs),
        encoding="utf-8",
    )
    try:
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(destination)])
    except RuntimeError:
        run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "14",
                "-pix_fmt",
                "yuv420p",
                str(destination),
            ]
        )
    return destination


def run_propainter(source_mp4: Path, mask_path: Path, result_root: Path, width: int, height: int, quality: str) -> Path:
    frame_count = video_frame_count(source_mp4)
    max_frames = max(24, int(os.environ.get("ERASER_PROPAINTER_CHUNK_FRAMES", "120")))
    if frame_count <= max_frames:
        return run_propainter_single(source_mp4, mask_path, result_root, width, height, quality)

    chunk_workspace = result_root.parent / "propainter_chunk_work"
    if chunk_workspace.exists():
        shutil.rmtree(chunk_workspace)
    chunk_workspace.mkdir(parents=True, exist_ok=True)

    outputs: list[Path] = []
    chunk_total = (frame_count + max_frames - 1) // max_frames
    print(
        f"Long clip detected ({frame_count} frames); running ProPainter in {chunk_total} temporal GPU chunks of up to {max_frames} frames",
        flush=True,
    )

    for chunk_index, start_frame in enumerate(range(0, frame_count, max_frames), start=1):
        end_frame = min(frame_count, start_frame + max_frames)
        chunk_root = chunk_workspace / f"chunk_{chunk_index:03d}"
        chunk_video, chunk_masks = make_propainter_chunk(
            source_mp4,
            mask_path,
            chunk_root,
            start_frame,
            end_frame,
        )
        print(
            f"Running ProPainter chunk {chunk_index}/{chunk_total}: frames {start_frame}-{end_frame - 1}",
            flush=True,
        )
        chunk_output = run_propainter_single(
            chunk_video,
            chunk_masks,
            chunk_root / "results",
            width,
            height,
            quality,
        )
        stable_output = chunk_root / "completed.mp4"
        shutil.copy2(chunk_output, stable_output)
        outputs.append(stable_output)

    joined = result_root.parent / "propainter_chunked_joined.mp4"
    return concatenate_propainter_chunks(outputs, joined)


def masked_change_score(source_video: Path, candidate_video: Path, mask_dir: Path, width: int, height: int) -> float:
    source_cap = cv2.VideoCapture(str(source_video))
    candidate_cap = cv2.VideoCapture(str(candidate_video))

    if not source_cap.isOpened() or not candidate_cap.isOpened():
        source_cap.release()
        candidate_cap.release()
        return 0.0

    frame_count = int(source_cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) or 1
    sample_indexes = sorted(set([0, frame_count // 4, frame_count // 2, (frame_count * 3) // 4, max(0, frame_count - 1)]))

    scores: list[float] = []

    for idx in sample_indexes:
        source_cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        candidate_cap.set(cv2.CAP_PROP_POS_FRAMES, idx)

        ok_a, frame_a = source_cap.read()
        ok_b, frame_b = candidate_cap.read()

        if not ok_a or not ok_b:
            continue

        if frame_b.shape[1] != width or frame_b.shape[0] != height:
            frame_b = cv2.resize(frame_b, (width, height), interpolation=cv2.INTER_LINEAR)

        mask = cv2.imread(str(mask_dir / f"{idx:05d}.png"), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            continue

        if mask.shape[1] != width or mask.shape[0] != height:
            mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)

        selector = mask > 24
        if not np.any(selector):
            continue

        diff = cv2.absdiff(frame_a, frame_b)
        scores.append(float(diff[selector].mean()))

    source_cap.release()
    candidate_cap.release()

    return sum(scores) / len(scores) if scores else 0.0


def run_opencv_tracked_inpaint(source_mp4: Path, mask_dir: Path, work_dir: Path, fps: float) -> Path:
    fallback_dir = work_dir / "opencv_tracked_inpaint"

    if fallback_dir.exists():
        shutil.rmtree(fallback_dir)
    fallback_dir.mkdir(parents=True, exist_ok=True)

    raw_output = fallback_dir / "opencv_raw.mp4"
    normalized_output = fallback_dir / "opencv_h264.mp4"

    cap = cv2.VideoCapture(str(source_mp4))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open source video for OpenCV fallback: {source_mp4}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fallback_fps = fps if fps and fps > 0 else cap.get(cv2.CAP_PROP_FPS) or 30.0

    writer = cv2.VideoWriter(str(raw_output), cv2.VideoWriter_fourcc(*"mp4v"), fallback_fps, (width, height))
    if not writer.isOpened():
        cap.release()
        raise RuntimeError("Could not open OpenCV fallback video writer")

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
        if mask_bbox(mask) is not None:
            close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel, iterations=1)
            radius = max(3, min(7, int(max(width, height) * 0.006)))

            telea = cv2.inpaint(frame, mask, radius, cv2.INPAINT_TELEA)
            ns = cv2.inpaint(frame, mask, radius, cv2.INPAINT_NS)

            telea_score = float(cv2.absdiff(frame, telea)[mask > 24].mean())
            ns_score = float(cv2.absdiff(frame, ns)[mask > 24].mean())
            valid = [(telea_score, telea), (ns_score, ns)]
            valid = [item for item in valid if item[0] >= UNCHANGED_THRESHOLD]
            if not valid:
                raise RuntimeError("OpenCV fallback could not remove the selected region cleanly")

            score, candidate = min(valid, key=lambda item: item[0])
            frame = candidate
            changes.append(score)

        writer.write(frame)
        frame_index += 1
        written += 1

    cap.release()
    writer.release()

    if written <= 0 or not raw_output.exists() or raw_output.stat().st_size <= 0:
        raise RuntimeError("OpenCV fallback did not write any frames")

    avg_change = sum(changes) / len(changes) if changes else 0.0
    print(f"OpenCV tracked inpaint wrote frames={written} avg_mask_change={avg_change:.3f}", flush=True)

    try:
        run([
            "ffmpeg",
            "-y",
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
            str(normalized_output),
        ])
        if normalized_output.exists() and normalized_output.stat().st_size > 0:
            return normalized_output
    except Exception as exc:
        print(f"OpenCV fallback normalization failed, using raw mp4: {exc}", flush=True)

    return raw_output


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
    mask_dir = work_dir / "sam2_remove_masks"
    result_root = work_dir / "propainter_results"

    prepare_source_mp4(input_video, source_mp4)
    fps, width, height = read_video_meta(source_mp4)

    tracked_masks = build_tracked_masks(source_mp4, input_mask, mask_dir, fps, width, height)

    try:
        inpainted = run_propainter(source_mp4, tracked_masks, result_root, width, height, output_quality)
        change_score = masked_change_score(source_mp4, inpainted, tracked_masks, width, height)
        print(f"ProPainter masked-region change score={change_score:.3f}", flush=True)

        if change_score < UNCHANGED_THRESHOLD:
            print("ProPainter output looked unchanged; forcing OpenCV fallback.", flush=True)
            inpainted = run_opencv_tracked_inpaint(source_mp4, tracked_masks, work_dir, fps)

    except RuntimeError as exc:
        if not is_resource_pressure_failure(str(exc)):
            raise
        print("ProPainter CUDA OOM detected; falling back to tracked OpenCV inpaint.", flush=True)
        inpainted = run_opencv_tracked_inpaint(source_mp4, tracked_masks, work_dir, fps)

    mux_audio(inpainted, source_mp4, output_video, width, height, fps, output_quality)

    if not output_video.exists() or output_video.stat().st_size <= 0:
        raise RuntimeError("Eraser pipeline did not create output video")


if __name__ == "__main__":
    main()

