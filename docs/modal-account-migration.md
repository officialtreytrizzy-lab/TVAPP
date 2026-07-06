# Modal account migration for TVAPP GPU worker

This repo uses Modal for the GPU video eraser worker. The deployed Modal app is defined in `gpu-worker/modal_app.py` as:

```py
app = modal.App("tvapp-video-eraser-gpu")
```

The app mounts one persistent Modal volume:

```py
tvapp-wan-models -> /models
```

The Vite/Vercel API points to the deployed Modal web URL through these environment variables:

```env
VITE_ERASER_GPU_WORKER_URL=https://your-workspace--tvapp-video-eraser-gpu-fastapi-app.modal.run
ERASER_GPU_WORKER_URL=https://your-workspace--tvapp-video-eraser-gpu-fastapi-app.modal.run
```

Do not commit Modal tokens, API keys, or private worker URLs to this public repo.

## One-time migration steps

Run these commands from the repo root on the computer that should deploy to the new Modal account.

### 1. Authenticate to the new Modal account

```bash
python -m pip install --upgrade modal
modal token new --profile tvapp-new --activate
modal profile current
modal token info
```

Stop if `modal profile current` does not show `tvapp-new`.

### 2. Deploy the worker into the new Modal account

```bash
MODAL_PROFILE=tvapp-new modal deploy gpu-worker/modal_app.py
```

Modal will print the new web URL. It should look like this:

```text
https://NEW-WORKSPACE--tvapp-video-eraser-gpu-fastapi-app.modal.run
```

Copy that exact URL.

### 3. Populate the model volume in the new Modal account

The new Modal account starts with a fresh `tvapp-wan-models` volume. Run:

```bash
MODAL_PROFILE=tvapp-new modal run gpu-worker/modal_app.py::download_models
```

This downloads `Wan-AI/Wan2.1-VACE-1.3B` into `/models/Wan2.1-VACE-1.3B` inside the Modal volume.

### 4. Update Vercel environment variables

In the Vercel `tvapp` project, set both of these to the new Modal URL:

```env
VITE_ERASER_GPU_WORKER_URL=https://NEW-WORKSPACE--tvapp-video-eraser-gpu-fastapi-app.modal.run
ERASER_GPU_WORKER_URL=https://NEW-WORKSPACE--tvapp-video-eraser-gpu-fastapi-app.modal.run
```

Apply the change to Production, Preview, and Development if the Vercel UI asks which environments should receive it.

### 5. Redeploy Vercel

Redeploy `tvapp` after the env vars are updated. The health endpoint should return `modal_worker_configured: true`:

```bash
curl https://tvapp-v-ideo-e-dit.vercel.app/api/v1/health
```

If the production domain changes, test the active production URL instead.

### 6. Smoke test the worker URL directly

After Modal deployment, test the worker base URL:

```bash
curl https://NEW-WORKSPACE--tvapp-video-eraser-gpu-fastapi-app.modal.run/v1/video-eraser/jobs/test
```

A `404` for a fake job ID is acceptable. A DNS, auth, or connection error means Vercel should not be pointed to that URL yet.

## Important notes

- The old Modal account's volume contents do not automatically move to the new account.
- The new account must rebuild the Modal image and download model weights again.
- Keep the old Modal app live until the new worker URL is confirmed from Vercel health and one real job test.
- Do not set Modal token values in `VITE_` variables. Anything beginning with `VITE_` may become browser-visible.
- The browser/API only needs the deployed worker URL, not the Modal token.
