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
- `pipeline`: `sam2-propainter`
- `quality`: `commercial`

The worker can either return a completed video immediately or return a job id/status URL.

Expected JSON examples:

```json
{
  "jobId": "remote-job-id",
  "statusUrl": "/v1/video-eraser/jobs/remote-job-id",
  "phase": "segmenting",
  "progress": 10,
  "statusMessage": "Segmenting selected object"
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

For commercial-grade results, the worker should run this pipeline:

1. Extract frames and audio with FFmpeg.
2. Use a promptable video segmentation model, such as SAM2-style click/mask prompting, to create a clean per-frame mask.
3. Track masks through the video with confidence checks and correction-keyframe support.
4. Reject masks that suddenly jump, grow, or drift away from the selected target.
5. Use temporal video inpainting, such as ProPainter/E2FGVI-style propagation and hallucination, instead of canvas blur/diffusion.
6. Post-process with edge feathering, color matching, grain/noise matching, and flicker checks.
7. Encode the final MP4 with the original audio preserved.
8. Return a signed or public `outputUrl` to the frontend.

## What is local now

- Job creation and phase changes live in `src/lib/eraser/api.ts`.
- Job metadata is saved in browser `localStorage`.
- Finished browser-fallback output videos are saved in browser `IndexedDB`.
- GPU worker output is returned by URL from the worker.
- The app does not require Supabase Edge Functions for local development.

## Limits

Browser fallback is not commercial-grade. It cannot reliably remove complex moving objects or synthesize realistic background for wide motion. Use a GPU worker for serious object removal.
