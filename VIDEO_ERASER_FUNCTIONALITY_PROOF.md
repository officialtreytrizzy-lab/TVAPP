# Video Eraser Functionality Proof

This build is a one-folder Vite/React app. It does not require a separate backend to run locally.

## Verified architecture

- Frontend UI: `src/components/eraser/*`
- Local job/state layer: `src/lib/eraser/api.ts`
- Frame extraction: `src/lib/eraser/frames.ts`
- Mask tracking: `src/lib/eraser/track.ts`
- Inpainting/blending: `src/lib/eraser/inpaint.ts`
- Video rebuild/export: `src/lib/eraser/exporter.ts`
- Pipeline orchestration: `src/lib/eraser/pipeline.ts`

## Runtime flow

Upload → video probe → local job creation → draw mask → local `setMask` → extract frames → track mask → smooth masks → inpaint frames → rebuild video → preserve audio when browser support allows → save output Blob to IndexedDB → download final video.

## State handling

The job state machine now runs locally in `src/lib/eraser/api.ts`. It resolves jobs by either `job_id` or `id`, stores metadata in `localStorage`, and stores finished videos in `IndexedDB`.

## Acceptance checks

- `npm install` succeeds.
- `npm run build` succeeds.
- No runtime code calls Supabase Edge Functions.
- No runtime code queries `video_eraser_jobs`.
- Processing is blocked from duplicate taps with a ref lock.
- Completed output is downloadable.
- Completed output can be reopened from local history as long as browser site data remains.

## Browser limitations

This app depends on browser video APIs such as canvas, MediaRecorder, and IndexedDB. Some mobile browsers may export WebM instead of MP4, or may export silent video if audio capture is blocked. The UI reports whether audio was preserved.
