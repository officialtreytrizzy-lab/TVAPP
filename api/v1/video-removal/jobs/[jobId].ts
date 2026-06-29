import { requireApiKey } from '../../../_lib/auth';
import { error, handleOptions, json, methodNotAllowed, publicBaseUrl } from '../../../_lib/http';
import { getRememberedJob, modalJobStatusUrl, readModalStatus, updateRememberedJob } from '../../../_lib/modal';

function normalizeJobStatus(value: unknown): string {
  const status = String(value || '').toLowerCase();
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['queued', 'pending', 'created'].includes(status)) return 'queued';
  return 'processing';
}

function modalOutputFromPayload(modal: any): string | undefined {
  return modal.outputUrl || modal.output_url || modal.finalOutputUrl || modal.final_output_url || modal.previewUrl || modal.preview_url;
}

function publicOutputUrl(baseUrl: string, jobId: string): string {
  return `${baseUrl}/api/v1/video-removal/jobs/${jobId}/output`;
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    requireApiKey(req, 'video_removal:read');
    const jobId = String(req.query.jobId || '');
    const record = getRememberedJob(jobId);
    const baseUrl = publicBaseUrl(req);

    if (!record) {
      let modal: any;
      try {
        modal = await readModalStatus(modalJobStatusUrl(jobId));
      } catch {
        return error(res, 404, 'Job not found in API memory or GPU worker.', 'job_not_found');
      }

      const status = normalizeJobStatus(modal.phase || modal.status);
      const outputRaw = modalOutputFromPayload(modal);
      const hasOutput = Boolean(outputRaw) || status === 'completed';

      return json(res, 200, {
        job_id: modal.job_id || modal.jobId || modal.id || jobId,
        status,
        service: 'video_removal',
        mode: modal.mode || modal.pipeline || 'video_removal',
        quality: modal.quality || 'source',
        created_at: modal.created_at || modal.createdAt,
        status_url: `${baseUrl}/api/v1/video-removal/jobs/${jobId}`,
        output_url: hasOutput ? publicOutputUrl(baseUrl, jobId) : undefined,
        metadata: modal.metadata || { source: 'gpu_worker_fallback' },
      });
    }

    let updated = record;
    if (record.modal_status_url && record.status !== 'completed') {
      const modal = await readModalStatus(record.modal_status_url);
      const status = normalizeJobStatus(modal.phase || modal.status || record.status);
      const outputRaw = modalOutputFromPayload(modal);
      const hasOutput = Boolean(outputRaw) || status === 'completed';
      updated = updateRememberedJob(jobId, {
        status,
        output_url: hasOutput ? publicOutputUrl(baseUrl, jobId) : record.output_url,
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
