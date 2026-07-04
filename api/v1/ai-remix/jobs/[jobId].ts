import { requireApiKey } from '../../../_lib/auth.js';
import { error, handleOptions, json, methodNotAllowed, publicBaseUrl } from '../../../_lib/http.js';
import { getRememberedJob, modalAiRemixOutputFromPayload, modalAiRemixStatusUrl, readModalStatus, updateRememberedJob } from '../../../_lib/modal.js';

function normalizeJobStatus(value: unknown): string {
  const status = String(value || '').toLowerCase();
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['queued', 'pending', 'created'].includes(status)) return 'queued';
  return 'processing';
}

function publicOutputUrl(baseUrl: string, jobId: string): string {
  return `${baseUrl}/api/v1/ai-remix/jobs/${jobId}/output`;
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
        modal = await readModalStatus(modalAiRemixStatusUrl(jobId));
      } catch {
        return error(res, 404, 'AI Remix job not found in API memory or GPU worker.', 'job_not_found');
      }
      const status = normalizeJobStatus(modal.phase || modal.status);
      const outputRaw = modalAiRemixOutputFromPayload(modal);
      return json(res, 200, {
        job_id: modal.job_id || modal.jobId || modal.id || jobId,
        status,
        service: 'ai_remix',
        mode: modal.intent || modal.mode || 'full_video_to_video',
        quality: modal.quality || 'source',
        prompt: modal.prompt,
        strength: modal.strength,
        status_url: `${baseUrl}/api/v1/ai-remix/jobs/${jobId}`,
        output_url: outputRaw ? publicOutputUrl(baseUrl, jobId) : undefined,
        metadata: modal.metadata || { source: 'gpu_worker_fallback' },
      });
    }

    let updated = record;
    if (record.modal_status_url && record.status !== 'completed') {
      const modal = await readModalStatus(record.modal_status_url);
      const status = normalizeJobStatus(modal.phase || modal.status || record.status);
      const outputRaw = modalAiRemixOutputFromPayload(modal);
      updated = updateRememberedJob(jobId, {
        status,
        output_url: outputRaw ? publicOutputUrl(baseUrl, jobId) : undefined,
        metadata: {
          ...(record.metadata || {}),
          worker_output_kind: outputRaw ? 'ai_remix_video' : status,
          worker_message: modal.statusMessage || modal.message,
          worker_error: modal.error,
        },
      }) || record;
    }

    json(res, 200, {
      job_id: updated.job_id,
      status: updated.status,
      service: updated.service,
      mode: updated.mode,
      quality: updated.quality,
      status_url: updated.status_url,
      output_url: updated.output_url,
      metadata: updated.metadata,
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read AI Remix job.', err.code || 'ai_remix_status_failed');
  }
}
