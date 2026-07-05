import { error, handleOptions, methodNotAllowed } from '../../../../../_lib/http.js';
import { absoluteModalUrl, getRememberedJob, modalCompositeOutputFromPayload, modalJobStatusUrl, readModalStatus } from '../../../../../_lib/modal.js';

function normalizeJobStatus(value: unknown): string {
  const status = String(value || '').toLowerCase();
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return status || 'processing';
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const jobId = String(req.query.jobId || '');
    const record = getRememberedJob(jobId);
    const externalJobId = record?.external_job_id || jobId;
    const statusUrl = record?.modal_status_url || modalJobStatusUrl(externalJobId);

    let modal: any;
    try {
      modal = await readModalStatus(statusUrl);
    } catch {
      return error(res, 404, 'Could not read first-party eTreyser worker status for this removal job.', 'etreyser_worker_status_not_found');
    }

    const status = normalizeJobStatus(modal.phase || modal.status);
    const preferred = modalCompositeOutputFromPayload(modal);
    if (!preferred) {
      const message = status === 'completed'
        ? 'eTreyser finished but only exposed a raw blob/patch output, not a full erased video.'
        : 'eTreyser composite output is not ready yet.';
      return error(res, status === 'completed' ? 502 : 202, message, status === 'completed' ? 'raw_blob_only' : 'composite_not_ready');
    }

    const upstream = await fetch(absoluteModalUrl(preferred));

    if (!upstream.ok || !upstream.body) {
      return error(res, upstream.status || 502, `Composite output not ready from worker: HTTP ${upstream.status}`, 'composite_output_not_ready');
    }

    const contentType = upstream.headers.get('content-type') || 'video/mp4';
    if (!contentType.toLowerCase().startsWith('video/') && contentType.toLowerCase() !== 'application/octet-stream') {
      return error(res, 502, `eTreyser composite output was not video content (${contentType}).`, 'invalid_composite_content_type');
    }

    res.setHeader('Content-Type', contentType === 'application/octet-stream' ? 'video/mp4' : contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${jobId}.mp4"`);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(200).send(buffer);
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read first-party eTreyser output.', err.code || 'etreyser_first_party_output_failed');
  }
}
