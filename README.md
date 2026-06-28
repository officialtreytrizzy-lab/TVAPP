# EraserAI One-Folder Local App

This build runs from one project folder. There is no separate backend server, no Supabase Edge Function, and no storage bucket required for local development.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL, upload a video, draw a mask, and click **Process Video**.

## What is local now

- Job creation and phase changes live in `src/lib/eraser/api.ts`.
- Job metadata is saved in browser `localStorage`.
- Finished output videos are saved in browser `IndexedDB`.
- Download uses the generated cleaned video file from the browser.
- No call is made to `supabase.functions.invoke("video-eraser")`.

## Limits

Because this is browser-local, completed outputs are saved only in the browser/profile that created them. Clearing site data clears the local history.
