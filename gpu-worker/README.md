# GPU Video Eraser Worker

This folder defines the production worker contract for commercial-grade video object removal.

The Vite frontend calls this worker when `VITE_ERASER_GPU_WORKER_URL` is configured. The browser-only pipeline remains as a fallback, but serious removal should run here on a GPU machine.

## API

- `POST /v1/video-eraser/jobs`
- `GET /v1/video-eraser/jobs/{job_id}`
- `POST /v1/video-eraser/jobs/{job_id}/cancel`

## Deploy on Modal

Do not hard-code Modal tokens into this repo.

From your computer:

```bash
python -m pip install --upgrade modal
modal token new --profile tvapp-new --activate
modal profile current
modal token info
MODAL_PROFILE=tvapp-new modal deploy gpu-worker/modal_app.py
```

Modal prints a deployed web URL. Put that URL in Vercel:

```bash
VITE_ERASER_GPU_WORKER_URL=https://your-workspace--tvapp-video-eraser-gpu-fastapi-app.modal.run
ERASER_GPU_WORKER_URL=https://your-workspace--tvapp-video-eraser-gpu-fastapi-app.modal.run
```

Then populate the fresh Modal volume in the new account:

```bash
MODAL_PROFILE=tvapp-new modal run gpu-worker/modal_app.py::download_models
```

For the full account-switch checklist, see `docs/modal-account-migration.md`.

Optional auth can be added later with:

```bash
VITE_ERASER_GPU_API_KEY=your-worker-bearer-token
```

## Expected production pipeline

1. Save the uploaded video and PNG alpha mask.
2. Extract video frames and original audio with FFmpeg.
3. Convert the user mask into a prompt for a video segmentation model.
4. Track the selected target through the clip with confidence checks.
5. Run temporal video inpainting on the masked frames.
6. Color-match, edge-match, and grain-match the fill so it does not look like a blur patch.
7. Encode the final MP4 with original audio.
8. Return `outputUrl` to the frontend.

## Model target

Use a SAM2-style promptable video segmenter for masks and a ProPainter/E2FGVI-style temporal inpainting model for frame repair.

The worker should fail fast if the model command is not configured. Do not silently fall back to browser-style blur on the worker.

## Environment

```bash
ERASER_WORK_DIR=/tmp/video-eraser-jobs
ERASER_PUBLIC_BASE_URL=https://your-worker.example.com
ERASER_PIPELINE_CMD="python /app/pipelines/sam2_propainter.py"
```

The pipeline command receives these environment variables:

- `ERASER_JOB_ID`
- `ERASER_INPUT_VIDEO`
- `ERASER_INPUT_MASK`
- `ERASER_OUTPUT_VIDEO`
- `ERASER_SELECTED_TIME`
- `ERASER_SELECTED_FRAME_INDEX`
- `ERASER_FPS`
- `ERASER_WIDTH`
- `ERASER_HEIGHT`
- `ERASER_DURATION`

The command must write the final MP4 to `ERASER_OUTPUT_VIDEO`.
