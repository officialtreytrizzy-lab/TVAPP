import { createApiKeyInquiry } from '../_lib/api-key-approvals';
import { error, handleOptions, json, methodNotAllowed, readJson } from '../_lib/http';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const body = await readJson(req);
    const request = createApiKeyInquiry(body);
    json(res, 202, {
      request_id: request.id,
      status: request.status,
      message: 'API key request submitted. An admin must approve it before a key is issued.',
    });
  } catch (e) {
    const err = e as any;
    error(res, err.status || 500, err.message || 'Could not submit API key request.', err.code || 'api_key_request_failed');
  }
}
