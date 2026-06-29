export type JsonBody = Record<string, unknown> | unknown[];

export function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', process.env.TREY_VIDEO_API_ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key,X-Admin-Key,X-Trey-Webhook-Signature');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function handleOptions(req: any, res: any): boolean {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function json(res: any, status: number, body: JsonBody) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(body);
}

export function error(res: any, status: number, message: string, code = 'api_error', details?: unknown) {
  json(res, status, {
    error: {
      code,
      message,
      details,
    },
  });
}

export function methodNotAllowed(res: any, allowed: string[]) {
  res.setHeader('Allow', allowed.join(', '));
  error(res, 405, `Method not allowed. Use ${allowed.join(' or ')}.`, 'method_not_allowed');
}

export async function readJson(req: any): Promise<any> {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);
  return {};
}

export function publicBaseUrl(req: any): string {
  const configured = process.env.TREY_VIDEO_API_PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (configured) return configured;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
