import { requireApiKey } from '../../../_lib/auth';
import { error, handleOptions, json, methodNotAllowed, publicBaseUrl } from '../../../_lib/http';
import { getRememberedJob, readModalStatus, updateRememberedJob } from '../../../_lib/modal';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    requireApiKey(req, 'video_removal:read');
    const jobId = String(req.query.jobId || '');
    const record = getRememberedJob(jobId);
    if (!record) return error(res, 404, 'Job not found. Durable job storage is required before multi-instance production use.', 'job_not_found');

    let updated = record;
    if (record.modal_status_url && record.status !== 'completed') {
      const modal = await readModalStatus(record.modal_status_url);
      const phase = modal.phase || modal.status || record.status;
      const outputRaw = modal.outputUrl || modal.output_url || modal.finalOutputUrl || modal.final_output_url;
      updated = updateRememberedJob(jobId, {
        status: phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed' : 'processing',
        output_url: outputRaw ? `${publicBaseUrl(req)}/api/v1/video-removal/jobs/${jobId}/output` : record.output_url,
      }) || record;
    }

    json(res, 200, {
      job_id: updated.job_id,
      status: updated.status,
      service: updated.service,
      mode: updated.mode,
      quality: updated.quality,
      created_at: updated.created_at,
      status_url: updated.status_url,
      output_url: updated.output_url,
      metadata: updated.metadata,
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read video-removal job.', err.code || 'video_removal_status_failed');
  }
}
