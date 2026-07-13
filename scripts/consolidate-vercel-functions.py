from __future__ import annotations

import re
from pathlib import Path

ROOT = Path.cwd()

MOVES = [
    ("api/v1/ai-remix/jobs.ts", "api/v1/ai-remix/_handlers/jobs.ts", "../../../_lib/"),
    ("api/v1/ai-remix/jobs/[jobId].ts", "api/v1/ai-remix/_handlers/job.ts", "../../../_lib/"),
    ("api/v1/ai-remix/jobs/[jobId]/output.ts", "api/v1/ai-remix/_handlers/output.ts", "../../../_lib/"),
    ("api/v1/video-removal/jobs.ts", "api/v1/video-removal/_handlers/jobs.ts", "../../../_lib/"),
    ("api/v1/video-removal/jobs/[jobId].ts", "api/v1/video-removal/_handlers/job.ts", "../../../_lib/"),
    ("api/v1/video-removal/jobs/[jobId]/output.ts", "api/v1/video-removal/_handlers/output.ts", "../../../_lib/"),
    ("api/v1/video-transitions/mix.ts", "api/v1/video-transitions/_handlers/mix.ts", "../../../_lib/"),
    ("api/v1/video-transitions/status.ts", "api/v1/video-transitions/_handlers/status.ts", "../../../_lib/"),
    ("api/v1/video-transitions/output.ts", "api/v1/video-transitions/_handlers/output.ts", "../../../_lib/"),
    ("api/v1/trecut/eraser/jobs.ts", "api/v1/trecut/eraser/_handlers/jobs.ts", "../../../../_lib/"),
    ("api/v1/trecut/eraser/jobs/[jobId].ts", "api/v1/trecut/eraser/_handlers/job.ts", "../../../../_lib/"),
    ("api/v1/trecut/eraser/jobs/[jobId]/output.ts", "api/v1/trecut/eraser/_handlers/output.ts", "../../../../_lib/"),
    ("api/v1/trecut/eraser/upload-target.ts", "api/v1/trecut/eraser/_handlers/upload-target.ts", "../../../../_lib/"),
]


def rewrite_lib_imports(source: str, prefix: str) -> str:
    return re.sub(
        r"from\s+(['\"])(?:\.\./)+_lib/",
        lambda match: f"from {match.group(1)}{prefix}",
        source,
    )


def move_handlers() -> None:
    for src_rel, dst_rel, prefix in MOVES:
        src = ROOT / src_rel
        dst = ROOT / dst_rel
        if not src.exists():
            if dst.exists():
                continue
            raise FileNotFoundError(f"Missing source handler: {src_rel}")
        body = rewrite_lib_imports(src.read_text(encoding="utf-8"), prefix)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(body, encoding="utf-8")
        src.unlink()


DISPATCHERS = {
    "api/v1/ai-remix/[...path].ts": """import { error, handleOptions } from '../../_lib/http.js';
import createJob from './_handlers/jobs.js';
import readJob from './_handlers/job.js';
import readOutput from './_handlers/output.js';

function routeSegments(req: any): string[] {
  const value = req.query?.path;
  return (Array.isArray(value) ? value : value ? [value] : []).map(String);
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  const segments = routeSegments(req);
  if (segments[0] !== 'jobs') return error(res, 404, 'AI Remix endpoint not found.', 'not_found');
  if (segments.length === 1) return createJob(req, res);
  req.query = { ...(req.query || {}), jobId: segments[1] };
  if (segments.length === 2) return readJob(req, res);
  if (segments.length === 3 && segments[2] === 'output') return readOutput(req, res);
  return error(res, 404, 'AI Remix endpoint not found.', 'not_found');
}
""",
    "api/v1/video-removal/[...path].ts": """import { error, handleOptions } from '../../_lib/http.js';
import createJob from './_handlers/jobs.js';
import readJob from './_handlers/job.js';
import readOutput from './_handlers/output.js';

function routeSegments(req: any): string[] {
  const value = req.query?.path;
  return (Array.isArray(value) ? value : value ? [value] : []).map(String);
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  const segments = routeSegments(req);
  if (segments[0] !== 'jobs') return error(res, 404, 'Video-removal endpoint not found.', 'not_found');
  if (segments.length === 1) return createJob(req, res);
  req.query = { ...(req.query || {}), jobId: segments[1] };
  if (segments.length === 2) return readJob(req, res);
  if (segments.length === 3 && segments[2] === 'output') return readOutput(req, res);
  return error(res, 404, 'Video-removal endpoint not found.', 'not_found');
}
""",
    "api/v1/video-transitions/[...path].ts": """import { error, handleOptions } from '../../_lib/http.js';
import createMix from './_handlers/mix.js';
import readStatus from './_handlers/status.js';
import readOutput from './_handlers/output.js';

function routeSegment(req: any): string {
  const value = req.query?.path;
  return String(Array.isArray(value) ? value[0] || '' : value || '');
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  const route = routeSegment(req);
  if (route === 'mix') return createMix(req, res);
  if (route === 'status') return readStatus(req, res);
  if (route === 'output') return readOutput(req, res);
  return error(res, 404, 'Video-transition endpoint not found.', 'not_found');
}
""",
    "api/v1/trecut/eraser/[...path].ts": """import { error, handleOptions } from '../../../_lib/http.js';
import createJob from './_handlers/jobs.js';
import readJob from './_handlers/job.js';
import readOutput from './_handlers/output.js';
import uploadTarget from './_handlers/upload-target.js';

function routeSegments(req: any): string[] {
  const value = req.query?.path;
  return (Array.isArray(value) ? value : value ? [value] : []).map(String);
}

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  const segments = routeSegments(req);
  if (segments.length === 1 && segments[0] === 'upload-target') return uploadTarget(req, res);
  if (segments[0] !== 'jobs') return error(res, 404, 'eTreyser endpoint not found.', 'not_found');
  if (segments.length === 1) return createJob(req, res);
  req.query = { ...(req.query || {}), jobId: segments[1] };
  if (segments.length === 2) return readJob(req, res);
  if (segments.length === 3 && segments[2] === 'output') return readOutput(req, res);
  return error(res, 404, 'eTreyser endpoint not found.', 'not_found');
}
""",
}


def write_dispatchers() -> None:
    for rel, body in DISPATCHERS.items():
        path = ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")


def update_contracts() -> None:
    api_contract = ROOT / "scripts/check-api-contract.mjs"
    body = api_contract.read_text(encoding="utf-8")
    body = body.replace(
        "import { existsSync, readFileSync } from 'node:fs';",
        "import { existsSync, readFileSync, readdirSync } from 'node:fs';\nimport { join } from 'node:path';",
    )
    body = body.replace(
        "  'api/v1/video-removal/jobs.ts',\n  'api/v1/video-removal/jobs/[jobId].ts',\n  'api/v1/video-removal/jobs/[jobId]/output.ts',",
        "  'api/v1/video-removal/[...path].ts',\n  'api/v1/video-removal/_handlers/jobs.ts',\n  'api/v1/video-removal/_handlers/job.ts',\n  'api/v1/video-removal/_handlers/output.ts',",
    )
    body = body.replace("requireText('api/v1/video-removal/jobs.ts',", "requireText('api/v1/video-removal/_handlers/jobs.ts',")
    body = body.replace("requireText('api/v1/video-removal/jobs/[jobId].ts',", "requireText('api/v1/video-removal/_handlers/job.ts',")
    body = body.replace("requireText('api/v1/video-removal/jobs/[jobId]/output.ts',", "requireText('api/v1/video-removal/_handlers/output.ts',")
    marker = "for (const path of requiredFiles) file(path);\n"
    guard = """for (const path of requiredFiles) file(path);

function vercelFunctions(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...vercelFunctions(full));
    else if (/\\.(?:js|mjs|cjs|ts)$/.test(entry.name)) results.push(full.replaceAll('\\\\', '/'));
  }
  return results;
}

const deployedFunctions = vercelFunctions('api');
if (deployedFunctions.length > 12) {
  failures.push(`Vercel Hobby supports at most 12 functions; found ${deployedFunctions.length}: ${deployedFunctions.join(', ')}`);
}
"""
    if "function vercelFunctions" not in body:
        body = body.replace(marker, guard)
    api_contract.write_text(body, encoding="utf-8")

    eraser_contract = ROOT / "scripts/check-eraser-contract.mjs"
    body = eraser_contract.read_text(encoding="utf-8")
    body = body.replace(
        "  'api/v1/trecut/eraser/jobs.ts',\n  'api/v1/trecut/eraser/jobs/[jobId].ts',\n  'api/v1/trecut/eraser/jobs/[jobId]/output.ts',\n  'api/v1/trecut/eraser/upload-target.ts',",
        "  'api/v1/trecut/eraser/[...path].ts',\n  'api/v1/trecut/eraser/_handlers/jobs.ts',\n  'api/v1/trecut/eraser/_handlers/job.ts',\n  'api/v1/trecut/eraser/_handlers/output.ts',\n  'api/v1/trecut/eraser/_handlers/upload-target.ts',",
    )
    body = body.replace("requireText('api/v1/trecut/eraser/jobs.ts',", "requireText('api/v1/trecut/eraser/_handlers/jobs.ts',")
    body = body.replace("requireText('api/v1/trecut/eraser/jobs/[jobId].ts',", "requireText('api/v1/trecut/eraser/_handlers/job.ts',")
    body = body.replace("requireText('api/v1/trecut/eraser/jobs/[jobId]/output.ts',", "requireText('api/v1/trecut/eraser/_handlers/output.ts',")
    body = body.replace("requireText('api/v1/trecut/eraser/upload-target.ts',", "requireText('api/v1/trecut/eraser/_handlers/upload-target.ts',")
    eraser_contract.write_text(body, encoding="utf-8")


if __name__ == "__main__":
    move_handlers()
    write_dispatchers()
    update_contracts()
    script = ROOT / "scripts/consolidate-vercel-functions.py"
    if script.exists():
        script.unlink()
    print("Consolidated grouped API routes into 12 Vercel functions.")
