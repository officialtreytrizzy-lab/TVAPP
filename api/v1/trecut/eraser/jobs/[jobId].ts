import { error, handleOptions, json, methodNotAllowed } from '../../../../_lib/http.js';
import { fetchTreyVideoRemovalApi, readUpstreamJson, rewriteVideoRemovalJobPayload } from '../../../../_lib/trecut-eraser-proxy.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const jobId = String(req.query.jobId || '');
    const upstream = await fetchTreyVideoRemovalApi(req, '/jobs/' + encodeURIComponent(jobId), {
      method: 'GET',
    });
    const payload = await readUpstreamJson(upstream);

    if (!upstream.ok) {
      const message = payload?.error?.message || payload?.detail || payload?.error || 'eTreyser API status failed with HTTP ' + upstream.status;
      return error(res, upstream.status || 502, String(message), payload?.error?.code || 'trecut_eraser_status_failed', payload);
    }

    json(res, 200, rewriteVideoRemovalJobPayload(req, payload));
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read Trecut eTreyser job.', err.code || 'trecut_eraser_status_proxy_failed');
  }
}
