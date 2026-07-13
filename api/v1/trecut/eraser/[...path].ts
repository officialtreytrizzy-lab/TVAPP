import { error, handleOptions } from '../../../_lib/http.js';
import createJob from './_handlers/jobs.js';
import readJob from './_handlers/job.js';
import readOutput from './_handlers/output.js';
import uploadTarget from './_handlers/upload-target.js';

function routeSegments(req: any): string[] {
  const value = req.query?.path;
  return (Array.isArray(value) ? value : value ? [value] : []).map(String);
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  const segments = routeSegments(req);
  if (segments.length === 1 && segments[0] === 'upload-target') return uploadTarget(req, res);
  if (segments[0] !== 'jobs') return error(res, 404, 'eTreyser endpoint not found.', 'not_found');
  if (segments.length === 1) return createJob(req, res);
  req.query = { ...(req.query || {}), jobId: segments[1] };
  if (segments.length === 2) return readJob(req, res);
  if (segments.length === 3 && segments[2] === 'output') return readOutput(req, res);
  return error(res, 404, 'eTreyser endpoint not found.', 'not_found');
}
