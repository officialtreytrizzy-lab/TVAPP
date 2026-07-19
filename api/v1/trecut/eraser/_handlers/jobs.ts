import { error, handleOptions, json, methodNotAllowed, publicBaseUrl, readJson } from '../../../../_lib/http.js';
import { newPublicJobId, rememberJob, submitRemovalToModal, type RemovalJobRequest } from '../../../../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = (await readJson(req)) as RemovalJobRequest;
    const jobId = newPublicJobId('etreyser');
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
      output_mode: body.output_mode || 'composite',
      return_mode: body.return_mode || 'composite',
      result_mode: body.result_mode || 'full_video',
      output_kind: body.output_kind || 'full_video',
      composite_output: body.composite_output !== false,
      full_frame_output: body.full_frame_output !== false,
      full_video_output: body.full_video_output !== false,
      patch_only: body.patch_only === true,
      return_patch: body.return_patch === true,
      metadata: {
        ...(body.metadata || {}),
        source: 'tvapp_etreyser_first_party',
        auth_mode: 'first_party_internal',
      },
    });

    const statusUrl = `${baseUrl}/api/v1/trecut/eraser/jobs/${jobId}`;
    const outputUrl = submitted.outputUrl ? `${baseUrl}/api/v1/trecut/eraser/jobs/${jobId}/output` : undefined;

    const record = {
      job_id: jobId,
      external_job_id: submitted.externalJobId,
      status: submitted.phase === 'completed' ? 'completed' : 'processing',
      service: 'video_removal' as const,
      mode,
      quality,
      created_at: new Date().toISOString(),
      status_url: statusUrl,
      output_url: outputUrl,
      modal_status_url: submitted.statusUrl,
      metadata: {
        ...(body.metadata || {}),
        source: 'tvapp_etreyser_first_party',
        auth_mode: 'first_party_internal',
        worker_output_kind: submitted.outputUrl ? 'strict_composite' : undefined,
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
      metadata: record.metadata,
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not create first-party eTreyser GPU job.', err.code || 'etreyser_first_party_job_failed');
  }
}
