import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const requiredFiles = [
  'api/_lib/auth.ts',
  'api/_lib/http.ts',
  'api/_lib/modal.ts',
  'api/v1/health.ts',
  'api/v1/licenses.ts',
  'api/v1/usage.ts',
  'api/v1/video-removal/[...path].ts',
  'api/v1/video-removal/_handlers/jobs.ts',
  'api/v1/video-removal/_handlers/job.ts',
  'api/v1/video-removal/_handlers/output.ts',
  'api/v1/video-editor/render-jobs.ts',
  'docs/TREY_VIDEO_API.md',
];

const failures = [];
function file(path) {
  if (!existsSync(path)) failures.push(`Missing ${path}`);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
function requireText(path, text, reason) {
  const body = file(path);
  if (!body.includes(text)) failures.push(`${path} missing ${JSON.stringify(text)} — ${reason}`);
}

for (const path of requiredFiles) file(path);

function vercelFunctions(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...vercelFunctions(full));
    else if (/\.(?:js|mjs|cjs|ts)$/.test(entry.name)) results.push(full.replaceAll('\\', '/'));
  }
  return results;
}

const deployedFunctions = vercelFunctions('api');
if (deployedFunctions.length > 12) {
  failures.push(`Vercel Hobby supports at most 12 functions; found ${deployedFunctions.length}: ${deployedFunctions.join(', ')}`);
}

requireText('api/_lib/auth.ts', 'TREY_VIDEO_API_KEYS', 'API keys must be configured through env');
requireText('api/_lib/auth.ts', 'sha256', 'API keys must be hash-checked, not stored raw in code');
requireText('api/_lib/auth.ts', 'timingSafeEqual', 'API key comparison must be timing-safe');
requireText('api/_lib/modal.ts', 'VITE_ERASER_GPU_WORKER_URL', 'public API must proxy to the private Modal worker');
requireText('api/_lib/modal.ts', 'submitRemovalToModal', 'video removal jobs must route into the worker');
requireText('api/v1/video-removal/_handlers/jobs.ts', 'video_removal:write', 'job creation must require write scope');
requireText('api/v1/video-removal/_handlers/job.ts', 'video_removal:read', 'job reads must require read scope');
requireText('api/v1/video-removal/_handlers/output.ts', 'video_removal:read', 'output reads must require read scope');
requireText('api/v1/video-editor/render-jobs.ts', 'video_editor:write', 'OpenCut render jobs must require write scope');
requireText('api/v1/licenses.ts', 'commercial_model_required', 'license response must warn about commercial model clearance');
requireText('docs/TREY_VIDEO_API.md', 'ProPainter is wired for proof-of-pipeline', 'docs must keep model license warning');

if (failures.length) {
  console.error('\nTrey Video API contract failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Trey Video API contract passed. Licensed endpoints, API key auth, Modal proxy, docs, and scope checks are intact.');
