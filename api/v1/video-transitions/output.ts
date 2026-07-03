import { requireApiKey } from '../../_lib/auth.js';
import { error, handleOptions, methodNotAllowed } from '../../_lib/http.js';
import { getRememberedJob, modalMixTransitionOutputUrl } from '../../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    requireApiKey(req, 'video_editor:read');
    const jobId = String(req.query.job_id || req.query.jobId || '');
    if (!jobId) return error(res, 400, 'job_id is required.', 'job_id_required');
    const record = getRememberedJob(jobId);
    const externalJobId = record?.external_job_id || jobId;
    const upstream = await fetch(modalMixTransitionOutputUrl(externalJobId));

    if (!upstream.ok || !upstream.body) {
      return error(res, upstream.status || 502, `Mix output not ready from worker: HTTP ${upstream.status}`, 'output_not_ready');
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${jobId}-mix.mp4"`);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(200).send(buffer);
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read Mix transition output.', err.code || 'mix_transition_output_failed');
  }
}
