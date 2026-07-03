import { requireApiKey } from '../../../../_lib/auth.js';
import { error, handleOptions, methodNotAllowed } from '../../../../_lib/http.js';
import { getRememberedJob, modalCompositeOutputFromPayload, modalJobOutputUrl, readModalStatus } from '../../../../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    requireApiKey(req, 'video_removal:read');
    const jobId = String(req.query.jobId || '');
    const record = getRememberedJob(jobId);
    const externalJobId = record?.external_job_id || jobId;

    let outputUrl = modalJobOutputUrl(externalJobId);
    const statusUrl = record?.modal_status_url;
    if (statusUrl) {
      try {
        const modal = await readModalStatus(statusUrl);
        const preferred = modalCompositeOutputFromPayload(modal);
        if (preferred) outputUrl = /^https?:\/\//i.test(preferred) ? preferred : modalJobOutputUrl(externalJobId).replace(`/v1/video-eraser/jobs/${encodeURIComponent(externalJobId)}/output`, preferred.startsWith('/') ? preferred : `/${preferred}`);
      } catch {
        // Fall back to the conventional worker output endpoint.
      }
    }

    const upstream = await fetch(outputUrl);

    if (!upstream.ok || !upstream.body) {
      return error(res, upstream.status || 502, `Output not ready from worker: HTTP ${upstream.status}`, 'output_not_ready');
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${jobId}.mp4"`);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(200).send(buffer);
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read video-removal output.', err.code || 'video_removal_output_failed');
  }
}
