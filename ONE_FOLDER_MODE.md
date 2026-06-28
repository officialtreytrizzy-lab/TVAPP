# One-Folder Mode

This version is intentionally wired as one local app folder. The previous frontend/Edge Function split has been removed from the runtime path.

## Removed from runtime

- Supabase Edge Function calls
- `video_eraser_jobs` table dependency
- remote storage bucket dependency
- remote `set_mask`, `transition`, `progress`, and `complete` actions

## Current runtime path

1. `npm run dev` starts the Vite app.
2. Upload probes the video in the browser.
3. `src/lib/eraser/api.ts` creates a local job.
4. The mask and processing pipeline run in the browser.
5. Job state is saved to `localStorage`.
6. The completed output Blob is saved to `IndexedDB`.
7. The Download button downloads the cleaned video.

## Why the old errors should be gone

Those errors came from remote job lookup and Supabase `.single()` queries. This build no longer calls that backend path, so these errors are removed from the local flow:

- `Job not found` from the Edge Function
- `The result contains 12 rows`
- `The result contains 13 rows`
- `Mask can only be set in awaiting_mask/mask_ready, not segmenting` caused by backend duplicate set_mask races

Local duplicate taps are blocked with a synchronous processing lock in `Editor.tsx`.
