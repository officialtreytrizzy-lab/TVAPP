import { requireApiKey } from '../../../_lib/auth.js';
import { error, handleOptions, json, methodNotAllowed, publicBaseUrl, readJson } from '../../../_lib/http.js';
import { newPublicJobId, rememberJob, submitMixTransitionToModal, type MixTransitionJobRequest } from '../../../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const client = requireApiKey(req, 'video_editor:write');
    const body = (await readJson(req)) as MixTransitionJobRequest;
    const jobId = newPublicJobId('vmix');
    const baseUrl = publicBaseUrl(req);
    const duration = Number(body.duration || 1);
    const quality = body.quality === 'higher' ? 'higher' : 'source';

    const submitted = await submitMixTransitionToModal(jobId, {
      ...body,
      duration: Number.isFinite(duration) ? duration : 1,
      quality,
    });

    const record = {
      job_id: jobId,
      external_job_id: submitted.externalJobId,
      status: submitted.phase === 'completed' ? 'completed' : 'processing',
      service: 'video_transition' as const,
      mode: 'mix',
      quality,
      created_at: new Date().toISOString(),
      status_url: `${baseUrl}/api/v1/video-transitions/status?job_id=${encodeURIComponent(jobId)}`,
      output_url: submitted.outputUrl ? `${baseUrl}/api/v1/video-transitions/output?job_id=${encodeURIComponent(jobId)}` : undefined,
      modal_status_url: submitted.statusUrl,
      metadata: {
        ...(body.metadata || {}),
        transition: 'mix',
        duration: Number.isFinite(duration) ? duration : 1,
        organization_id: client.organizationId,
        plan: client.plan,
        key_id: client.keyId,
        webhook_url: body.webhook_url,
      },
    };
    rememberJob(record);

    json(res, 202, {
      ...record,
      progress: submitted.progress,
      message: 'Mix transition render queued.',
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not create Mix transition job.', err.code || 'mix_transition_failed');
  }
}
