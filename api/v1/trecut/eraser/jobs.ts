import { error, handleOptions, json, methodNotAllowed, readJson } from '../../../_lib/http';
import { fetchTreyVideoRemovalApi, readUpstreamJson, rewriteVideoRemovalJobPayload } from '../../../_lib/trecut-eraser-proxy';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = await readJson(req);
    const upstream = await fetchTreyVideoRemovalApi(req, '/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const payload = await readUpstreamJson(upstream);

    if (!upstream.ok) {
      const message = payload?.error?.message || payload?.detail || payload?.error || `eTreyser API failed with HTTP ${upstream.status}`;
      return error(res, upstream.status || 502, String(message), payload?.error?.code || 'trecut_eraser_job_failed', payload);
    }

    json(res, upstream.status || 202, rewriteVideoRemovalJobPayload(req, payload));
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not create Trecut eTreyser job.', err.code || 'trecut_eraser_proxy_failed');
  }
}
