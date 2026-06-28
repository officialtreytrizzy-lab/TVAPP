# Trey Video API

This document defines the licensed third-party API layer for Video ETreyser and OpenCut Mobile Studio.

## Product line

```text
Video ETreyser API
- Object/logo removal jobs
- Source-quality and higher-quality export
- Modal GPU worker backend

OpenCut Mobile API
- Mobile project render jobs
- Embeddable editor/SDK path
- Render endpoint staged for server-side timeline rendering
```

## Required environment variables

```bash
VITE_ERASER_GPU_WORKER_URL=https://your-modal-worker.modal.run
TREY_VIDEO_API_PUBLIC_BASE_URL=https://your-domain.com
TREY_VIDEO_API_ALLOWED_ORIGIN=*
TREY_VIDEO_API_KEYS=key_id:sha256_hash:organization_id:plan:scopes
```

Generate an API key hash:

```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" tve_live_your_secret_key
```

Example `TREY_VIDEO_API_KEYS` value:

```text
starter_key_1:YOUR_SHA256_HASH:org_demo:starter:video_removal:write|video_removal:read|video_editor:write|video_editor:read
```

## Auth

Every protected request uses:

```http
Authorization: Bearer tve_live_xxx
Idempotency-Key: optional-customer-idempotency-key
```

## Health

```http
GET /api/v1/health
```

## License status

```http
GET /api/v1/licenses
Authorization: Bearer tve_live_xxx
```

## Usage status

```http
GET /api/v1/usage
Authorization: Bearer tve_live_xxx
```

## Create video-removal job

```http
POST /api/v1/video-removal/jobs
Authorization: Bearer tve_live_xxx
Content-Type: application/json
```

Body:

```json
{
  "source_video_url": "https://customer-cdn.com/input.mp4",
  "mask_url": "https://customer-cdn.com/mask.png",
  "mode": "static_logo",
  "quality": "higher",
  "preserve_resolution": true,
  "preserve_fps": true,
  "preserve_audio": true,
  "webhook_url": "https://customer.com/webhooks/trey-video",
  "metadata": {
    "customer_job_id": "abc_123"
  }
}
```

Small proof/testing jobs may use base64 instead:

```json
{
  "source_video_base64": "data:video/mp4;base64,...",
  "mask_base64": "data:image/png;base64,...",
  "mode": "static_logo",
  "quality": "source"
}
```

Response:

```json
{
  "job_id": "vrem_xxx",
  "status": "processing",
  "service": "video_removal",
  "mode": "static_logo",
  "quality": "higher",
  "status_url": "https://your-domain.com/api/v1/video-removal/jobs/vrem_xxx",
  "output_url": "https://your-domain.com/api/v1/video-removal/jobs/vrem_xxx/output",
  "billing": {
    "unit": "processed_second",
    "metered": true
  }
}
```

## Read job status

```http
GET /api/v1/video-removal/jobs/{job_id}
Authorization: Bearer tve_live_xxx
```

## Read job output

```http
GET /api/v1/video-removal/jobs/{job_id}/output
Authorization: Bearer tve_live_xxx
```

## Create OpenCut render job

```http
POST /api/v1/video-editor/render-jobs
Authorization: Bearer tve_live_xxx
Content-Type: application/json
```

Body:

```json
{
  "project": {
    "aspect": "9:16",
    "clips": [],
    "textLayers": []
  },
  "webhook_url": "https://customer.com/webhooks/trey-video"
}
```

The endpoint is wired as a licensed preview endpoint. Full server-side timeline rendering should be backed by the Modal worker in the next pass.

## Production hardening still required before selling

The current API layer is functional scaffolding and a licensing surface. Before charging public customers, add:

- Supabase/Postgres durable job storage.
- Signed upload URLs for large videos.
- Durable output storage/CDN.
- Stripe or usage billing.
- Webhook signing and retry table.
- Rate limiting by API key.
- Commercially cleared removal model.
- Admin dashboard for orgs, keys, plans, and invoices.

## Model license warning

ProPainter is wired for proof-of-pipeline. Verify and clear model licensing before commercial video-removal resale.
