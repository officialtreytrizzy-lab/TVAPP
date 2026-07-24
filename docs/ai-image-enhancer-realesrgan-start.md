# AI Image Enhancer Real-ESRGAN Start

Status: backend worker started.

## What was added

The TVAPP GPU worker now has a separate AI Image Enhancer backend path using Real-ESRGAN as the primary enhancer.

Added files:

- `gpu-worker/pipelines/realesrgan_enhance.py`
- `gpu-worker/image_enhancer_app.py`

Updated file:

- `gpu-worker/modal_app.py`

## Worker modes

The image enhancer API supports:

- `mode=photo` using `RealESRGAN_x4plus`
- `mode=anime` using `RealESRGAN_x4plus_anime_6B`
- `scale=2` or `scale=4`
- `face_enhance=true` using GFPGAN v1.4 with Real-ESRGAN background upsampling
- output formats: `png`, `jpg`, `jpeg`, `webp`

## Endpoints

The new Modal ASGI app exposes:

- `GET /health`
- `POST /v1/image-enhancer/jobs`
- `GET /v1/image-enhancer/jobs/{jobId}`
- `GET /v1/image-enhancer/jobs/{jobId}/output`
- `GET /v1/image-enhancer/jobs/{jobId}/log`

## Deploy

Redeploy the Modal worker:

```bash
MODAL_PROFILE=officialtreytrizzy-lab modal deploy gpu-worker/modal_app.py
```

Modal should show an additional web endpoint for `image_enhancer_app`.

## Test request

Use multipart form data:

- `image`: uploaded image file
- `mode`: `photo` or `anime`
- `scale`: `2` or `4`
- `face_enhance`: `true` or `false`
- `output_format`: `png`, `jpg`, or `webp`

Example curl shape:

```bash
curl -X POST "$IMAGE_ENHANCER_WORKER_URL/v1/image-enhancer/jobs" \
  -F "image=@sample.jpg" \
  -F "mode=photo" \
  -F "scale=4" \
  -F "face_enhance=false" \
  -F "output_format=png"
```

Then poll the returned `statusUrl` and download from `outputUrl` once completed.

## Next step

Wire this backend into the TVAPP frontend as an AI Image Enhancer tool card with:

- upload image
- Auto Enhance / Photo / Anime mode
- 2x / 4x scale
- Face Enhance toggle
- before/after preview
- download enhanced result

