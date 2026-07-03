import { requireApiKey } from '../../_lib/auth.js';
import { error, handleOptions, json, methodNotAllowed, publicBaseUrl, readJson } from '../../_lib/http.js';
import { newPublicJobId, rememberJob, submitRemovalToModal, type RemovalJobRequest } from '../../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const client = requireApiKey(req, 'video_removal:write');
    const body = (await readJson(req)) as RemovalJobRequest;
    const jobId = newPublicJobId('vrem');
    const baseUrl = publicBaseUrl(req);

    const quality = body.quality === 'higher' ? 'higher' : 'source';
    const mode = body.mode || 'static_logo';

    const submitted = await submitRemovalToModal(jobId, {
      ...body,
      mode,
      quality,
      preserve_resolution: body.preserve_resolution !== false,
      preserve_fps: body.preserve_fps !== false,
      preserve_audio: body.preserve_audio !== false,
    });

    const record = {
      job_id: jobId,
      external_job_id: submitted.externalJobId,
      status: submitted.phase === 'completed' ? 'completed' : 'processing',
      service: 'video_removal' as const,
      mode,
      quality,
      created_at: new Date().toISOString(),
      status_url: `${baseUrl}/api/v1/video-removal/jobs/${jobId}`,
      output_url: submitted.outputUrl ? `${baseUrl}/api/v1/video-removal/jobs/${jobId}/output` : undefined,
      modal_status_url: submitted.statusUrl,
      metadata: {
        ...(body.metadata || {}),
        organization_id: client.organizationId,
        plan: client.plan,
        key_id: client.keyId,
        webhook_url: body.webhook_url,
      },
    };
    rememberJob(record);

    json(res, 202, {
      job_id: record.job_id,
      status: record.status,
      service: record.service,
      mode: record.mode,
      quality: record.quality,
      status_url: record.status_url,
      output_url: record.output_url,
      created_at: record.created_at,
      billing: {
        unit: 'processed_second',
        metered: true,
      },
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not create video-removal job.', err.code || 'video_removal_job_failed');
  }
}
