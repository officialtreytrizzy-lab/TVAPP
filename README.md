# EraserAI One-Folder App

This project still runs from one folder, but it now supports two processing modes:

1. **GPU AI worker mode** for commercial-grade object removal.
2. **Browser fallback mode** for local/dev testing when no GPU worker URL is configured.

The browser fallback is useful for demos, but it will not match commercial removers. Commercial-grade removal needs promptable video segmentation, temporal mask tracking, real video inpainting, audio-preserving export, and GPU processing.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL, upload a video, draw a mask, and click **Process Video**.

## Recommended production setup

Set these environment variables in Vercel or your local `.env.local`:

```bash
VITE_ERASER_GPU_WORKER_URL=https://your-gpu-worker.example.com
VITE_ERASER_GPU_API_KEY=optional-secret-if-your-worker-requires-it
```

When `VITE_ERASER_GPU_WORKER_URL` is present, the app sends the original video and the user mask to the GPU worker. When it is missing, the app automatically uses the browser fallback.

## GPU worker contract

The frontend expects the worker to expose:

```http
POST /v1/video-eraser/jobs
GET /v1/video-eraser/jobs/:jobId
POST /v1/video-eraser/jobs/:jobId/cancel
```

The job creation request is multipart form data with:

- `video`: original video file
- `mask`: PNG mask where alpha > 0 means remove
- `job_id`: local job id
- `selected_time`: selected timestamp in seconds
- `selected_frame_index`: selected frame index
- `fps`, `duration`, `width`, `height`
- `pipeline`: `optical-flow-vace-diffusion`
- `quality`: `commercial`

The worker can either return a completed video immediately or return a job id/status URL.

Expected JSON examples:

```json
{
  "jobId": "remote-job-id",
  "statusUrl": "/v1/video-eraser/jobs/remote-job-id",
  "phase": "frame_extraction",
  "progress": 15,
  "statusMessage": "Extracting source frames"
}
```

```json
{
  "jobId": "remote-job-id",
  "phase": "completed",
  "progress": 100,
  "outputUrl": "https://signed-url/final.mp4"
}
```

## What the GPU worker should do

The production worker runs this exact pipeline:

1. **Frame extraction:** decode the original clip into source-timed frames while retaining the original media metadata.
2. **Optical-flow tracking:** propagate the painted removal mask forward and backward with dense Farneback flow, sparse Lucas-Kanade recovery, scene-cut detection, and fixed screen-space handling.
3. **Diffusion inpainting:** convert the tracked mask sequence into a Wan VACE temporal mask where white means generate and black means preserve, then reconstruct the missing background in overlapping diffusion chunks.
4. **Audio-preserving export:** composite only the repaired mask region over the original source frames, restore the original resolution and FPS, and mux the original soundtrack into the final MP4.

The production route does not execute SAM2 or ProPainter.

## What is local now

- Job creation and phase changes live in `src/lib/eraser/api.ts`.
- Job metadata is saved in browser `localStorage`.
- Finished browser-fallback output videos are saved in browser `IndexedDB`.
- GPU worker output is returned by URL from the worker.
- The app does not require Supabase Edge Functions for local development.

## Limits

Browser fallback is not commercial-grade. It cannot reliably remove complex moving objects or synthesize realistic background for wide motion. Use a GPU worker for serious object removal.
