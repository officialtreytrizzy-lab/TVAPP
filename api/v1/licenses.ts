import { requireApiKey } from '../_lib/auth';
import { error, handleOptions, json, methodNotAllowed } from '../_lib/http';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const client = requireApiKey(req, 'video_removal:read');
    json(res, 200, {
      organization_id: client.organizationId,
      plan: client.plan,
      key_id: client.keyId,
      scopes: client.scopes,
      products: [
        {
          id: 'video_removal',
          name: 'Video ETreyser API',
          status: 'enabled',
          modes: ['static_logo', 'moving_object'],
          quality: ['source', 'higher'],
          commercial_model_required: true,
        },
        {
          id: 'video_editor',
          name: 'OpenCut Mobile Render API',
          status: 'developer_preview',
          modes: ['mobile_project_render'],
        },
      ],
      policy: {
        allowed: ['owned-content cleanup', 'creative edits', 'production repair', 'licensed watermark/logo cleanup'],
        disallowed: ['removing marks from content the caller does not own', 'fraud', 'deceptive edits', 'illegal use'],
      },
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read license.', err.code || 'license_read_failed');
  }
}
