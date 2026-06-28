# Eraser GPU Worker Locked Contract

This file exists so future edits do not accidentally break the working Vercel to Modal to GPU worker path.

## Locked production path

The live object-removal path is:

```text
Vercel React app
→ src/lib/eraser/gpu.ts
→ VITE_ERASER_GPU_WORKER_URL
→ Modal FastAPI worker
→ gpu-worker/main.py
→ gpu-worker/pipelines/sam2_propainter.py
→ ProPainter static-mask removal
→ /v1/video-eraser/jobs/{job_id}/output
→ frontend playback/download
```

## Do not remove these invariants

- `src/lib/eraser/gpu.ts` must upload both the original video and PNG mask.
- `src/lib/eraser/gpu.ts` must convert relative Modal output URLs into absolute URLs.
- `src/components/eraser/Editor.tsx` must use `runGpuRemoval()` when `VITE_ERASER_GPU_WORKER_URL` exists.
- `src/components/eraser/ProcessingPanel.tsx` must show whether the app is in `GPU AI worker` or `browser fallback` mode.
- `gpu-worker/modal_app.py` must install ProPainter into `/opt/ProPainter`.
- `gpu-worker/modal_app.py` must use a real GPU.
- `gpu-worker/modal_app.py` must keep `max_containers=1` until job state is moved out of memory into durable storage.
- `gpu-worker/modal_app.py` must keep `@modal.concurrent(max_inputs=1)` because ProPainter is memory-heavy.
- `gpu-worker/main.py` must default to `python /app/pipelines/sam2_propainter.py`.
- `gpu-worker/pipelines/sam2_propainter.py` must call ProPainter's `inference_propainter.py`.
- `gpu-worker/pipelines/sam2_propainter.py` must preserve original audio when possible.

## Why `max_containers=1` is locked

The earlier worker stored job state in process memory. Modal can route status polling to another container with an empty memory dictionary. That caused false `Job not found` errors even when the job was created.

Until state is stored in Redis, Supabase, S3, SQLite on a shared volume, or Modal Dict/Volume, the worker must stay pinned to one container.

## Browser fallback rule

The browser fallback should remain available for local demos, but it is not the production/commercial path. Do not tune the browser fallback and call it commercial-grade. The commercial path is the Modal worker.

## Model license note

ProPainter is wired for pipeline proof and research/development. Before launching this as a public or paid commercial remover, verify the model license and replace it with a commercially usable model if needed.

## Contract check

Run this before committing eraser changes:

```bash
npm run check:eraser-contract
```

GitHub Actions also runs the same check on pushes and pull requests to `main`.
