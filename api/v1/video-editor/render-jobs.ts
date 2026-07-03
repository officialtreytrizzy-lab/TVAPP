import { requireApiKey } from '../../_lib/auth.js';
import { error, handleOptions, json, methodNotAllowed, publicBaseUrl, readJson } from '../../_lib/http.js';
import { newPublicJobId } from '../../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const client = requireApiKey(req, 'video_editor:write');
    const body = await readJson(req);
    const jobId = newPublicJobId('vrnd');
    const baseUrl = publicBaseUrl(req);

    json(res, 202, {
      job_id: jobId,
      status: 'queued',
      service: 'video_editor',
      render_engine: 'opencut_mobile',
      status_url: `${baseUrl}/api/v1/video-editor/render-jobs/${jobId}`,
      message: 'Render job accepted. Full server-side OpenCut rendering is staged for the next worker pass.',
      project: body?.project || null,
      organization_id: client.organizationId,
      billing: {
        unit: 'rendered_second',
        metered: true,
      },
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not create render job.', err.code || 'video_editor_render_failed');
  }
}
