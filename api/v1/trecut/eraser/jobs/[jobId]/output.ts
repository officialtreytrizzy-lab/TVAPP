import { error, handleOptions, methodNotAllowed } from '../../../../../_lib/http.js';
import { fetchTreyVideoRemovalApi } from '../../../../../_lib/trecut-eraser-proxy.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const jobId = String(req.query.jobId || '');
    const upstream = await fetchTreyVideoRemovalApi(req, '/jobs/' + encodeURIComponent(jobId) + '/output', {
      method: 'GET',
    });

    if (!upstream.ok || !upstream.body) {
      return error(res, upstream.status || 502, 'Output not ready from eTreyser API: HTTP ' + upstream.status, 'trecut_eraser_output_not_ready');
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', 'inline; filename="' + jobId + '.mp4"');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(200).send(buffer);
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not read Trecut eTreyser output.', err.code || 'trecut_eraser_output_proxy_failed');
  }
}
