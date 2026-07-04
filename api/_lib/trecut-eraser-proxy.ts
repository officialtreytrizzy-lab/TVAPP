import { publicBaseUrl } from './http';

const TOKEN_ENV_NAMES = [
  'TRECUT_ETREYSER_API_KEY',
  'TREY_VIDEO_API_BEARER_TOKEN',
  'TREY_VIDEO_API_KEY',
];

export function trecutEraserApiToken(): string {
  for (const name of TOKEN_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function trecutEraserApiBaseUrl(req: any): string {
  return (
    process.env.TRECUT_ETREYSER_API_BASE_URL ||
    process.env.TREY_VIDEO_API_PUBLIC_BASE_URL ||
    publicBaseUrl(req)
  ).replace(/\/$/, '');
}

export function trecutEraserProxyBaseUrl(req: any): string {
  return `${publicBaseUrl(req).replace(/\/$/, '')}/api/v1/trecut/eraser`;
}

export function rewriteVideoRemovalJobPayload(req: any, payload: any): any {
  const proxyBase = trecutEraserProxyBaseUrl(req);
  const jobId = payload?.job_id || payload?.jobId || payload?.id;
  const hasOutput = Boolean(payload?.output_url || payload?.outputUrl);

  return {
    ...payload,
    job_id: jobId || payload?.job_id,
    status_url: jobId ? `${proxyBase}/jobs/${encodeURIComponent(jobId)}` : payload?.status_url || payload?.statusUrl,
    output_url: jobId && hasOutput ? `${proxyBase}/jobs/${encodeURIComponent(jobId)}/output` : undefined,
  };
}

export async function fetchTreyVideoRemovalApi(req: any, path: string, init: RequestInit = {}): Promise<Response> {
  const token = trecutEraserApiToken();
  if (!token) {
    throw Object.assign(new Error('Trecut eTreyser API key is not configured. Set TRECUT_ETREYSER_API_KEY in server/Vercel env.'), {
      status: 500,
      code: 'trecut_eraser_key_missing',
    });
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const base = trecutEraserApiBaseUrl(req);
  return fetch(`${base}/api/v1/video-removal${path}`, {
    ...init,
    headers,
  });
}

export async function readUpstreamJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
