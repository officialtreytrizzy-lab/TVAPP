import { requireApiKey } from '../_lib/auth.js';
import { error, handleOptions, json, methodNotAllowed } from '../_lib/http.js';
import { modalBaseUrl } from '../_lib/modal.js';

/**
 * Key-gated discovery of the GPU worker's direct upload endpoints.
 *
 * Vercel serverless functions cap request AND response bodies at ~4.5MB, so
 * real videos cannot flow through the relay endpoints. Licensed clients call
 * this endpoint with their API key, then POST multipart form-data straight to
 * the worker (which allows CORS) and poll/download from it directly.
 */
export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    requireApiKey(req, 'video_removal:write');
    const base = modalBaseUrl();
    if (!base) return error(res, 503, 'GPU worker is not configured.', 'worker_not_configured');
    json(res, 200, {
      worker_base: base,
      workerBase: base,
      health_url: `${base}/health`,
      healthUrl: `${base}/health`,
      ai_remix_upload_url: `${base}/v1/ai-remix/jobs`,
      aiRemixUploadUrl: `${base}/v1/ai-remix/jobs`,
      video_removal_upload_url: `${base}/v1/video-eraser/jobs`,
      chunked_upload_url: `${base}/v1/video-eraser/uploads`,
      chunkedUploadUrl: `${base}/v1/video-eraser/uploads`,
      video_transitions_mix_upload_url: `${base}/v1/video-transitions/mix/jobs`,
      note: 'Use chunked_upload_url for retryable mobile uploads. Legacy multipart endpoints remain available for compatible clients.',
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not resolve upload target.', err.code || 'upload_target_failed');
  }
}
