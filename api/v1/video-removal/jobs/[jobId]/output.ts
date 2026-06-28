import { requireApiKey } from '../../../../_lib/auth';
import { error, handleOptions, methodNotAllowed } from '../../../../_lib/http';
import { getRememberedJob, modalBaseUrl } from '../../../../_lib/modal';

function absoluteModalUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = modalBaseUrl();
  return `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    requireApiKey(req, 'video_removal:read');
    const jobId = String(req.query.jobId || '');
    const record = getRememberedJob(jobId);
    if (!record) return error(res, 404, 'Job not found. Durable job storage is required before multi-instance production use.', 'job_not_found');

    const externalJobId = record.external_job_id || jobId;
    const modalOutput = absoluteModalUrl(`/v1/video-eraser/jobs/${externalJobId}/output`);
    const upstream = await fetch(modalOutput);
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
