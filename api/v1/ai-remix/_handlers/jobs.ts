import { requireApiKey } from '../../../_lib/auth.js';
import { error, handleOptions, json, methodNotAllowed, publicBaseUrl, readJson } from '../../../_lib/http.js';
import { newPublicJobId, rememberJob, submitAiRemixToModal, type AiRemixJobRequest } from '../../../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const client = requireApiKey(req, 'video_removal:write');
    const body = (await readJson(req)) as AiRemixJobRequest;
    if (!body.prompt?.trim()) return error(res, 400, 'prompt is required.', 'prompt_required');

    const jobId = newPublicJobId('remix');
    const baseUrl = publicBaseUrl(req);
    const strength = body.strength && ['light', 'medium', 'heavy'].includes(String(body.strength)) ? String(body.strength) : 'medium';
    const quality = body.quality && ['draft', 'source', 'high'].includes(String(body.quality)) ? String(body.quality) : 'source';
    const intent = body.intent || 'full_video_to_video';

    const submitted = await submitAiRemixToModal(jobId, {
      ...body,
      intent,
      strength,
      quality,
      preserve_audio: body.preserve_audio !== false,
      preserve_face: body.preserve_face !== false,
      preserve_motion: body.preserve_motion !== false,
    });

    const record = {
      job_id: jobId,
      external_job_id: submitted.externalJobId,
      status: submitted.phase === 'completed' ? 'completed' : 'processing',
      service: 'ai_remix' as const,
      mode: intent,
      quality,
      created_at: new Date().toISOString(),
      status_url: `${baseUrl}/api/v1/ai-remix/jobs/${jobId}`,
      output_url: submitted.outputUrl ? `${baseUrl}/api/v1/ai-remix/jobs/${jobId}/output` : undefined,
      modal_status_url: submitted.statusUrl,
      metadata: {
        ...(body.metadata || {}),
        prompt: body.prompt,
        strength,
        organization_id: client.organizationId,
        plan: client.plan,
        key_id: client.keyId,
      },
    };
    rememberJob(record);

    json(res, 202, {
      job_id: record.job_id,
      status: record.status,
      service: record.service,
      mode: record.mode,
      quality: record.quality,
      prompt: body.prompt,
      strength,
      status_url: record.status_url,
      output_url: record.output_url,
      created_at: record.created_at,
      billing: {
        unit: 'generated_second',
        metered: true,
      },
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not create AI Remix job.', err.code || 'ai_remix_job_failed');
  }
}
