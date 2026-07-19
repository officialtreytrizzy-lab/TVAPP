from __future__ import annotations

import io
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PIPELINES = ROOT / "gpu-worker" / "pipelines"
sys.path.insert(0, str(PIPELINES))

import optical_flow_vace_inpaint as pipeline  # noqa: E402

WIDTH = 320
HEIGHT = 180
FRAME_COUNT = 24


def mask_center(mask: np.ndarray) -> tuple[float, float]:
    ys, xs = np.where(mask > 24)
    if len(xs) == 0:
        raise AssertionError("Mask unexpectedly became empty")
    return float(xs.mean()), float(ys.mean())


def textured_frame(index: int) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:, :, 0] = np.linspace(20, 90, WIDTH, dtype=np.uint8)[None, :]
    frame[:, :, 1] = np.linspace(30, 120, HEIGHT, dtype=np.uint8)[:, None]
    frame[:, :, 2] = 45

    x1 = 90 + index * 2
    y1 = 68 + index // 8
    x2 = x1 + 42
    y2 = y1 + 34
    cv2.rectangle(frame, (x1, y1), (x2, y2), (220, 180, 35), -1)
    for offset in range(4, 38, 8):
        cv2.line(frame, (x1 + offset, y1 + 2), (x1 + offset, y2 - 2), (35, 45, 220), 2)
    cv2.circle(frame, (x1 + 20, y1 + 17), 7, (245, 245, 245), -1)
    return frame, (x1, y1, x2, y2)


def write_frames(frames_dir: Path, frame_builder) -> None:
    frames_dir.mkdir(parents=True, exist_ok=True)
    for index in range(FRAME_COUNT):
        frame = frame_builder(index)
        if isinstance(frame, tuple):
            frame = frame[0]
        if not cv2.imwrite(str(frames_dir / f"{index:06d}.png"), frame):
            raise AssertionError(f"Could not write synthetic frame {index}")


def verify_moving_mask_tracking(root: Path) -> None:
    frames_dir = root / "moving_frames"
    masks_dir = root / "moving_masks"
    anchor_index = 8
    write_frames(frames_dir, textured_frame)

    _anchor_frame, anchor_bbox = textured_frame(anchor_index)
    anchor_mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(anchor_mask, anchor_bbox[:2], anchor_bbox[2:], 255, -1)
    mask_path = root / "moving_anchor.png"
    cv2.imwrite(str(mask_path), anchor_mask)

    pipeline.track_masks_with_optical_flow(
        frames_dir,
        mask_path,
        masks_dir,
        FRAME_COUNT,
        WIDTH,
        HEIGHT,
        anchor_index,
    )

    for index in (0, anchor_index, FRAME_COUNT - 1):
        tracked = cv2.imread(str(masks_dir / f"{index:06d}.png"), cv2.IMREAD_GRAYSCALE)
        if tracked is None:
            raise AssertionError(f"Tracked mask missing at frame {index}")
        actual_x, actual_y = mask_center(tracked)
        _frame, expected_bbox = textured_frame(index)
        expected_x = (expected_bbox[0] + expected_bbox[2]) / 2.0
        expected_y = (expected_bbox[1] + expected_bbox[3]) / 2.0
        if abs(actual_x - expected_x) > 8 or abs(actual_y - expected_y) > 8:
            raise AssertionError(
                f"Optical-flow track missed frame {index}: "
                f"actual=({actual_x:.1f},{actual_y:.1f}), expected=({expected_x:.1f},{expected_y:.1f})"
            )


def fixed_scene_frame(index: int) -> np.ndarray:
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    if index < FRAME_COUNT // 2:
        frame[:] = (30, 85, 145)
        cv2.circle(frame, (50 + index * 3, 80), 24, (200, 190, 40), -1)
    else:
        frame[:] = (130, 40, 65)
        cv2.rectangle(frame, (160, 30 + index), (230, 100 + index), (40, 210, 170), -1)
    return frame


def verify_fixed_screen_selection(root: Path) -> None:
    frames_dir = root / "fixed_frames"
    masks_dir = root / "fixed_masks"
    write_frames(frames_dir, fixed_scene_frame)

    anchor = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(anchor, (278, 142), (304, 168), 255, -1)
    if not pipeline.is_fixed_screen_selection(anchor, WIDTH, HEIGHT):
        raise AssertionError("Inset corner mark was not classified as fixed screen-space content")
    mask_path = root / "fixed_anchor.png"
    cv2.imwrite(str(mask_path), anchor)

    pipeline.track_masks_with_optical_flow(
        frames_dir,
        mask_path,
        masks_dir,
        FRAME_COUNT,
        WIDTH,
        HEIGHT,
        0,
    )

    expected = pipeline.read_painted_mask(mask_path, WIDTH, HEIGHT)
    for index in (0, FRAME_COUNT // 2, FRAME_COUNT - 1):
        tracked = cv2.imread(str(masks_dir / f"{index:06d}.png"), cv2.IMREAD_GRAYSCALE)
        if tracked is None or not np.array_equal(tracked, expected):
            raise AssertionError(f"Fixed screen-space mask drifted at frame {index}")



def verify_vace_condition_mask(root: Path) -> None:
    source_path = root / "condition_source.mp4"
    mask_path = root / "condition_mask.mp4"
    output_path = root / "condition_output.mp4"
    fps = pipeline.DIFFUSION_FPS

    source_writer = cv2.VideoWriter(
        str(source_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (WIDTH, HEIGHT),
    )
    mask_writer = cv2.VideoWriter(
        str(mask_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (WIDTH, HEIGHT),
    )
    if not source_writer.isOpened() or not mask_writer.isOpened():
        raise AssertionError("Could not create VACE conditioning test videos")

    for index in range(9):
        source = np.full((HEIGHT, WIDTH, 3), (30, 80, 190), dtype=np.uint8)
        cv2.circle(source, (80 + index * 2, 70), 18, (220, 210, 40), -1)
        mask = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
        cv2.rectangle(mask, (120, 60), (170, 110), (255, 255, 255), -1)
        source_writer.write(source)
        mask_writer.write(mask)
    source_writer.release()
    mask_writer.release()

    pipeline.build_vace_condition_video(source_path, mask_path, output_path)
    cap = cv2.VideoCapture(str(output_path))
    ok, conditioned = cap.read()
    cap.release()
    if not ok or conditioned is None:
        raise AssertionError("Could not decode VACE condition output")

    generated_region = conditioned[65:105, 125:165].astype(np.float32)
    retained_region = conditioned[10:40, 10:40].astype(np.float32)
    if abs(float(generated_region.mean()) - 127.0) > 8.0:
        raise AssertionError(
            f"White mask did not neutralize the generated region to gray: mean={generated_region.mean():.2f}"
        )
    expected_retained = np.array([30.0, 80.0, 190.0], dtype=np.float32)
    retained_mean = retained_region.mean(axis=(0, 1))
    if float(np.abs(retained_mean - expected_retained).mean()) > 12.0:
        raise AssertionError(
            f"Black mask did not retain source pixels: actual={retained_mean.tolist()}"
        )


def verify_full_pipeline_with_stubbed_diffusion(root: Path) -> None:
    job_dir = root / "full_pipeline"
    job_dir.mkdir(parents=True, exist_ok=True)
    raw_video = job_dir / "raw_video.mp4"
    input_video = job_dir / "input_video.mp4"
    painted_mask = job_dir / "painted_mask.png"
    output_video = job_dir / "output.mp4"
    fps = 24.0
    frame_count = 48

    writer = cv2.VideoWriter(
        str(raw_video),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (WIDTH, HEIGHT),
    )
    if not writer.isOpened():
        raise AssertionError("Could not create full-pipeline source video")
    for index in range(frame_count):
        frame = np.full((HEIGHT, WIDTH, 3), (35, 75, 125), dtype=np.uint8)
        cv2.rectangle(frame, (30 + index * 2, 55), (75 + index * 2, 105), (210, 190, 35), -1)
        cv2.rectangle(frame, (278, 142), (304, 168), (25, 25, 235), -1)
        writer.write(frame)
    writer.release()

    pipeline.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(raw_video),
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
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
            "128k",
            "-shortest",
            str(input_video),
        ]
    )

    mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    cv2.rectangle(mask, (278, 142), (304, 168), 255, -1)
    cv2.imwrite(str(painted_mask), mask)

    original_runner = pipeline.run_vace_chunk
    previous_env = {
        name: os.environ.get(name)
        for name in (
            "ERASER_INPUT_VIDEO",
            "ERASER_INPUT_MASK",
            "ERASER_OUTPUT_VIDEO",
            "ERASER_SELECTED_FRAME_INDEX",
            "ERASER_SELECTED_TIME",
            "ERASER_OUTPUT_QUALITY",
        )
    }

    def copy_conditioned_chunk(
        source_chunk: Path,
        _mask_chunk: Path,
        destination: Path,
        _size_name: str,
        _frame_count: int,
        _chunk_index: int,
    ) -> None:
        shutil.copy2(source_chunk, destination)

    try:
        pipeline.run_vace_chunk = copy_conditioned_chunk
        os.environ.update(
            {
                "ERASER_INPUT_VIDEO": str(input_video),
                "ERASER_INPUT_MASK": str(painted_mask),
                "ERASER_OUTPUT_VIDEO": str(output_video),
                "ERASER_SELECTED_FRAME_INDEX": "0",
                "ERASER_SELECTED_TIME": "0",
                "ERASER_OUTPUT_QUALITY": "source",
            }
        )
        captured = io.StringIO()
        with redirect_stdout(captured):
            pipeline.main()
        stage_log = captured.getvalue()
    finally:
        pipeline.run_vace_chunk = original_runner
        for name, value in previous_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    expected_stages = [
        "frame_extraction",
        "optical_flow_tracking",
        "diffusion_inpainting",
        "audio_preserving_export",
        "validation",
    ]
    positions = [stage_log.find(f'"name":"{stage}"') for stage in expected_stages]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        raise AssertionError(f"Pipeline stages were missing or out of order: {positions}\n{stage_log}")

    output_fps, output_width, output_height, output_frames = pipeline.read_video_meta(output_video)
    if (output_width, output_height) != (WIDTH, HEIGHT):
        raise AssertionError(f"Full pipeline changed dimensions: {output_width}x{output_height}")
    if abs(output_frames - frame_count) > 2:
        raise AssertionError(f"Full pipeline changed frame count: {output_frames}")
    if abs(output_fps - fps) > 0.1:
        raise AssertionError(f"Full pipeline changed FPS: {output_fps}")
    if not pipeline.has_audio(output_video):
        raise AssertionError("Full pipeline did not preserve source audio")

def verify_vace_frame_contract() -> None:
    for raw_frames in (1, 5, 6, 17, 64, 65, 73, 80, 81, 120):
        allowed = pipeline.allowed_vace_frame_count(raw_frames)
        if allowed > pipeline.MAX_VACE_FRAMES:
            raise AssertionError(f"VACE chunk exceeded 81 frames: raw={raw_frames}, allowed={allowed}")
        if (allowed - 1) % 4 != 0:
            raise AssertionError(f"VACE frame count is not 4n+1: raw={raw_frames}, allowed={allowed}")
        if raw_frames <= pipeline.MAX_VACE_FRAMES and allowed < raw_frames:
            raise AssertionError(f"VACE frame normalization shortened a chunk: raw={raw_frames}, allowed={allowed}")

    portrait = pipeline.vace_dimensions(720, 1280)
    landscape = pipeline.vace_dimensions(1280, 720)
    if portrait != (480, 832, "480*832"):
        raise AssertionError(f"Unexpected portrait VACE geometry: {portrait}")
    if landscape != (832, 480, "832*480"):
        raise AssertionError(f"Unexpected landscape VACE geometry: {landscape}")


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="optical-flow-vace-test-"))
    try:
        verify_moving_mask_tracking(root)
        verify_fixed_screen_selection(root)
        verify_vace_condition_mask(root)
        verify_full_pipeline_with_stubbed_diffusion(root)
        verify_vace_frame_contract()
        print(
            "Optical-flow VACE regression passed: moving masks track, fixed inset masks do not drift, "
            "and diffusion chunks obey the 4n+1/81-frame contract."
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
