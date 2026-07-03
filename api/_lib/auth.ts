import { createHash, timingSafeEqual } from 'node:crypto';
import { listApprovedApiKeys } from './api-key-approvals.js';

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

function parseKeyEntry(entry: string): Array<ApiClient & { keyHash: string }> {
  // Preferred format uses semicolons because OAuth-style scopes contain colons:
  // key_id;sha256_hash;organization_id;plan;video_removal:write video_removal:read
  if (entry.includes(';')) {
    const [keyId, keyHash, organizationId = 'default_org', plan = 'starter', scopeText = 'video_removal:write video_removal:read video_editor:write video_editor:read'] = entry.split(';');
    if (!keyId || !keyHash) return [];
    return [{
      keyId,
      keyHash,
      organizationId,
      plan,
      scopes: scopeText.split(/[\s,]+/).filter(Boolean),
    }];
  }

  // Legacy fallback: key_id:sha256_hash only.
  const [keyId, keyHash] = entry.split(':');
  if (!keyId || !keyHash) return [];
  return [{
    keyId,
    keyHash,
    organizationId: 'default_org',
    plan: 'starter',
    scopes: ['video_removal:write', 'video_removal:read', 'video_editor:write', 'video_editor:read'],
  }];
}

function parseConfiguredKeys(): Array<ApiClient & { keyHash: string }> {
  const raw = process.env.TREY_VIDEO_API_KEYS || '';
  return raw
    .split('\n')
    .flatMap((line) => line.split('|KEY|'))
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap(parseKeyEntry);
}

function parseApprovedKeys(): Array<ApiClient & { keyHash: string }> {
  return listApprovedApiKeys().map((key) => ({
    keyId: key.keyId,
    keyHash: key.keyHash,
    organizationId: key.organizationId,
    plan: key.plan,
    scopes: key.scopes,
  }));
}

export function authenticate(req: any, requiredScope?: string): ApiClient | null {
  const token = parseBearer(req);
  if (!token) return null;
  const digest = sha256(token);
  const clients = [...parseConfiguredKeys(), ...parseApprovedKeys()];

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
    env: 'TREY_VIDEO_API_KEYS=key_id;sha256_hash;organization_id;plan;scopes',
    multipleKeys: 'Separate multiple key records with |KEY| or new lines. Admin-approved runtime keys are also accepted.',
    hashCommand: 'node -e "console.log(require(\'crypto\').createHash(\'sha256\').update(process.argv[1]).digest(\'hex\'))" tve_live_your_secret_key',
  };
}
