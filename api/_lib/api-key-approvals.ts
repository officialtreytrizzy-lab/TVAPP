import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ApiKeyRequestStatus = 'pending' | 'approved' | 'denied';

export interface ApiKeyInquiry {
  id: string;
  status: ApiKeyRequestStatus;
  name: string;
  email: string;
  organization: string;
  use_case: string;
  website?: string;
  requested_scopes: string[];
  plan: string;
  created_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  decision_note?: string;
  approved_key_id?: string;
  approved_organization_id?: string;
}

export interface ApprovedApiKeyRecord {
  keyId: string;
  keyHash: string;
  organizationId: string;
  plan: string;
  scopes: string[];
  requestId: string;
  createdAt: string;
  createdBy: string;
  status: 'active' | 'revoked';
}

interface StoreShape {
  requests: ApiKeyInquiry[];
  approvedKeys: ApprovedApiKeyRecord[];
}

const DEFAULT_SCOPES = ['video_removal:write', 'video_removal:read', 'video_editor:write', 'video_editor:read'];
const STORE_PATH = process.env.TREY_VIDEO_API_APPROVAL_STORE_PATH || '/tmp/trey-video-api-approvals.json';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function cleanText(value: unknown, fallback = ''): string {
  return String(value || fallback).trim().slice(0, 2000);
}

function cleanScopes(value: unknown): string[] {
  const scopes = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const cleaned = scopes.map((scope) => String(scope).trim()).filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)) : DEFAULT_SCOPES;
}

function blankStore(): StoreShape {
  return { requests: [], approvedKeys: [] };
}

function readStore(): StoreShape {
  const envSeed = process.env.TREY_VIDEO_API_APPROVALS_JSON;
  if (!existsSync(STORE_PATH) && envSeed) {
    try {
      const seeded = JSON.parse(envSeed) as StoreShape;
      return {
        requests: Array.isArray(seeded.requests) ? seeded.requests : [],
        approvedKeys: Array.isArray(seeded.approvedKeys) ? seeded.approvedKeys : [],
      };
    } catch {
      return blankStore();
    }
  }

  if (!existsSync(STORE_PATH)) return blankStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as StoreShape;
    return {
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
      approvedKeys: Array.isArray(parsed.approvedKeys) ? parsed.approvedKeys : [],
    };
  } catch {
    return blankStore();
  }
}

function writeStore(store: StoreShape) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function createApiKeyInquiry(input: any): ApiKeyInquiry {
  const name = cleanText(input.name);
  const email = cleanText(input.email).toLowerCase();
  const organization = cleanText(input.organization || input.company || 'Independent developer');
  const useCase = cleanText(input.use_case || input.useCase);
  if (!name) throw Object.assign(new Error('Name is required.'), { status: 400, code: 'name_required' });
  if (!email || !email.includes('@')) throw Object.assign(new Error('Valid email is required.'), { status: 400, code: 'email_required' });
  if (!useCase) throw Object.assign(new Error('Use case is required.'), { status: 400, code: 'use_case_required' });

  const store = readStore();
  const request: ApiKeyInquiry = {
    id: `akreq_${randomBytes(10).toString('hex')}`,
    status: 'pending',
    name,
    email,
    organization,
    use_case: useCase,
    website: cleanText(input.website),
    requested_scopes: cleanScopes(input.requested_scopes || input.scopes),
    plan: cleanText(input.plan, 'starter'),
    created_at: now(),
  };

  store.requests.unshift(request);
  writeStore(store);
  return request;
}

export function listApiKeyInquiries(status?: string): ApiKeyInquiry[] {
  const store = readStore();
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return store.requests;
  return store.requests.filter((request) => request.status === normalized);
}

export function listApprovedApiKeys(): ApprovedApiKeyRecord[] {
  return readStore().approvedKeys.filter((key) => key.status === 'active');
}

export function reviewApiKeyInquiry(requestId: string, input: any): { request: ApiKeyInquiry; api_key?: string; env_record?: string } {
  const store = readStore();
  const index = store.requests.findIndex((request) => request.id === requestId);
  if (index === -1) throw Object.assign(new Error('API key request not found.'), { status: 404, code: 'request_not_found' });

  const decision = cleanText(input.decision || input.status).toLowerCase();
  const reviewer = cleanText(input.reviewed_by || input.reviewer || 'admin');
  const note = cleanText(input.decision_note || input.note);
  const current = store.requests[index];
  if (current.status !== 'pending') throw Object.assign(new Error('This API key request has already been reviewed.'), { status: 409, code: 'request_already_reviewed' });

  if (decision === 'deny' || decision === 'denied') {
    const denied: ApiKeyInquiry = {
      ...current,
      status: 'denied',
      reviewed_at: now(),
      reviewed_by: reviewer,
      decision_note: note,
    };
    store.requests[index] = denied;
    writeStore(store);
    return { request: denied };
  }

  if (decision !== 'approve' && decision !== 'approved') {
    throw Object.assign(new Error('Decision must be approve or deny.'), { status: 400, code: 'invalid_decision' });
  }

  const keyId = `tve_${randomBytes(6).toString('hex')}`;
  const organizationId = cleanText(input.organization_id || current.organization.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''), 'approved_org');
  const plan = cleanText(input.plan || current.plan, 'starter');
  const scopes = cleanScopes(input.scopes || current.requested_scopes);
  const secret = `tve_live_${randomBytes(32).toString('base64url')}`;
  const keyHash = sha256(secret);
  const approvedKey: ApprovedApiKeyRecord = {
    keyId,
    keyHash,
    organizationId,
    plan,
    scopes,
    requestId: current.id,
    createdAt: now(),
    createdBy: reviewer,
    status: 'active',
  };

  const approved: ApiKeyInquiry = {
    ...current,
    status: 'approved',
    reviewed_at: approvedKey.createdAt,
    reviewed_by: reviewer,
    decision_note: note,
    approved_key_id: keyId,
    approved_organization_id: organizationId,
  };

  store.requests[index] = approved;
  store.approvedKeys.unshift(approvedKey);
  writeStore(store);

  return {
    request: approved,
    api_key: secret,
    env_record: `${keyId};${keyHash};${organizationId};${plan};${scopes.join(' ')}`,
  };
}
