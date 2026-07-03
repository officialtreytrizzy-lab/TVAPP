import { requireAdmin } from '../../_lib/admin.js';
import { listApiKeyInquiries } from '../../_lib/api-key-approvals.js';
import { error, handleOptions, json, methodNotAllowed } from '../../_lib/http.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    requireAdmin(req);
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    const requests = listApiKeyInquiries(status);
    json(res, 200, {
      requests,
      count: requests.length,
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not list API key requests.', err.code || 'admin_api_key_requests_failed');
  }
}
