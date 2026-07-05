import { readFileSync, existsSync } from 'node:fs';

const requiredFiles = [
  'src/lib/eraser/gpu.ts',
  'src/components/eraser/Editor.tsx',
  'src/components/eraser/ProcessingPanel.tsx',
  'api/_lib/trecut-eraser-proxy.ts',
  'api/v1/trecut/eraser/jobs.ts',
  'api/v1/trecut/eraser/jobs/[jobId].ts',
  'api/v1/trecut/eraser/jobs/[jobId]/output.ts',
  'gpu-worker/modal_app.py',
  'gpu-worker/main.py',
  'gpu-worker/pipelines/sam2_propainter.py',
  'gpu-worker/requirements.txt',
];

const checks = [];

function file(path) {
  if (!existsSync(path)) throw new Error(`Missing required file: ${path}`);
  return readFileSync(path, 'utf8');
}

function requireText(path, text, reason) {
  const body = file(path);
  if (!body.includes(text)) {
    checks.push(`FAIL ${path}: missing ${JSON.stringify(text)} — ${reason}`);
  }
}

function forbidText(path, text, reason) {
  const body = file(path);
  if (body.includes(text)) {
    checks.push(`FAIL ${path}: forbidden ${JSON.stringify(text)} — ${reason}`);
  }
}

for (const path of requiredFiles) file(path);

// Frontend must use the server-side proxy by default so the generated API key is never exposed in browser code.
requireText('src/lib/eraser/gpu.ts', 'VITE_TRECUT_ERASER_PROXY_URL', 'frontend must read the local proxy path from Vercel env');
requireText('src/lib/eraser/gpu.ts', "'/api/v1/trecut/eraser'", 'frontend must default to the local Trecut eraser proxy');
requireText('src/lib/eraser/gpu.ts', 'USE_ERASER_API_PROXY', 'frontend must prefer the secure API proxy path');
requireText('src/lib/eraser/gpu.ts', 'source_video_base64', 'frontend proxy payload must send source video data to the API proxy');
requireText('src/lib/eraser/gpu.ts', 'mask_base64', 'frontend proxy payload must send the mask PNG data to the API proxy');
requireText('src/lib/eraser/gpu.ts', 'selected_frame_index', 'selected frame must be included in metadata');
requireText('src/lib/eraser/gpu.ts', 'preserve_resolution: true', 'frontend must request source-resolution restoration');
requireText('src/lib/eraser/gpu.ts', 'preserve_fps: true', 'frontend must request source-FPS restoration');
requireText('src/lib/eraser/gpu.ts', 'preserve_audio: true', 'frontend must request audio preservation');
requireText('src/lib/eraser/gpu.ts', "form.append('video'", 'direct worker fallback must still upload original video when explicitly enabled');
requireText('src/lib/eraser/gpu.ts', "form.append('mask'", 'direct worker fallback must still upload mask PNG when explicitly enabled');
forbidText('src/lib/eraser/gpu.ts', 'VITE_ERASER_GPU_API_KEY', 'the generated eTreyser API key must not be exposed through Vite/browser env');

// Proxy must hold and apply the generated bearer token server-side only.
requireText('api/_lib/trecut-eraser-proxy.ts', 'TRECUT_ETREYSER_API_KEY', 'server proxy must read the generated eTreyser API key from server env');
requireText('api/_lib/trecut-eraser-proxy.ts', 'Authorization', 'server proxy must attach the bearer token to licensed API calls');
requireText('api/_lib/trecut-eraser-proxy.ts', 'rewriteVideoRemovalJobPayload', 'server proxy must rewrite protected API URLs back to proxy URLs');
requireText('api/v1/trecut/eraser/jobs.ts', "fetchTreyVideoRemovalApi(req, '/jobs'", 'Trecut create endpoint must call licensed video-removal jobs API');
requireText('api/v1/trecut/eraser/jobs/[jobId].ts', "fetchTreyVideoRemovalApi(req, `/jobs/${encodeURIComponent(jobId)}`", 'Trecut status endpoint must proxy licensed job reads');
requireText('api/v1/trecut/eraser/jobs/[jobId]/output.ts', "fetchTreyVideoRemovalApi(req, `/jobs/${encodeURIComponent(jobId)}/output`", 'Trecut output endpoint must stream licensed job output');

requireText('src/components/eraser/Editor.tsx', 'runGpuRemoval', 'editor must call the AI removal bridge when configured');
requireText('src/components/eraser/Editor.tsx', 'isGpuRemovalConfigured()', 'editor must choose AI proxy/worker vs browser fallback explicitly');
requireText('src/components/eraser/Editor.tsx', 'outputQuality', 'editor must keep the source/higher quality setting wired');
requireText('src/components/eraser/ProcessingPanel.tsx', 'Mode: {processingMode}', 'UI must show whether proxy/GPU or browser fallback is active');
requireText('src/components/eraser/ProcessingPanel.tsx', 'Same quality', 'UI must expose source-quality output');
requireText('src/components/eraser/ProcessingPanel.tsx', 'Higher quality', 'UI must expose higher-quality output');

// Modal worker must stay pinned to one active GPU container until a durable store replaces memory state.
requireText('gpu-worker/modal_app.py', 'git clone --depth 1 https://github.com/sczhou/ProPainter.git /opt/ProPainter', 'Modal image must install ProPainter');
requireText('gpu-worker/modal_app.py', 'gpu="A10G"', 'worker must request a real GPU');
requireText('gpu-worker/modal_app.py', 'max_containers=1', 'status polling depends on single-container state until durable storage is added');
requireText('gpu-worker/modal_app.py', '@modal.concurrent(max_inputs=1)', 'ProPainter jobs must not run concurrently in one container');
requireText('gpu-worker/modal_app.py', 'timeout=60 * 45', 'ProPainter jobs need enough time for video inpainting');

// Worker command and API contract.
requireText('gpu-worker/main.py', 'python /app/pipelines/sam2_propainter.py', 'worker must default to the checked-in pipeline script');
requireText('gpu-worker/main.py', '@app.post("/v1/video-eraser/jobs")', 'frontend depends on this create-job endpoint');
requireText('gpu-worker/main.py', '@app.get("/v1/video-eraser/jobs/{job_id}")', 'frontend polling depends on this status endpoint');
requireText('gpu-worker/main.py', '@app.get("/v1/video-eraser/jobs/{job_id}/output")', 'frontend output playback depends on this endpoint');
requireText('gpu-worker/main.py', 'ERASER_OUTPUT_QUALITY', 'worker must pass source/higher quality through to the pipeline');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_RESOLUTION', 'worker must pass source-resolution preservation through to the pipeline');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_FPS', 'worker must pass source-FPS preservation through to the pipeline');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_AUDIO', 'worker must pass audio preservation through to the pipeline');

// ProPainter static-mask pipeline invariants.
requireText('gpu-worker/pipelines/sam2_propainter.py', 'PROPAINTER_ROOT', 'pipeline must locate the ProPainter installation');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'inference_propainter.py', 'pipeline must call ProPainter inference, not the old smoke test');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'prepare_static_mask', 'static logo/watermark removal path must remain available');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'mask_dilation', 'mask dilation must be controlled by ProPainter call');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'mux_audio', 'final output must preserve original audio when possible');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'scale={out_w}:{out_h}:flags=lanczos', 'final output must be restored to source dimensions');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'fps={fps:.6f}', 'final output must be restored to source frame rate');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'ERASER_OUTPUT_QUALITY', 'pipeline must honor source/higher output quality');
forbidText('gpu-worker/pipelines/sam2_propainter.py', 'Smoke-test pipeline', 'do not regress to unchanged-video smoke test');

requireText('gpu-worker/requirements.txt', 'opencv-python-headless', 'mask preparation uses OpenCV');
requireText('gpu-worker/requirements.txt', 'numpy', 'mask preparation uses NumPy');

if (checks.length) {
  console.error('\nEraser contract check failed:\n');
  for (const check of checks) console.error(`- ${check}`);
  process.exit(1);
}

console.log('Eraser contract check passed. Trecut proxy, server-side eTreyser API key handling, GPU worker, quality controls, and frontend bridge are intact.');
