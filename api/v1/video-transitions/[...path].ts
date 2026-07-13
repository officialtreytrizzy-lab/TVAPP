import { error, handleOptions } from '../../_lib/http.js';
import createMix from './_handlers/mix.js';
import readStatus from './_handlers/status.js';
import readOutput from './_handlers/output.js';

function routeSegment(req: any): string {
  const value = req.query?.path;
  const querySegment = String(Array.isArray(value) ? value[0] || '' : value || '').split('/').filter(Boolean)[0];
  if (querySegment) return querySegment;

  const pathname = String(req.url || '').split('?')[0];
  const marker = '/api/v1/video-transitions/';
  const markerIndex = pathname.indexOf(marker);
  const remainder = markerIndex >= 0 ? pathname.slice(markerIndex + marker.length) : '';
  return decodeURIComponent(remainder.split('/').filter(Boolean)[0] || '');
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  const route = routeSegment(req);
  if (route === 'mix') return createMix(req, res);
  if (route === 'status') return readStatus(req, res);
  if (route === 'output') return readOutput(req, res);
  return error(res, 404, 'Video-transition endpoint not found.', 'not_found');
}
