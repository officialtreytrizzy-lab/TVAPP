# Video ETreyser SAM2 Lockdown

Status: working and locked.
Date: 2026-07-06

## Working path

Video ETreyser now uses real SAM2 video mask propagation before ProPainter.

The current locked worker flow is:

1. User uploads a clip and paints the target mask on the selected frame.
2. The Modal GPU worker loads the source video and selected-frame mask.
3. SAM2 is initialized from `/opt/sam2_checkpoints/sam2.1_hiera_tiny.pt` with config `configs/sam2.1/sam2.1_hiera_t.yaml`.
4. SAM2 propagates the selected mask forward and backward across the clip.
5. The worker writes one binary mask PNG per frame into the SAM2 mask sequence folder.
6. ProPainter receives the SAM2 mask sequence for temporal video inpainting.
7. The worker checks masked-region pixel change so a no-op output is not accepted silently.
8. If ProPainter OOMs or returns an unchanged result, the OpenCV fallback uses the SAM2 mask sequence.
9. Audio is muxed back into the final MP4.

## Do not regress

Do not replace SAM2 propagation with OpenCV template matching as the primary tracker.
The old bad signals are:

- `cv2.matchTemplate(...)`
- `read_video_gray_frames(...)` as the main tracking path
- static-only masks as the default path

The expected good signals are:

- `SAM2_MODEL_CFG`
- `SAM2_CHECKPOINT`
- `from sam2.build_sam import build_sam2_video_predictor`
- `SAM2 initialized`
- `SAM2 propagated masks for`
- `Using SAM2 mask sequence for ProPainter`

## Modal deployment

Redeploy Modal after worker changes:

```bash
MODAL_PROFILE=tvapp-new modal deploy gpu-worker/modal_app.py
```

The Modal image must install:

- ProPainter at `/opt/ProPainter`
- SAM2 at `/opt/sam2`
- SAM2 checkpoint at `/opt/sam2_checkpoints/sam2.1_hiera_tiny.pt`

## Verified outcome

The user confirmed the video eraser works after the SAM2 deployment.
This state should be treated as the baseline working implementation for future Video ETreyser changes.
