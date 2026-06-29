import { requireAdmin } from '../../_lib/admin';
import { reviewApiKeyInquiry } from '../../_lib/api-key-approvals';
import { error, handleOptions, json, methodNotAllowed, readJson } from '../../_lib/http';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'PATCH' && req.method !== 'POST') return methodNotAllowed(res, ['PATCH', 'POST']);

  try {
    requireAdmin(req);
    const body = await readJson(req);
    const requestId = String(body.request_id || body.requestId || '');
    const result = reviewApiKeyInquiry(requestId, body);

    json(res, 200, {
      request: result.request,
      token: result.api_key,
      env_record: result.env_record,
      message: result.api_key ? 'Approved.' : 'Denied.',
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not review API credential request.', err.code || 'admin_api_key_review_failed');
  }
}
