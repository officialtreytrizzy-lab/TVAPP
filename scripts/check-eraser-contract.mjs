import { readFileSync, existsSync } from 'node:fs';

const requiredFiles = [
  'src/lib/eraser/gpu.ts',
  'src/components/eraser/Editor.tsx',
  'src/components/eraser/ProcessingPanel.tsx',
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

// Frontend must keep the GPU bridge and fallback split.
requireText('src/lib/eraser/gpu.ts', 'VITE_ERASER_GPU_WORKER_URL', 'frontend must read the deployed worker URL from Vercel env');
requireText('src/lib/eraser/gpu.ts', 'return raw ? absoluteUrl(raw) :', 'relative Modal output URLs must be normalized before playback');
requireText('src/lib/eraser/gpu.ts', "form.append('video'", 'original video must be uploaded to the worker');
requireText('src/lib/eraser/gpu.ts', "form.append('mask'", 'mask PNG must be uploaded to the worker');
requireText('src/lib/eraser/gpu.ts', "form.append('selected_frame_index'", 'selected frame must be passed to the worker');
requireText('src/components/eraser/Editor.tsx', 'runGpuRemoval', 'editor must call GPU worker when configured');
requireText('src/components/eraser/Editor.tsx', 'isGpuRemovalConfigured()', 'editor must choose GPU vs browser fallback explicitly');
requireText('src/components/eraser/ProcessingPanel.tsx', 'Mode: {processingMode}', 'UI must show whether GPU or browser fallback is active');

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

// ProPainter static-mask pipeline invariants.
requireText('gpu-worker/pipelines/sam2_propainter.py', 'PROPAINTER_ROOT', 'pipeline must locate the ProPainter installation');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'inference_propainter.py', 'pipeline must call ProPainter inference, not the old smoke test');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'prepare_static_mask', 'static logo/watermark removal path must remain available');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'mask_dilation', 'mask dilation must be controlled by ProPainter call');
requireText('gpu-worker/pipelines/sam2_propainter.py', 'mux_audio', 'final output must preserve original audio when possible');
forbidText('gpu-worker/pipelines/sam2_propainter.py', 'Smoke-test pipeline', 'do not regress to unchanged-video smoke test');

requireText('gpu-worker/requirements.txt', 'opencv-python-headless', 'mask preparation uses OpenCV');
requireText('gpu-worker/requirements.txt', 'numpy', 'mask preparation uses NumPy');

if (checks.length) {
  console.error('\nEraser contract check failed:\n');
  for (const check of checks) console.error(`- ${check}`);
  process.exit(1);
}

console.log('Eraser contract check passed. GPU worker, Modal settings, ProPainter path, and frontend bridge are intact.');
