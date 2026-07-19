from __future__ import annotations

"""eTreyser production pipeline.

The runtime order is intentionally fixed:

1. Frame extraction
2. Optical-flow tracking
3. Wan VACE diffusion inpainting
4. Audio-preserving export

Legacy segmentation and temporal-paint entrypoints are not imported or executed here.
"""

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

from sam2_refinement import build_semantic_composite_masks

WAN_ROOT = Path(os.environ.get("WAN_ROOT", "/opt/Wan2.1"))
WAN_CKPT_DIR = Path(os.environ.get("WAN_CKPT_DIR", "/models/Wan2.1-VACE-1.3B"))
DIFFUSION_FPS = float(os.environ.get("ERASER_DIFFUSION_FPS", "16"))
DIFFUSION_CORE_FRAMES = max(17, min(73, int(os.environ.get("ERASER_DIFFUSION_CORE_FRAMES", "65"))))
DIFFUSION_OVERLAP_FRAMES = max(2, min(16, int(os.environ.get("ERASER_DIFFUSION_OVERLAP_FRAMES", "8"))))
DIFFUSION_STEPS = max(8, min(50, int(os.environ.get("ERASER_DIFFUSION_STEPS", "24"))))
DIFFUSION_SHIFT = float(os.environ.get("ERASER_DIFFUSION_SHIFT", "16"))
DIFFUSION_GUIDANCE = float(os.environ.get("ERASER_DIFFUSION_GUIDANCE", "5"))
DIFFUSION_SEED = int(os.environ.get("ERASER_DIFFUSION_SEED", "271828"))
TRACK_MAX_SIDE = max(320, int(os.environ.get("ERASER_TRACK_MAX_SIDE", "960")))
MASK_DILATION_PX = max(0, min(10, int(os.environ.get("ERASER_MASK_DILATION_PX", "2"))))
MAX_VACE_FRAMES = 81


def emit_stage(name: str, progress: int, message: str) -> None:
    payload = {"name": name, "progress": progress, "message": message}
    print(f"PIPELINE_STAGE:{json.dumps(payload, separators=(',', ':'))}", flush=True)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        output = (completed.stdout or "")[-10000:]
        raise RuntimeError(
            f"Command failed with exit code {completed.returncode}: {' '.join(command)}\n{output}".rstrip()
        )
    return completed.stdout or ""


def mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask > 24)
    if len(xs) == 0 or len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def mask_area(mask: np.ndarray) -> int:
    return int(np.count_nonzero(mask > 24))


def read_video_meta(path: Path) -> tuple[float, int, int, int]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {path}")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    if fps <= 0 or width <= 0 or height <= 0 or frames <= 0:
        raise RuntimeError(
            f"Invalid video metadata: fps={fps}, width={width}, height={height}, frames={frames}"
        )
    return fps, width, height, frames


def video_frame_count(path: Path) -> int:
    return read_video_meta(path)[3]


def prepare_source(input_video: Path, source_mp4: Path) -> None:
    source_mp4.unlink(missing_ok=True)
    try:
        run(
            [
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
            ]
        )
    except RuntimeError:
        run(
            [
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
                "16",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                str(source_mp4),
            ]
        )


def tracking_dimensions(source_width: int, source_height: int) -> tuple[int, int]:
    scale = min(1.0, TRACK_MAX_SIDE / max(source_width, source_height))
    width = max(16, int(round(source_width * scale)))
    height = max(16, int(round(source_height * scale)))
    return width, height


def extract_frames(source_mp4: Path, frames_dir: Path) -> tuple[float, int, int, int, int, int]:
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    fps, source_width, source_height, expected_frames = read_video_meta(source_mp4)
    track_width, track_height = tracking_dimensions(source_width, source_height)
    cap = cv2.VideoCapture(str(source_mp4))
    extracted = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame.shape[1] != track_width or frame.shape[0] != track_height:
            frame = cv2.resize(frame, (track_width, track_height), interpolation=cv2.INTER_AREA)
        frame_path = frames_dir / f"{extracted:06d}.png"
        if not cv2.imwrite(str(frame_path), frame, [int(cv2.IMWRITE_PNG_COMPRESSION), 2]):
            cap.release()
            raise RuntimeError(f"Could not write extracted frame {extracted}")
        extracted += 1
    cap.release()

    if extracted <= 0:
        raise RuntimeError("Frame extraction produced no frames")
    if abs(extracted - expected_frames) > 1:
        raise RuntimeError(
            f"Frame extraction mismatch: expected={expected_frames}, extracted={extracted}"
        )
    print(
        "Frame extraction complete: "
        f"frames={extracted}, source={source_width}x{source_height}, "
        f"tracking={track_width}x{track_height}, fps={fps:.6f}",
        flush=True,
    )
    return fps, source_width, source_height, extracted, track_width, track_height


def selected_anchor_frame(fps: float, frame_count: int) -> int:
    raw_index = os.environ.get("ERASER_SELECTED_FRAME_INDEX", "").strip()
    raw_time = os.environ.get("ERASER_SELECTED_TIME", "").strip()
    try:
        if raw_index:
            index = int(round(float(raw_index)))
        elif raw_time:
            index = int(round(float(raw_time) * fps))
        else:
            index = 0
    except Exception:
        index = 0
    return max(0, min(index, frame_count - 1))


def read_frame(frames_dir: Path, index: int) -> np.ndarray:
    frame = cv2.imread(str(frames_dir / f"{index:06d}.png"), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError(f"Could not read extracted frame {index}")
    return frame


def read_painted_mask(path: Path, width: int, height: int) -> np.ndarray:
    raw = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise RuntimeError(f"Could not read painted mask: {path}")
    if raw.ndim == 3 and raw.shape[2] == 4:
        mask = raw[:, :, 3]
    elif raw.ndim == 3:
        mask = cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)
    else:
        mask = raw
    if mask.shape[1] != width or mask.shape[0] != height:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    mask = (mask > 24).astype(np.uint8) * 255
    if mask_bbox(mask) is None:
        raise RuntimeError("Painted mask is empty")
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )
    if MASK_DILATION_PX > 0:
        kernel_size = MASK_DILATION_PX * 2 + 1
        mask = cv2.dilate(
            mask,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size)),
            iterations=1,
        )
    return mask


def mask_center(mask: np.ndarray) -> tuple[float, float]:
    bbox = mask_bbox(mask)
    if bbox is None:
        return 0.0, 0.0
    x1, y1, x2, y2 = bbox
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


def is_fixed_screen_selection(mask: np.ndarray, width: int, height: int) -> bool:
    bbox = mask_bbox(mask)
    if bbox is None:
        return False
    x1, y1, x2, y2 = bbox
    box_width = x2 - x1 + 1
    box_height = y2 - y1 + 1
    center_x = (x1 + x2) / 2.0
    center_y = (y1 + y2) / 2.0
    area_ratio = mask_area(mask) / max(width * height, 1)
    nearest_edge = min(x1, y1, width - 1 - x2, height - 1 - y2)
    inset_margin = max(8, int(round(min(width, height) * 0.10)))
    near_corner = (
        (center_x <= width * 0.27 or center_x >= width * 0.73)
        and (center_y <= height * 0.27 or center_y >= height * 0.73)
    )
    compact = box_width <= width * 0.30 and box_height <= height * 0.30
    return compact and area_ratio <= 0.06 and (nearest_edge <= inset_margin or near_corner)


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


def sparse_flow_translation(
    previous_frame: np.ndarray,
    current_frame: np.ndarray,
    previous_mask: np.ndarray,
) -> tuple[float, float] | None:
    previous_gray = cv2.cvtColor(previous_frame, cv2.COLOR_BGR2GRAY)
    current_gray = cv2.cvtColor(current_frame, cv2.COLOR_BGR2GRAY)
    feature_mask = cv2.dilate(
        (previous_mask > 24).astype(np.uint8) * 255,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
        iterations=1,
    )
    points = cv2.goodFeaturesToTrack(
        previous_gray,
        maxCorners=160,
        qualityLevel=0.003,
        minDistance=3,
        mask=feature_mask,
        blockSize=5,
    )
    if points is None or len(points) < 3:
        return None
    tracked, status, errors = cv2.calcOpticalFlowPyrLK(
        previous_gray,
        current_gray,
        points,
        None,
        winSize=(31, 31),
        maxLevel=4,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01),
    )
    if tracked is None or status is None:
        return None
    valid = status.reshape(-1) > 0
    if errors is not None:
        valid &= errors.reshape(-1) < 40
    if int(np.count_nonzero(valid)) < 3:
        return None
    displacement = tracked.reshape(-1, 2)[valid] - points.reshape(-1, 2)[valid]
    return float(np.median(displacement[:, 0])), float(np.median(displacement[:, 1]))


def largest_component_near(mask: np.ndarray, center: tuple[float, float]) -> np.ndarray:
    binary = (mask > 24).astype(np.uint8)
    count, labels, stats, centers = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count <= 1:
        return binary * 255
    best_component = 0
    best_score = float("inf")
    for component in range(1, count):
        area = int(stats[component, cv2.CC_STAT_AREA])
        if area <= 0:
            continue
        cx, cy = centers[component]
        score = math.hypot(cx - center[0], cy - center[1]) - min(area, 10000) * 0.0005
        if score < best_score:
            best_score = score
            best_component = component
    output = np.zeros_like(binary)
    if best_component > 0:
        output[labels == best_component] = 255
    return output.astype(np.uint8)


def dense_optical_flow_warp(
    previous_frame: np.ndarray,
    current_frame: np.ndarray,
    previous_mask: np.ndarray,
) -> np.ndarray:
    previous_gray = cv2.cvtColor(previous_frame, cv2.COLOR_BGR2GRAY)
    current_gray = cv2.cvtColor(current_frame, cv2.COLOR_BGR2GRAY)

    # Backward flow supplies the source coordinates needed by cv2.remap to
    # transport the previous mask into the current frame.
    backward_flow = cv2.calcOpticalFlowFarneback(
        current_gray,
        previous_gray,
        None,
        0.5,
        5,
        25,
        5,
        7,
        1.5,
        0,
    )
    height, width = previous_mask.shape[:2]
    grid_x, grid_y = np.meshgrid(
        np.arange(width, dtype=np.float32),
        np.arange(height, dtype=np.float32),
    )
    warped = cv2.remap(
        previous_mask,
        grid_x + backward_flow[..., 0],
        grid_y + backward_flow[..., 1],
        interpolation=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    warped = (warped > 24).astype(np.uint8) * 255

    previous_area = max(mask_area(previous_mask), 1)
    warped_area = mask_area(warped)
    if warped_area < previous_area * 0.45 or warped_area > previous_area * 2.2:
        translation = sparse_flow_translation(previous_frame, current_frame, previous_mask)
        warped = (
            translate_mask(previous_mask, translation[0], translation[1])
            if translation is not None
            else previous_mask.copy()
        )

    warped = largest_component_near(warped, mask_center(warped))
    return cv2.morphologyEx(
        warped,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )


def is_scene_cut(previous_frame: np.ndarray, current_frame: np.ndarray) -> bool:
    previous_small = cv2.resize(previous_frame, (160, 90), interpolation=cv2.INTER_AREA)
    current_small = cv2.resize(current_frame, (160, 90), interpolation=cv2.INTER_AREA)
    mean_delta = float(cv2.absdiff(previous_small, current_small).mean())
    return mean_delta >= float(os.environ.get("ERASER_SCENE_CUT_THRESHOLD", "48"))


def reacquire_from_anchor(
    anchor_frame: np.ndarray,
    current_frame: np.ndarray,
    anchor_mask: np.ndarray,
) -> np.ndarray | None:
    bbox = mask_bbox(anchor_mask)
    if bbox is None:
        return None
    x1, y1, x2, y2 = bbox
    template = anchor_frame[y1 : y2 + 1, x1 : x2 + 1]
    template_mask = anchor_mask[y1 : y2 + 1, x1 : x2 + 1]
    if (
        template.size == 0
        or current_frame.shape[0] < template.shape[0]
        or current_frame.shape[1] < template.shape[1]
    ):
        return None
    result = cv2.matchTemplate(current_frame, template, cv2.TM_CCORR_NORMED, mask=template_mask)
    _minimum, score, _minimum_location, location = cv2.minMaxLoc(result)
    if not np.isfinite(score) or score < 0.84:
        return None
    return translate_mask(anchor_mask, float(location[0] - x1), float(location[1] - y1))


def track_masks_with_optical_flow(
    frames_dir: Path,
    painted_mask_path: Path,
    masks_dir: Path,
    frame_count: int,
    width: int,
    height: int,
    anchor_index: int,
) -> Path:
    if masks_dir.exists():
        shutil.rmtree(masks_dir)
    masks_dir.mkdir(parents=True, exist_ok=True)

    anchor_frame = read_frame(frames_dir, anchor_index)
    anchor_mask = read_painted_mask(painted_mask_path, width, height)
    fixed_screen_position = is_fixed_screen_selection(anchor_mask, width, height)
    tracked_masks: dict[int, np.ndarray] = {anchor_index: anchor_mask}
    cut_reacquisitions = 0

    for direction in (1, -1):
        previous_frame = anchor_frame
        previous_mask = anchor_mask
        index = anchor_index + direction
        while 0 <= index < frame_count:
            current_frame = read_frame(frames_dir, index)
            if fixed_screen_position:
                current_mask = anchor_mask.copy()
            else:
                current_mask = dense_optical_flow_warp(previous_frame, current_frame, previous_mask)
                if is_scene_cut(previous_frame, current_frame):
                    reacquired = reacquire_from_anchor(anchor_frame, current_frame, anchor_mask)
                    if reacquired is not None:
                        current_mask = reacquired
                        cut_reacquisitions += 1
            tracked_masks[index] = current_mask
            previous_frame = current_frame
            previous_mask = current_mask
            index += direction

    anchor_area = max(mask_area(anchor_mask), 1)
    for index in range(frame_count):
        mask = tracked_masks.get(index)
        if mask is None or mask_bbox(mask) is None:
            raise RuntimeError(f"Optical-flow tracker lost the selection at frame {index}")
        area = mask_area(mask)
        if not fixed_screen_position and not (anchor_area * 0.30 <= area <= anchor_area * 3.0):
            raise RuntimeError(
                f"Optical-flow mask became unstable at frame {index}: anchor_area={anchor_area}, area={area}"
            )
        if not cv2.imwrite(str(masks_dir / f"{index:06d}.png"), mask):
            raise RuntimeError(f"Could not write tracked mask {index}")

    sample_indexes = sorted(
        {0, anchor_index, frame_count // 4, frame_count // 2, frame_count * 3 // 4, frame_count - 1}
    )
    samples = [
        {
            "frame": index,
            "bbox": mask_bbox(tracked_masks[index]),
            "area": mask_area(tracked_masks[index]),
        }
        for index in sample_indexes
    ]
    print(
        "Optical-flow tracking complete: "
        f"frames={frame_count}, fixed_screen_position={fixed_screen_position}, "
        f"scene_cut_reacquisitions={cut_reacquisitions}, samples={json.dumps(samples)}",
        flush=True,
    )
    return masks_dir


def fixed_repair_roi(
    source_mask: np.ndarray,
    source_width: int,
    source_height: int,
) -> tuple[int, int, int, int] | None:
    """Create a context-rich ROI that gives a compact mark more VACE pixels."""
    bbox = mask_bbox(source_mask)
    if bbox is None:
        return None
    x1, y1, x2, y2 = bbox
    mask_width = x2 - x1 + 1
    mask_height = y2 - y1 + 1
    area_ratio = mask_area(source_mask) / float(max(source_width * source_height, 1))
    if area_ratio > 0.065 or mask_width > source_width * 0.32 or mask_height > source_height * 0.32:
        return None

    target_aspect = 832.0 / 480.0 if source_width >= source_height else 480.0 / 832.0
    minimum_height = max(128, int(round(mask_height * 3.2)))
    minimum_width = max(128, int(round(mask_width * 3.2)))
    roi_height = minimum_height
    roi_width = max(minimum_width, int(round(roi_height * target_aspect)))
    if roi_width / max(roi_height, 1) < target_aspect:
        roi_width = int(round(roi_height * target_aspect))
    else:
        roi_height = max(roi_height, int(round(roi_width / target_aspect)))
    roi_width = min(source_width, max(mask_width + 24, roi_width))
    roi_height = min(source_height, max(mask_height + 24, roi_height))
    roi_width -= roi_width % 2
    roi_height -= roi_height % 2

    center_x = (x1 + x2) / 2.0
    center_y = (y1 + y2) / 2.0
    roi_x = int(round(center_x - roi_width / 2.0))
    roi_y = int(round(center_y - roi_height / 2.0))
    roi_x = max(0, min(roi_x, source_width - roi_width))
    roi_y = max(0, min(roi_y, source_height - roi_height))
    if not (
        roi_x <= x1
        and roi_y <= y1
        and roi_x + roi_width > x2
        and roi_y + roi_height > y2
    ):
        return None
    return roi_x, roi_y, roi_width, roi_height


def crop_source_for_fixed_roi(
    source_video: Path,
    destination: Path,
    roi: tuple[int, int, int, int],
) -> Path:
    x, y, width, height = roi
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_video),
            "-map",
            "0:v:0",
            "-vf",
            f"crop={width}:{height}:{x}:{y}",
            "-an",
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-g",
            "1",
            "-pix_fmt",
            "yuv444p",
            str(destination),
        ]
    )
    return destination


def crop_masks_for_fixed_roi(
    masks_dir: Path,
    destination: Path,
    frame_count: int,
    tracking_width: int,
    tracking_height: int,
    source_width: int,
    source_height: int,
    roi: tuple[int, int, int, int],
) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)
    x, y, width, height = roi
    for index in range(frame_count):
        mask = cv2.imread(str(masks_dir / f"{index:06d}.png"), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise RuntimeError(f"Could not read tracked mask for fixed ROI at frame {index}")
        if mask.shape[1] != tracking_width or mask.shape[0] != tracking_height:
            mask = cv2.resize(mask, (tracking_width, tracking_height), interpolation=cv2.INTER_NEAREST)
        source_mask = cv2.resize(mask, (source_width, source_height), interpolation=cv2.INTER_NEAREST)
        cropped = source_mask[y : y + height, x : x + width]
        if cropped.shape != (height, width):
            raise RuntimeError(f"Fixed ROI mask crop changed geometry at frame {index}")
        if not cv2.imwrite(str(destination / f"{index:06d}.png"), cropped):
            raise RuntimeError(f"Could not write fixed ROI mask {index}")
    return destination


def vace_dimensions(source_width: int, source_height: int) -> tuple[int, int, str]:
    return (480, 832, "480*832") if source_height > source_width else (832, 480, "832*480")


def letterbox_geometry(
    source_width: int,
    source_height: int,
    target_width: int,
    target_height: int,
) -> tuple[int, int, int, int]:
    scale = min(target_width / source_width, target_height / source_height)
    scaled_width = max(2, int(round(source_width * scale)))
    scaled_height = max(2, int(round(source_height * scale)))
    scaled_width -= scaled_width % 2
    scaled_height -= scaled_height % 2
    pad_x = (target_width - scaled_width) // 2
    pad_y = (target_height - scaled_height) // 2
    return scaled_width, scaled_height, pad_x, pad_y


def build_vace_source(
    source_mp4: Path,
    destination: Path,
    source_width: int,
    source_height: int,
    target_width: int,
    target_height: int,
) -> tuple[int, int, int, int]:
    scaled_width, scaled_height, pad_x, pad_y = letterbox_geometry(
        source_width,
        source_height,
        target_width,
        target_height,
    )
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_mp4),
            "-map",
            "0:v:0",
            "-vf",
            (
                f"scale={scaled_width}:{scaled_height}:flags=lanczos,"
                f"pad={target_width}:{target_height}:{pad_x}:{pad_y}:color=black,"
                f"fps={DIFFUSION_FPS:.6f},format=yuv420p"
            ),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "14",
            "-movflags",
            "+faststart",
            str(destination),
        ]
    )
    return scaled_width, scaled_height, pad_x, pad_y


def build_vace_mask_video(
    tracked_masks_dir: Path,
    source_fps: float,
    tracking_width: int,
    tracking_height: int,
    source_frame_count: int,
    destination: Path,
    target_width: int,
    target_height: int,
) -> int:
    mask_frames_dir = destination.parent / "vace_mask_frames"
    if mask_frames_dir.exists():
        shutil.rmtree(mask_frames_dir)
    mask_frames_dir.mkdir(parents=True, exist_ok=True)

    duration = source_frame_count / source_fps
    target_frame_count = max(1, int(round(duration * DIFFUSION_FPS)))
    scaled_width, scaled_height, pad_x, pad_y = letterbox_geometry(
        tracking_width,
        tracking_height,
        target_width,
        target_height,
    )

    for target_index in range(target_frame_count):
        source_index = min(
            source_frame_count - 1,
            int(round(target_index * source_fps / DIFFUSION_FPS)),
        )
        mask = cv2.imread(
            str(tracked_masks_dir / f"{source_index:06d}.png"),
            cv2.IMREAD_GRAYSCALE,
        )
        if mask is None:
            raise RuntimeError(f"Tracked mask is missing at frame {source_index}")
        resized = cv2.resize(mask, (scaled_width, scaled_height), interpolation=cv2.INTER_NEAREST)
        canvas = np.zeros((target_height, target_width), dtype=np.uint8)
        canvas[pad_y : pad_y + scaled_height, pad_x : pad_x + scaled_width] = resized
        canvas = (canvas > 24).astype(np.uint8) * 255
        if not cv2.imwrite(str(mask_frames_dir / f"{target_index:06d}.png"), canvas):
            raise RuntimeError(f"Could not write VACE mask frame {target_index}")

    run(
        [
            "ffmpeg",
            "-y",
            "-framerate",
            f"{DIFFUSION_FPS:.6f}",
            "-i",
            str(mask_frames_dir / "%06d.png"),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(destination),
        ]
    )
    print(
        f"VACE mask video complete: frames={target_frame_count}, semantics=white_generate_black_preserve",
        flush=True,
    )
    return target_frame_count



def build_vace_condition_video(
    normalized_source: Path,
    mask_video: Path,
    destination: Path,
) -> Path:
    source_cap = cv2.VideoCapture(str(normalized_source))
    mask_cap = cv2.VideoCapture(str(mask_video))
    if not source_cap.isOpened() or not mask_cap.isOpened():
        source_cap.release()
        mask_cap.release()
        raise RuntimeError("Could not open normalized source and VACE mask")

    width = int(source_cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(source_cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    raw_destination = destination.with_suffix(".raw.mp4")
    writer = cv2.VideoWriter(
        str(raw_destination),
        cv2.VideoWriter_fourcc(*"mp4v"),
        DIFFUSION_FPS,
        (width, height),
    )
    if not writer.isOpened():
        source_cap.release()
        mask_cap.release()
        raise RuntimeError("Could not create VACE condition video")

    frame_count = 0
    while True:
        ok_source, source_frame = source_cap.read()
        if not ok_source:
            break
        ok_mask, mask_frame = mask_cap.read()
        if not ok_mask:
            source_cap.release()
            mask_cap.release()
            writer.release()
            raise RuntimeError(f"VACE mask ended before source frame {frame_count}")
        if mask_frame.shape[1] != width or mask_frame.shape[0] != height:
            mask_frame = cv2.resize(mask_frame, (width, height), interpolation=cv2.INTER_NEAREST)
        mask_gray = cv2.cvtColor(mask_frame, cv2.COLOR_BGR2GRAY)
        conditioned = source_frame.copy()
        conditioned[mask_gray >= 128] = 127
        writer.write(conditioned)
        frame_count += 1

    source_cap.release()
    mask_cap.release()
    writer.release()
    if frame_count <= 0:
        raise RuntimeError("VACE condition video wrote no frames")

    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(raw_destination),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "14",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(destination),
        ]
    )
    print(
        f"VACE condition video complete: frames={frame_count}, generated_regions_gray=127",
        flush=True,
    )
    return destination

def allowed_vace_frame_count(raw_frame_count: int) -> int:
    raw_frame_count = max(1, min(MAX_VACE_FRAMES, raw_frame_count))
    allowed = int(math.ceil(max(raw_frame_count - 1, 0) / 4.0) * 4 + 1)
    return max(5, min(MAX_VACE_FRAMES, allowed))


def extract_chunk(source: Path, destination: Path, start_frame: int, end_frame: int) -> None:
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
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
            str(destination),
        ]
    )


def pad_chunk(source: Path, destination: Path, current_frames: int, target_frames: int) -> None:
    if target_frames <= current_frames:
        shutil.copy2(source, destination)
        return
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-vf",
            f"tpad=stop_mode=clone:stop={target_frames - current_frames}",
            "-frames:v",
            str(target_frames),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            str(destination),
        ]
    )


def run_vace_chunk(
    source_chunk: Path,
    mask_chunk: Path,
    destination: Path,
    size_name: str,
    frame_count: int,
    chunk_index: int,
) -> None:
    generate_script = WAN_ROOT / "generate.py"
    if not generate_script.exists():
        raise RuntimeError(f"Wan VACE generate.py is missing at {generate_script}")
    if not WAN_CKPT_DIR.exists():
        raise RuntimeError(f"Wan VACE checkpoint is missing at {WAN_CKPT_DIR}")

    prompt = os.environ.get(
        "ERASER_DIFFUSION_PROMPT",
        (
            "Remove only the white-masked object and reconstruct the natural background. "
            "Match the original lighting, texture, perspective, depth, camera motion and grain. "
            "Preserve all black-masked pixels, people, faces, clothing and scene composition. "
            "Do not add text, logos, artifacts or new objects."
        ),
    )
    command = [
        "python",
        "-u",
        "generate.py",
        "--task",
        "vace-1.3B",
        "--size",
        size_name,
        "--ckpt_dir",
        str(WAN_CKPT_DIR),
        "--src_video",
        str(source_chunk),
        "--src_mask",
        str(mask_chunk),
        "--prompt",
        prompt,
        "--frame_num",
        str(frame_count),
        "--sample_steps",
        str(DIFFUSION_STEPS),
        "--sample_shift",
        str(DIFFUSION_SHIFT),
        "--sample_guide_scale",
        str(DIFFUSION_GUIDANCE),
        "--base_seed",
        str(DIFFUSION_SEED + chunk_index),
        "--offload_model",
        "True",
        "--t5_cpu",
        "--save_file",
        str(destination),
    ]
    env = os.environ.copy()
    env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True,max_split_size_mb:128")
    print(
        f"Running Wan VACE diffusion chunk {chunk_index + 1}: frames={frame_count}, size={size_name}, steps={DIFFUSION_STEPS}",
        flush=True,
    )
    run(command, cwd=WAN_ROOT, env=env)
    if not destination.exists() or destination.stat().st_size <= 0:
        raise RuntimeError(f"Wan VACE did not create output: {destination}")


def trim_generated_chunk(
    generated: Path,
    destination: Path,
    keep_start: int,
    keep_count: int,
) -> None:
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(generated),
            "-vf",
            f"trim=start_frame={keep_start}:end_frame={keep_start + keep_count},setpts=PTS-STARTPTS",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "14",
            "-pix_fmt",
            "yuv420p",
            str(destination),
        ]
    )
    actual_frames = video_frame_count(destination)
    if abs(actual_frames - keep_count) > 1:
        raise RuntimeError(
            f"Diffusion chunk trim mismatch: expected={keep_count}, actual={actual_frames}"
        )


def concatenate_chunks(chunks: list[Path], destination: Path) -> Path:
    if not chunks:
        raise RuntimeError("No diffusion chunks were generated")
    if len(chunks) == 1:
        shutil.copy2(chunks[0], destination)
        return destination
    concat_file = destination.parent / "diffusion_chunks.txt"
    concat_file.write_text(
        "".join(f"file '{path.as_posix()}'\n" for path in chunks),
        encoding="utf-8",
    )
    try:
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
                "-c",
                "copy",
                str(destination),
            ]
        )
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
                "veryfast",
                "-crf",
                "14",
                "-pix_fmt",
                "yuv420p",
                str(destination),
            ]
        )
    return destination


def run_diffusion_inpainting(
    source_video: Path,
    mask_video: Path,
    destination: Path,
    size_name: str,
) -> Path:
    source_frames = video_frame_count(source_video)
    mask_frames = video_frame_count(mask_video)
    if mask_frames < max(1, source_frames - 1):
        raise RuntimeError(
            f"VACE mask is shorter than source: source={source_frames}, mask={mask_frames}"
        )

    workspace = destination.parent / "diffusion_chunks"
    if workspace.exists():
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True, exist_ok=True)

    completed_chunks: list[Path] = []
    chunk_total = max(1, int(math.ceil(source_frames / DIFFUSION_CORE_FRAMES)))
    core_start = 0
    chunk_index = 0
    while core_start < source_frames:
        emit_stage(
            "diffusion_inpainting",
            50 + int(32 * chunk_index / chunk_total),
            f"Running diffusion chunk {chunk_index + 1} of {chunk_total}",
        )
        core_end = min(source_frames, core_start + DIFFUSION_CORE_FRAMES)
        context_start = max(0, core_start - DIFFUSION_OVERLAP_FRAMES)
        context_end = min(source_frames, core_end + DIFFUSION_OVERLAP_FRAMES)
        raw_context_frames = context_end - context_start
        vace_frames = allowed_vace_frame_count(raw_context_frames)

        chunk_root = workspace / f"chunk_{chunk_index:03d}"
        chunk_root.mkdir(parents=True, exist_ok=True)
        source_raw = chunk_root / "source_raw.mp4"
        mask_raw = chunk_root / "mask_raw.mp4"
        source_chunk = chunk_root / "source.mp4"
        mask_chunk = chunk_root / "mask.mp4"
        generated = chunk_root / "generated.mp4"
        kept = chunk_root / "kept.mp4"

        extract_chunk(source_video, source_raw, context_start, context_end)
        extract_chunk(mask_video, mask_raw, context_start, context_end)
        pad_chunk(source_raw, source_chunk, raw_context_frames, vace_frames)
        pad_chunk(mask_raw, mask_chunk, raw_context_frames, vace_frames)
        run_vace_chunk(source_chunk, mask_chunk, generated, size_name, vace_frames, chunk_index)

        keep_start = core_start - context_start
        keep_count = core_end - core_start
        trim_generated_chunk(generated, kept, keep_start, keep_count)
        completed_chunks.append(kept)
        print(
            "Wan VACE diffusion chunk complete: "
            f"chunk={chunk_index + 1}, context={context_start}-{context_end - 1}, "
            f"keep={core_start}-{core_end - 1}",
            flush=True,
        )
        emit_stage(
            "diffusion_inpainting",
            50 + int(32 * (chunk_index + 1) / chunk_total),
            f"Completed diffusion chunk {chunk_index + 1} of {chunk_total}",
        )
        core_start = core_end
        chunk_index += 1

    concatenate_chunks(completed_chunks, destination)
    output_frames = video_frame_count(destination)
    if abs(output_frames - source_frames) > 2:
        raise RuntimeError(
            f"Diffusion output frame mismatch: expected={source_frames}, actual={output_frames}"
        )
    print(
        f"Diffusion inpainting complete: chunks={len(completed_chunks)}, frames={output_frames}",
        flush=True,
    )
    return destination


def prepare_repair_at_source_geometry(
    diffusion_video: Path,
    destination: Path,
    source_width: int,
    source_height: int,
    source_fps: float,
    source_frame_count: int,
    scaled_width: int,
    scaled_height: int,
    pad_x: int,
    pad_y: int,
) -> Path:
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(diffusion_video),
            "-vf",
            (
                f"crop={scaled_width}:{scaled_height}:{pad_x}:{pad_y},"
                f"scale={source_width}:{source_height}:flags=lanczos,"
                f"fps={source_fps:.6f},"
                f"tpad=stop_mode=clone:stop_duration=2,format=yuv420p"
            ),
            "-frames:v",
            str(source_frame_count),
            "-an",
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-g",
            "1",
            "-pix_fmt",
            "yuv444p",
            str(destination),
        ]
    )
    return destination


def robust_mad(values: np.ndarray) -> float:
    flattened = np.asarray(values, dtype=np.float32).reshape(-1)
    if flattened.size <= 0:
        return 0.0
    median = float(np.median(flattened))
    return float(np.median(np.abs(flattened - median)) * 1.4826)


def nearest_background_texture(
    source_frame: np.ndarray,
    binary_mask: np.ndarray,
) -> np.ndarray:
    """Extend real source high-frequency residuals inward from the matte edge."""
    binary = (binary_mask > 24).astype(np.uint8)
    source_float = source_frame.astype(np.float32)
    source_high = source_float - cv2.GaussianBlur(source_float, (0, 0), 1.0)
    _distance, labels = cv2.distanceTransformWithLabels(
        binary,
        cv2.DIST_L2,
        5,
        labelType=cv2.DIST_LABEL_PIXEL,
    )
    outside = binary == 0
    outside_labels = labels[outside]
    outside_y, outside_x = np.where(outside)
    maximum_label = int(labels.max())
    map_y = np.zeros((maximum_label + 1,), dtype=np.int32)
    map_x = np.zeros((maximum_label + 1,), dtype=np.int32)
    valid = (outside_labels > 0) & (outside_labels <= maximum_label)
    map_y[outside_labels[valid]] = outside_y[valid]
    map_x[outside_labels[valid]] = outside_x[valid]
    nearest_y = map_y[np.clip(labels, 0, maximum_label)]
    nearest_x = map_x[np.clip(labels, 0, maximum_label)]
    return source_high[nearest_y, nearest_x]


def transfer_local_texture(
    source_frame: np.ndarray,
    corrected_repair: np.ndarray,
    binary_mask: np.ndarray,
    outer_ring: np.ndarray,
) -> tuple[np.ndarray, float]:
    """Add only the missing amount of real nearby texture to a smooth repair."""
    inside = binary_mask > 24
    if int(np.count_nonzero(inside)) < 16 or int(np.count_nonzero(outer_ring)) < 16:
        return corrected_repair, 0.0

    source_gray = cv2.cvtColor(source_frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    repair_gray = cv2.cvtColor(corrected_repair, cv2.COLOR_BGR2GRAY).astype(np.float32)
    source_high_gray = source_gray - cv2.GaussianBlur(source_gray, (0, 0), 1.0)
    repair_high_gray = repair_gray - cv2.GaussianBlur(repair_gray, (0, 0), 1.0)
    target_detail = min(6.0, max(0.0, robust_mad(source_high_gray[outer_ring])))
    current_detail = max(0.0, robust_mad(repair_high_gray[inside]))
    missing_detail = math.sqrt(max(target_detail * target_detail - current_detail * current_detail, 0.0))
    if missing_detail < 0.12:
        return corrected_repair, 0.0

    texture = nearest_background_texture(source_frame, binary_mask).astype(np.float32)
    texture_inside = texture[inside]
    channel_center = np.median(texture_inside, axis=0)
    texture -= channel_center.reshape(1, 1, 3)
    texture_gray = cv2.cvtColor(
        np.clip(texture + 128.0, 0, 255).astype(np.uint8),
        cv2.COLOR_BGR2GRAY,
    ).astype(np.float32) - 128.0
    texture_scale = max(robust_mad(texture_gray[inside]), 0.15)
    gain = float(np.clip(missing_detail / texture_scale, 0.0, 1.75))

    textured = corrected_repair.astype(np.float32)
    textured[inside] += texture[inside] * gain
    textured = np.clip(textured, 0, 255).astype(np.uint8)
    return textured, gain


def harmonize_composite_frame(
    source_frame: np.ndarray,
    repair_frame: np.ndarray,
    binary_mask: np.ndarray,
    previous_state: dict[str, np.ndarray | float | str] | None = None,
) -> tuple[
    np.ndarray,
    dict[str, np.ndarray | float | str],
    dict[str, float | str],
]:
    """Select the least-visible repair blend while preserving source pixels.

    The repair is first aligned to the local source color in LAB space. Three
    edge-safe candidates are then evaluated: gradient-domain cloning, cosine
    inward blending, and linear inward blending. The candidate with the lowest
    boundary discontinuity and closest local texture ratio wins. Nothing outside
    the final matte is ever changed.
    """
    binary = (binary_mask > 24).astype(np.uint8) * 255
    bbox = mask_bbox(binary)
    if bbox is None:
        return source_frame.copy(), {}, {"mask_pixels": 0.0, "blend_mode": "none"}
    x1, y1, x2, y2 = bbox
    minimum_side = max(1, min(x2 - x1 + 1, y2 - y1 + 1))

    ring_radius = max(5, min(15, int(round(minimum_side * 0.20))))
    ring_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (ring_radius * 2 + 1, ring_radius * 2 + 1),
    )
    outer_ring = (cv2.dilate(binary, ring_kernel, iterations=1) > 0) & (binary == 0)
    if int(np.count_nonzero(outer_ring)) < 24:
        outer_ring = binary == 0

    source_lab = cv2.cvtColor(source_frame, cv2.COLOR_BGR2LAB).astype(np.float32)
    repair_lab = cv2.cvtColor(repair_frame, cv2.COLOR_BGR2LAB).astype(np.float32)
    measured_shift = np.median(source_lab[outer_ring] - repair_lab[outer_ring], axis=0).astype(np.float32)
    measured_shift = np.clip(
        measured_shift,
        np.asarray([-24.0, -10.0, -10.0], dtype=np.float32),
        np.asarray([24.0, 10.0, 10.0], dtype=np.float32),
    )
    if previous_state:
        prior_shift = np.asarray(previous_state.get("color_shift", measured_shift), dtype=np.float32)
        color_shift = prior_shift * 0.72 + measured_shift * 0.28
    else:
        color_shift = measured_shift

    corrected_lab = np.clip(repair_lab + color_shift.reshape(1, 1, 3), 0, 255).astype(np.uint8)
    corrected = cv2.cvtColor(corrected_lab, cv2.COLOR_LAB2BGR)
    corrected, texture_transfer_gain = transfer_local_texture(
        source_frame,
        corrected,
        binary,
        outer_ring,
    )

    pad = max(4, min(12, int(round(minimum_side * 0.12))))
    crop_x1 = max(0, x1 - pad)
    crop_y1 = max(0, y1 - pad)
    crop_x2 = min(source_frame.shape[1], x2 + pad + 1)
    crop_y2 = min(source_frame.shape[0], y2 + pad + 1)
    patch = corrected[crop_y1:crop_y2, crop_x1:crop_x2]
    patch_mask = binary[crop_y1:crop_y2, crop_x1:crop_x2].copy()
    center = (crop_x1 + patch.shape[1] // 2, crop_y1 + patch.shape[0] // 2)

    clone_candidate = corrected.copy()
    clone_available = False
    if (
        patch.size > 0
        and int(np.count_nonzero(patch_mask)) > 0
        and crop_x1 > 0
        and crop_y1 > 0
        and crop_x2 < source_frame.shape[1]
        and crop_y2 < source_frame.shape[0]
    ):
        try:
            clone_candidate = cv2.seamlessClone(
                patch,
                source_frame.copy(),
                patch_mask,
                center,
                cv2.NORMAL_CLONE,
            )
            clone_available = True
        except cv2.error:
            clone_candidate = corrected.copy()

    distance = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    transition_width = max(2.5, min(7.0, minimum_side * 0.08))
    normalized_distance = np.clip(distance / transition_width, 0.0, 1.0)
    linear_alpha = np.clip((distance + 0.20) / transition_width, 0.0, 1.0)
    cosine_alpha = 0.5 - 0.5 * np.cos(normalized_distance * np.pi)
    linear_alpha[binary == 0] = 0.0
    cosine_alpha[binary == 0] = 0.0

    def alpha_composite(alpha_2d: np.ndarray) -> np.ndarray:
        alpha = alpha_2d[:, :, None].astype(np.float32)
        result = np.clip(
            corrected.astype(np.float32) * alpha
            + source_frame.astype(np.float32) * (1.0 - alpha),
            0,
            255,
        ).astype(np.uint8)
        result[binary == 0] = source_frame[binary == 0]
        return result

    candidates: dict[str, np.ndarray] = {
        "cosine": alpha_composite(cosine_alpha),
        "linear": alpha_composite(linear_alpha),
    }
    if clone_available:
        clone_candidate[binary == 0] = source_frame[binary == 0]
        candidates["gradient_clone"] = clone_candidate

    edge_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    inner_edge = (binary > 0) & (cv2.erode(binary, edge_kernel, iterations=1) == 0)
    edge_outer = (cv2.dilate(binary, edge_kernel, iterations=1) > 0) & (binary == 0)
    if int(np.count_nonzero(inner_edge)) < 8 or int(np.count_nonzero(edge_outer)) < 8:
        inner_edge = binary > 0
        edge_outer = outer_ring

    source_gray = cv2.cvtColor(source_frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    source_high = source_gray - cv2.GaussianBlur(source_gray, (0, 0), 1.0)
    source_texture = max(float(np.std(source_high[edge_outer])), 0.01)

    candidate_scores: dict[str, tuple[float, float, float]] = {}
    for mode, candidate in candidates.items():
        candidate_lab = cv2.cvtColor(candidate, cv2.COLOR_BGR2LAB).astype(np.float32)
        boundary_delta = float(
            np.abs(candidate_lab[inner_edge].mean(axis=0) - source_lab[edge_outer].mean(axis=0)).mean()
        )
        candidate_gray = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY).astype(np.float32)
        candidate_high = candidate_gray - cv2.GaussianBlur(candidate_gray, (0, 0), 1.0)
        texture_ratio = float(np.std(candidate_high[binary > 0]) / source_texture)
        texture_penalty = abs(math.log(max(texture_ratio, 0.05))) * 2.75
        score = boundary_delta + texture_penalty
        candidate_scores[mode] = (score, boundary_delta, texture_ratio)

    best_mode = min(candidate_scores, key=lambda name: candidate_scores[name][0])
    best_score = candidate_scores[best_mode][0]
    previous_mode = str(previous_state.get("blend_mode", "")) if previous_state else ""
    if previous_mode in candidate_scores:
        previous_score = candidate_scores[previous_mode][0]
        if previous_score <= best_score + max(0.08, best_score * 0.08):
            best_mode = previous_mode

    composited = candidates[best_mode]
    composited[binary == 0] = source_frame[binary == 0]
    selected_score, boundary_delta, texture_ratio = candidate_scores[best_mode]
    state: dict[str, np.ndarray | float | str] = {
        "color_shift": color_shift.astype(np.float32),
        "blend_mode": best_mode,
    }
    metrics: dict[str, float | str] = {
        "mask_pixels": float(np.count_nonzero(binary)),
        "color_shift_l": float(color_shift[0]),
        "color_shift_a": float(color_shift[1]),
        "color_shift_b": float(color_shift[2]),
        "blend_mode": best_mode,
        "blend_score": float(selected_score),
        "boundary_delta": float(boundary_delta),
        "texture_ratio": float(texture_ratio),
        "texture_transfer_gain": float(texture_transfer_gain),
        "transition_width": float(transition_width),
    }
    return composited, state, metrics


def source_preserving_composite(
    source_video: Path,
    repair_video: Path,
    composite_masks_dir: Path,
    destination: Path,
    source_fps: float,
    source_width: int,
    source_height: int,
    repair_roi: tuple[int, int, int, int] | None = None,
) -> Path:
    source_cap = cv2.VideoCapture(str(source_video))
    repair_cap = cv2.VideoCapture(str(repair_video))
    if not source_cap.isOpened() or not repair_cap.isOpened():
        source_cap.release()
        repair_cap.release()
        raise RuntimeError("Could not open source and diffusion repair for export")

    raw_output = destination.with_suffix(".raw.mkv")
    writer = cv2.VideoWriter(
        str(raw_output),
        cv2.VideoWriter_fourcc(*"FFV1"),
        source_fps,
        (source_width, source_height),
    )
    if not writer.isOpened():
        source_cap.release()
        repair_cap.release()
        raise RuntimeError("Could not create lossless source-preserving composite")

    frame_index = 0
    last_repair: np.ndarray | None = None
    previous_source: np.ndarray | None = None
    harmonizer_state: dict[str, np.ndarray | float | str] | None = None
    metric_samples: list[dict[str, float | int | str]] = []
    while True:
        ok_source, source_frame = source_cap.read()
        if not ok_source:
            break
        ok_repair, repair_frame = repair_cap.read()
        if ok_repair:
            last_repair = repair_frame
        elif last_repair is not None:
            repair_frame = last_repair
        else:
            source_cap.release()
            repair_cap.release()
            writer.release()
            raise RuntimeError(f"Diffusion repair ended before source frame {frame_index}")

        if repair_roi is not None:
            roi_x, roi_y, roi_width, roi_height = repair_roi
            if repair_frame.shape[1] != roi_width or repair_frame.shape[0] != roi_height:
                repair_frame = cv2.resize(
                    repair_frame,
                    (roi_width, roi_height),
                    interpolation=cv2.INTER_LANCZOS4,
                )
            repair_canvas = source_frame.copy()
            repair_canvas[roi_y : roi_y + roi_height, roi_x : roi_x + roi_width] = repair_frame
            repair_frame = repair_canvas
        elif repair_frame.shape[1] != source_width or repair_frame.shape[0] != source_height:
            repair_frame = cv2.resize(
                repair_frame,
                (source_width, source_height),
                interpolation=cv2.INTER_LANCZOS4,
            )
        mask = cv2.imread(
            str(composite_masks_dir / f"{frame_index:06d}.png"),
            cv2.IMREAD_GRAYSCALE,
        )
        if mask is None:
            source_cap.release()
            repair_cap.release()
            writer.release()
            raise RuntimeError(f"Composite mask is missing during export at frame {frame_index}")
        if mask.shape[1] != source_width or mask.shape[0] != source_height:
            mask = cv2.resize(mask, (source_width, source_height), interpolation=cv2.INTER_NEAREST)
        binary = (mask > 24).astype(np.uint8) * 255
        if previous_source is not None and is_scene_cut(previous_source, source_frame):
            harmonizer_state = None
        composited, harmonizer_state, metrics = harmonize_composite_frame(
            source_frame,
            repair_frame,
            binary,
            harmonizer_state,
        )
        if frame_index == 0 or frame_index % max(1, int(round(source_fps * 2.0))) == 0:
            metric_samples.append({"frame": frame_index, **metrics})
        writer.write(composited)
        previous_source = source_frame
        frame_index += 1

    source_cap.release()
    repair_cap.release()
    writer.release()
    if frame_index <= 0:
        raise RuntimeError("Source-preserving composite wrote no frames")
    print(
        "Adaptive patch harmonizer complete: "
        f"frames={frame_index}, samples={json.dumps(metric_samples, separators=(',', ':'))}",
        flush=True,
    )
    return raw_output


def has_audio(path: Path) -> bool:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    return completed.returncode == 0 and "audio" in (completed.stdout or "")


def audio_stream_hash(path: Path) -> str | None:
    if not has_audio(path):
        return None
    output = run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-c",
            "copy",
            "-f",
            "hash",
            "-hash",
            "sha256",
            "-",
        ]
    )
    for line in output.splitlines():
        normalized = line.strip()
        if normalized.startswith("SHA256="):
            return normalized
    raise RuntimeError(f"Could not hash the source audio stream: {path}")


def mux_original_audio(
    composite_video: Path,
    source_video: Path,
    output_video: Path,
    quality: str,
) -> bool:
    crf = "10" if quality == "higher" else "14"
    preset = "slow" if quality == "higher" else "medium"
    source_has_audio = has_audio(source_video)
    common = [
        "ffmpeg",
        "-y",
        "-i",
        str(composite_video),
        "-i",
        str(source_video),
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        crf,
        "-pix_fmt",
        "yuv420p",
    ]
    try:
        run(
            common
            + [
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                str(output_video),
            ]
        )
        if source_has_audio:
            print("Original audio stream copied without re-encoding", flush=True)
        return source_has_audio
    except RuntimeError as copy_error:
        if not source_has_audio:
            raise
        print(
            "Original audio codec is not MP4-copy-compatible; using high-bitrate AAC fallback: "
            f"{copy_error}",
            flush=True,
        )
        run(
            common
            + [
                "-c:a",
                "aac",
                "-b:a",
                "256k" if quality == "higher" else "192k",
                "-movflags",
                "+faststart",
                str(output_video),
            ]
        )
        return False


def validate_output(
    source_video: Path,
    output_video: Path,
    tracked_masks_dir: Path,
    anchor_index: int,
    expected_width: int,
    expected_height: int,
    expected_frames: int,
    audio_copied_bit_exactly: bool,
) -> None:
    output_fps, output_width, output_height, output_frames = read_video_meta(output_video)
    if output_width != expected_width or output_height != expected_height:
        raise RuntimeError(
            "Final dimensions changed: "
            f"expected={expected_width}x{expected_height}, actual={output_width}x{output_height}"
        )
    if abs(output_frames - expected_frames) > 2:
        raise RuntimeError(
            f"Final frame count changed: expected={expected_frames}, actual={output_frames}"
        )
    source_has_audio = has_audio(source_video)
    if source_has_audio and not has_audio(output_video):
        raise RuntimeError("Original audio was not preserved")
    if source_has_audio and audio_copied_bit_exactly:
        source_audio_hash = audio_stream_hash(source_video)
        output_audio_hash = audio_stream_hash(output_video)
        if source_audio_hash != output_audio_hash:
            raise RuntimeError(
                "Original audio packet stream changed during export: "
                f"source={source_audio_hash}, output={output_audio_hash}"
            )
        print(f"Original audio packet hash preserved: {source_audio_hash}", flush=True)

    source_cap = cv2.VideoCapture(str(source_video))
    output_cap = cv2.VideoCapture(str(output_video))
    source_cap.set(cv2.CAP_PROP_POS_FRAMES, anchor_index)
    output_cap.set(cv2.CAP_PROP_POS_FRAMES, anchor_index)
    ok_source, source_frame = source_cap.read()
    ok_output, output_frame = output_cap.read()
    source_cap.release()
    output_cap.release()
    if not ok_source or not ok_output:
        raise RuntimeError("Could not decode selected frame for final validation")

    mask = cv2.imread(
        str(tracked_masks_dir / f"{anchor_index:06d}.png"),
        cv2.IMREAD_GRAYSCALE,
    )
    if mask is None:
        raise RuntimeError("Selected-frame tracking mask is missing")
    if mask.shape[1] != expected_width or mask.shape[0] != expected_height:
        mask = cv2.resize(mask, (expected_width, expected_height), interpolation=cv2.INTER_NEAREST)
    selector = mask > 24
    if not np.any(selector):
        raise RuntimeError("Selected-frame validation mask is empty")
    mean_change = float(
        cv2.absdiff(source_frame, output_frame).astype(np.float32).mean(axis=2)[selector].mean()
    )
    minimum_change = float(os.environ.get("ERASER_MIN_SELECTION_CHANGE", "2.5"))
    if mean_change < minimum_change:
        raise RuntimeError(
            f"Diffusion inpainting left the selection unchanged: mean_change={mean_change:.3f}"
        )
    print(
        "Final pipeline validation passed: "
        f"frames={output_frames}, size={output_width}x{output_height}, "
        f"fps={output_fps:.6f}, selected_mean_change={mean_change:.3f}",
        flush=True,
    )


def main() -> None:
    input_video = Path(required_env("ERASER_INPUT_VIDEO"))
    input_mask = Path(required_env("ERASER_INPUT_MASK"))
    output_video = Path(required_env("ERASER_OUTPUT_VIDEO"))
    quality = os.environ.get("ERASER_OUTPUT_QUALITY", "source").strip().lower()
    if quality not in {"source", "higher"}:
        quality = "source"

    if not input_video.exists() or input_video.stat().st_size <= 0:
        raise RuntimeError(f"Input video is missing or empty: {input_video}")
    if not input_mask.exists() or input_mask.stat().st_size <= 0:
        raise RuntimeError(f"Input mask is missing or empty: {input_mask}")
    output_video.parent.mkdir(parents=True, exist_ok=True)

    work_dir = output_video.parent
    source_mp4 = work_dir / "source.mp4"
    extracted_frames = work_dir / "extracted_frames"
    tracked_masks = work_dir / "optical_flow_masks"
    composite_masks = work_dir / "sam2_composite_masks"
    fixed_roi_source = work_dir / "fixed_roi_source.mkv"
    fixed_roi_masks = work_dir / "fixed_roi_masks"
    vace_source = work_dir / "vace_source.mp4"
    vace_mask = work_dir / "vace_mask.mp4"
    vace_condition = work_dir / "vace_condition.mp4"
    diffusion_output = work_dir / "diffusion_inpainted.mp4"
    source_geometry_repair = work_dir / "diffusion_source_geometry.mkv"
    silent_composite = work_dir / "source_preserving_composite.mkv"

    prepare_source(input_video, source_mp4)

    emit_stage("frame_extraction", 15, "Extracting source frames")
    (
        source_fps,
        source_width,
        source_height,
        source_frame_count,
        tracking_width,
        tracking_height,
    ) = extract_frames(source_mp4, extracted_frames)
    anchor_index = selected_anchor_frame(source_fps, source_frame_count)

    emit_stage("optical_flow_tracking", 30, "Tracking the painted mask with optical flow")
    track_masks_with_optical_flow(
        extracted_frames,
        input_mask,
        tracked_masks,
        source_frame_count,
        tracking_width,
        tracking_height,
        anchor_index,
    )
    anchor_tracking_mask = cv2.imread(
        str(tracked_masks / f"{anchor_index:06d}.png"),
        cv2.IMREAD_GRAYSCALE,
    )
    if anchor_tracking_mask is None:
        raise RuntimeError("Could not read optical-flow anchor mask for SAM2 refinement")
    build_semantic_composite_masks(
        extracted_frames,
        tracked_masks,
        composite_masks,
        source_frame_count,
        tracking_width,
        tracking_height,
        anchor_index,
        is_fixed_screen_selection(anchor_tracking_mask, tracking_width, tracking_height),
    )

    emit_stage("diffusion_inpainting", 50, "Running Wan VACE diffusion inpainting")
    source_anchor_mask = cv2.resize(
        anchor_tracking_mask,
        (source_width, source_height),
        interpolation=cv2.INTER_NEAREST,
    )
    repair_roi = (
        fixed_repair_roi(source_anchor_mask, source_width, source_height)
        if is_fixed_screen_selection(anchor_tracking_mask, tracking_width, tracking_height)
        else None
    )
    diffusion_source = source_mp4
    diffusion_masks = tracked_masks
    diffusion_width = source_width
    diffusion_height = source_height
    mask_geometry_width = tracking_width
    mask_geometry_height = tracking_height
    if repair_roi is not None:
        crop_source_for_fixed_roi(source_mp4, fixed_roi_source, repair_roi)
        crop_masks_for_fixed_roi(
            tracked_masks,
            fixed_roi_masks,
            source_frame_count,
            tracking_width,
            tracking_height,
            source_width,
            source_height,
            repair_roi,
        )
        diffusion_source = fixed_roi_source
        diffusion_masks = fixed_roi_masks
        diffusion_width = repair_roi[2]
        diffusion_height = repair_roi[3]
        mask_geometry_width = diffusion_width
        mask_geometry_height = diffusion_height
        print(
            "High-resolution fixed-mark ROI enabled: "
            f"roi={repair_roi}, source={source_width}x{source_height}, "
            f"effective_scale={min(832 / diffusion_width, 480 / diffusion_height):.3f}",
            flush=True,
        )

    target_width, target_height, size_name = vace_dimensions(diffusion_width, diffusion_height)
    scaled_width, scaled_height, pad_x, pad_y = build_vace_source(
        diffusion_source,
        vace_source,
        diffusion_width,
        diffusion_height,
        target_width,
        target_height,
    )
    build_vace_mask_video(
        diffusion_masks,
        source_fps,
        mask_geometry_width,
        mask_geometry_height,
        source_frame_count,
        vace_mask,
        target_width,
        target_height,
    )
    build_vace_condition_video(vace_source, vace_mask, vace_condition)
    run_diffusion_inpainting(vace_condition, vace_mask, diffusion_output, size_name)

    emit_stage(
        "audio_preserving_export",
        90,
        "Restoring source resolution, frame rate and original audio",
    )
    prepare_repair_at_source_geometry(
        diffusion_output,
        source_geometry_repair,
        diffusion_width,
        diffusion_height,
        source_fps,
        source_frame_count,
        scaled_width,
        scaled_height,
        pad_x,
        pad_y,
    )
    raw_composite = source_preserving_composite(
        source_mp4,
        source_geometry_repair,
        composite_masks,
        silent_composite,
        source_fps,
        source_width,
        source_height,
        repair_roi,
    )
    audio_copied_bit_exactly = mux_original_audio(
        raw_composite,
        source_mp4,
        output_video,
        quality,
    )

    emit_stage("validation", 97, "Validating the final removal and media streams")
    validate_output(
        source_mp4,
        output_video,
        composite_masks,
        anchor_index,
        source_width,
        source_height,
        source_frame_count,
        audio_copied_bit_exactly,
    )


if __name__ == "__main__":
    main()
