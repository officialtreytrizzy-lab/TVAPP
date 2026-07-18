import { error, handleOptions, json, methodNotAllowed } from '../../../../_lib/http.js';
import { modalBaseUrl } from '../../../../_lib/modal.js';

const DEFAULT_WORKER_BASE = 'https://wthemif--tvapp-video-eraser-gpu-fastapi-app.modal.run';

/**
 * First-party discovery of the GPU worker's direct upload endpoint.
 *
 * Vercel serverless functions cap request AND response bodies at ~4.5MB, so
 * real videos cannot flow through the base64 JSON relay in ./jobs.ts. The app
 * calls this endpoint, then POSTs multipart form-data straight to the worker
 * (which allows CORS) and polls/downloads from it directly. Only small JSON
 * control traffic goes through Vercel.
 */
export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const base = (modalBaseUrl() || DEFAULT_WORKER_BASE).replace(/\/$/, '');
    if (!base) return error(res, 503, 'GPU worker is not configured.', 'worker_not_configured');

    json(res, 200, {
      worker_base: base,
      workerBase: base,
      upload_url: `${base}/v1/video-eraser/jobs`,
      uploadUrl: `${base}/v1/video-eraser/jobs`,
      status_path_prefix: '/v1/video-eraser/jobs',
      health_url: `${base}/health`,
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not resolve eTreyser upload target.', err.code || 'etreyser_upload_target_failed');
  }
}
