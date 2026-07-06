import { error, handleOptions, json, methodNotAllowed, publicBaseUrl } from '../../../../_lib/http.js';
import { getRememberedJob, modalCompositeOutputFromPayload, modalJobStatusUrl, readModalStatus, updateRememberedJob } from '../../../../_lib/modal.js';

function normalizeJobStatus(value: unknown): string {
  const status = String(value || '').toLowerCase();
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['queued', 'pending', 'created'].includes(status)) return 'queued';
  return 'processing';
}

function workerMessage(modal: any): string | undefined {
  const raw = modal?.statusMessage || modal?.status_message || modal?.message || modal?.detail || modal?.error_message || modal?.error;
  if (!raw) return undefined;
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function workerError(modal: any): string | undefined {
  const raw = modal?.error_message || modal?.error || modal?.detail;
  if (!raw) return undefined;
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function workerProgress(modal: any, status: string): number {
  const value = Number(modal?.progress ?? modal?.percent ?? modal?.percentage);
  if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  if (status === 'queued') return 20;
  if (status === 'completed') return 100;
  if (status === 'failed') return 20;
  return 25;
}

function publicOutputUrl(baseUrl: string, jobId: string): string {
  return `${baseUrl}/api/v1/trecut/eraser/jobs/${jobId}/output`;
}

function responseFromWorker(baseUrl: string, jobId: string, modal: any, fallback: Record<string, unknown> = {}) {
  const status = normalizeJobStatus(modal.phase || modal.status || fallback.status);
  const outputRaw = modalCompositeOutputFromPayload(modal);
  const message = workerMessage(modal);
  const err = workerError(modal);

  return {
    job_id: modal.job_id || modal.jobId || modal.id || jobId,
    status,
    phase: modal.phase || modal.status || status,
    progress: workerProgress(modal, status),
    statusMessage: message || (status === 'failed' ? 'eTreyser worker reported a failure.' : 'eTreyser is removing the selected object...'),
    status_message: message || (status === 'failed' ? 'eTreyser worker reported a failure.' : 'eTreyser is removing the selected object...'),
    error: err,
    error_message: err,
    service: 'video_removal',
    mode: modal.mode || modal.pipeline || fallback.mode || 'video_removal',
    quality: modal.quality || fallback.quality || 'source',
    created_at: modal.created_at || modal.createdAt || fallback.created_at,
    status_url: `${baseUrl}/api/v1/trecut/eraser/jobs/${jobId}`,
    output_url: outputRaw ? publicOutputUrl(baseUrl, jobId) : undefined,
    metadata: {
      ...((fallback.metadata as Record<string, unknown>) || {}),
      ...(modal.metadata || {}),
      auth_mode: 'first_party_internal',
      worker_output_kind: outputRaw ? 'strict_composite' : status === 'completed' ? 'raw_blob_only_no_public_output' : undefined,
    },
  };
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const jobId = String(req.query.jobId || '');
    const record = getRememberedJob(jobId);
    const baseUrl = publicBaseUrl(req);

    if (!record) {
      let modal: any;
      try {
        modal = await readModalStatus(modalJobStatusUrl(jobId));
      } catch (e) {
        const err = e as Error;
        return error(res, 404, err.message || 'Job not found in first-party eTreyser memory or GPU worker.', 'etreyser_job_not_found');
      }

      return json(res, 200, responseFromWorker(baseUrl, jobId, modal));
    }

    let payload: any = {
      job_id: record.job_id,
      status: record.status,
      service: record.service,
      mode: record.mode,
      quality: record.quality,
      created_at: record.created_at,
      status_url: record.status_url,
      output_url: record.output_url,
      metadata: record.metadata,
    };

    if (record.modal_status_url && record.status !== 'completed') {
      const modal = await readModalStatus(record.modal_status_url);
      const next = responseFromWorker(baseUrl, jobId, modal, record as unknown as Record<string, unknown>);
      updateRememberedJob(jobId, {
        status: next.status,
        output_url: next.output_url,
        metadata: next.metadata,
      });
      payload = next;
    }

    json(res, 200, payload);
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read first-party eTreyser job.', err.code || 'etreyser_first_party_status_failed');
  }
}
