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
      note: 'Usage metering endpoint is wired. Replace this placeholder with Supabase usage_events aggregation before billing customers.',
      current_period: {
        processed_seconds: 0,
        render_seconds: 0,
        jobs_created: 0,
        estimated_cost_cents: 0,
      },
      units: ['processed_second', 'rendered_second', 'gpu_minute', 'storage_day'],
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read usage.', err.code || 'usage_read_failed');
  }
}
