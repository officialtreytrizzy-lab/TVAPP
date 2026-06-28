import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const keyId = process.env.TREY_VIDEO_API_KEY_ID || process.argv[2] || 'starter_key_1';
const organizationId = process.env.TREY_VIDEO_API_ORG || process.argv[3] || 'org_demo';
const plan = process.env.TREY_VIDEO_API_PLAN || process.argv[4] || 'starter';
const scopes = process.env.TREY_VIDEO_API_SCOPES || 'video_removal:write video_removal:read video_editor:write video_editor:read';

const secret = `tve_live_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(secret).digest('hex');
const envValue = `${keyId};${hash};${organizationId};${plan};${scopes}`;

writeFileSync('trey-video-api-key.local.txt', [
  'Trey Video API key generated locally. Do not commit or share publicly.',
  '',
  `API key ID: ${keyId}`,
  `Organization: ${organizationId}`,
  `Plan: ${plan}`,
  `Scopes: ${scopes}`,
  '',
  'Customer/developer bearer token:',
  secret,
  '',
  'Vercel TREY_VIDEO_API_KEYS value:',
  envValue,
  '',
].join('\n'));

// Stdout is intentionally only the env value so this script can pipe directly
// into `vercel env add TREY_VIDEO_API_KEYS production`.
process.stdout.write(envValue);
