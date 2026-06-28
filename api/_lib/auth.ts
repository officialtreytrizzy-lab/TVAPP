import { createHash, timingSafeEqual } from 'node:crypto';

export interface ApiClient {
  keyId: string;
  organizationId: string;
  plan: string;
  scopes: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function parseBearer(req: any): string {
  const raw = String(req.headers.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function parseConfiguredKeys(): ApiClient[] {
  const raw = process.env.TREY_VIDEO_API_KEYS || '';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const [keyId, keyHash, organizationId = 'default_org', plan = 'starter', scopeText = 'video_removal:write video_removal:read video_editor:write video_editor:read'] = entry.split(':');
      return {
        keyId,
        keyHash,
        organizationId,
        plan,
        scopes: scopeText.split(/[\s|]+/).filter(Boolean),
      };
    })
    .filter((client) => client.keyId && client.keyHash) as Array<ApiClient & { keyHash: string }>;
}

export function authenticate(req: any, requiredScope?: string): ApiClient | null {
  const token = parseBearer(req);
  if (!token) return null;
  const digest = sha256(token);
  const clients = parseConfiguredKeys();

  for (const client of clients) {
    if (!safeEqualHex(digest, client.keyHash)) continue;
    const apiClient: ApiClient = {
      keyId: client.keyId,
      organizationId: client.organizationId,
      plan: client.plan,
      scopes: client.scopes,
    };
    if (requiredScope && !apiClient.scopes.includes(requiredScope) && !apiClient.scopes.includes('*')) {
      return null;
    }
    return apiClient;
  }

  return null;
}

export function requireApiKey(req: any, scope: string): ApiClient {
  const client = authenticate(req, scope);
  if (!client) {
    const err = new Error('Missing, invalid, or under-scoped API key.');
    (err as any).status = 401;
    (err as any).code = 'unauthorized';
    throw err;
  }
  return client;
}

export function describeAuthSetup() {
  return {
    header: 'Authorization: Bearer tve_live_xxx',
    env: 'TREY_VIDEO_API_KEYS=key_id:sha256_hash:organization_id:plan:scopes',
    hashCommand: 'node -e "console.log(require(\'crypto\').createHash(\'sha256\').update(process.argv[1]).digest(\'hex\'))" tve_live_your_secret_key',
  };
}
