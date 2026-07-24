import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'src/lib/eraser/gpu.ts',
  'src/lib/eraser/pipeline.ts',
  'src/lib/eraser/api.ts',
  'src/components/AppLayout.tsx',
  'src/components/eraser/Editor.tsx',
  'src/components/eraser/ProcessingPanel.tsx',
  'api/_lib/trecut-eraser-proxy.ts',
  'api/_lib/modal.ts',
  'api/v1/direct-upload.ts',
  'api/v1/trecut/eraser/[...path].ts',
  'api/v1/trecut/eraser/_handlers/jobs.ts',
  'api/v1/trecut/eraser/_handlers/job.ts',
  'api/v1/trecut/eraser/_handlers/output.ts',
  'api/v1/trecut/eraser/_handlers/upload-target.ts',
  'gpu-worker/modal_app.py',
  'gpu-worker/main.py',
  'gpu-worker/pipelines/optical_flow_vace_inpaint.py',
  'gpu-worker/pipelines/sam2_refinement.py',
  'gpu-worker/requirements.txt',
  'scripts/verify_optical_flow_vace_pipeline.py',
  'vercel.json',
];

const failures = [];

function file(path) {
  if (!existsSync(path)) throw new Error(`Missing required file: ${path}`);
  return readFileSync(path, 'utf8');
}

function requireText(path, text, reason) {
  if (!file(path).includes(text)) {
    failures.push(`FAIL ${path}: missing ${JSON.stringify(text)} - ${reason}`);
  }
}

function forbidText(path, text, reason) {
  if (file(path).includes(text)) {
    failures.push(`FAIL ${path}: forbidden ${JSON.stringify(text)} - ${reason}`);
  }
}

for (const path of requiredFiles) file(path);

// Secure browser-to-worker bridge.
requireText('src/lib/eraser/gpu.ts', 'VITE_TRECUT_ERASER_PROXY_URL', 'frontend must support the server-side proxy');
requireText('src/lib/eraser/gpu.ts', "'/api/v1/trecut/eraser'", 'frontend must default to the local eraser proxy');
requireText('src/lib/eraser/gpu.ts', 'USE_ERASER_API_PROXY', 'frontend must prefer the secure proxy path');
requireText('src/lib/eraser/gpu.ts', 'source_video_base64', 'proxy fallback must include source video bytes');
requireText('src/lib/eraser/gpu.ts', 'mask_base64', 'proxy fallback must include painted mask bytes');
requireText('src/lib/eraser/gpu.ts', 'selected_frame_index', 'the exact painted frame must reach the worker');
requireText('src/lib/eraser/gpu.ts', 'preserve_resolution: true', 'source resolution must be requested');
requireText('src/lib/eraser/gpu.ts', 'preserve_fps: true', 'source FPS must be requested');
requireText('src/lib/eraser/gpu.ts', 'preserve_audio: true', 'original audio must be requested');
requireText('src/lib/eraser/gpu.ts', "form.append('pipeline', 'sam2-propainter')", 'frontend must request the exact production pipeline');
forbidText('src/lib/eraser/gpu.ts', 'VITE_ERASER_GPU_API_KEY', 'server credentials must never enter browser code');
forbidText('src/lib/eraser/gpu.ts', "'optical-flow-vace-diffusion'", 'frontend must not request the retired Wan VACE eraser path');
requireText('src/lib/eraser/gpu.ts', "raw.includes('frame_extraction')", 'frontend must preserve the frame-extraction phase');
requireText('src/lib/eraser/gpu.ts', "raw.includes('sam2_tracking')", 'frontend must preserve the SAM2 tracking phase');
requireText('src/lib/eraser/gpu.ts', "raw.includes('propainter_inpainting')", 'frontend must preserve the ProPainter phase');
requireText('src/lib/eraser/gpu.ts', "raw.includes('audio_preserving_export')", 'frontend must preserve the export phase');
requireText('src/components/eraser/ProcessingPanel.tsx', "frame_extraction: 'Frame extraction'", 'progress UI must name stage 1');
requireText('src/components/eraser/ProcessingPanel.tsx', "sam2_tracking: 'SAM2 tracking'", 'progress UI must name SAM2 tracking');
requireText('src/components/eraser/ProcessingPanel.tsx', "propainter_inpainting: 'ProPainter inpainting'", 'progress UI must name ProPainter inpainting');
requireText('src/components/eraser/ProcessingPanel.tsx', "audio_preserving_export: 'Audio-preserving export'", 'progress UI must name stage 4');
requireText('src/components/eraser/Editor.tsx', 'const out: PipelineOutput = await runGpuRemoval', 'editor must execute the GPU pipeline directly');
forbidText('src/components/eraser/Editor.tsx', 'runBrowserFallback', 'production must not silently switch to another algorithm');
forbidText('src/components/eraser/Editor.tsx', 'runPipeline({', 'production must not execute browser fallback processing');


// Device-authenticated three-job recent library.
requireText('src/lib/eraser/api.ts', "DEVICE_CREDENTIAL_KEY = 'etreyser.device.credential.v1'", 'the device must possess a stable private library credential');
requireText('src/lib/eraser/api.ts', 'MAX_RECENT_COMPLETED_JOBS = 3', 'the device library must retain exactly three completed jobs');
requireText('src/lib/eraser/api.ts', 'device_id: currentDeviceId()', 'new eraser jobs must be scoped to the current device');
requireText('src/lib/eraser/api.ts', 'navigator.storage.persist()', 'the browser should request durable device storage when available');
requireText('src/lib/eraser/pipeline.ts', 'outputBlob?: Blob', 'the downloaded GPU result must remain available for durable device storage');
requireText('src/lib/eraser/gpu.ts', 'makePipelineOutput(URL.createObjectURL(blob), input, blob)', 'the first completed-video download must be reused instead of downloaded twice');
requireText('src/components/eraser/Editor.tsx', 'let outputBlob = out.outputBlob', 'the editor must persist the GPU result Blob without a redundant full-video fetch');
requireText('src/lib/eraser/api.ts', 'await requestPersistentDeviceStorage();', 'durable storage must be requested before writing the completed output');
requireText('src/lib/eraser/api.ts', 'pruneCompletedJobsForCurrentDevice', 'saving a fourth completed job must evict the oldest');
requireText('src/lib/eraser/api.ts', 'deleteOutput(job.final_output_key)', 'eviction must remove the saved IndexedDB video, not only metadata');
requireText('src/lib/eraser/api.ts', 'listRecentCompletedJobs', 'the library must expose only recent completed jobs');
requireText('src/components/eraser/Editor.tsx', 'eraserApi.uploadOutput(jobId, outputBlob, out.mimeType)', 'GPU outputs must be persisted to the device library');
requireText('src/components/eraser/Editor.tsx', 'await eraserApi.complete({', 'GPU completion must finalize local device metadata');
requireText('src/components/AppLayout.tsx', 'Recent eraser jobs', 'the user interface must expose the recent completed-job library');
requireText('src/components/AppLayout.tsx', 'Unlocked by this device', 'the library must explain its possession-based device access');
requireText('src/components/AppLayout.tsx', 'eraserApi.listRecentCompletedJobs()', 'the drawer must not show failed or unfinished jobs');

requireText('api/_lib/modal.ts', "'sam2-propainter'", 'licensed API calls must use the exact production pipeline');
requireText('api/_lib/trecut-eraser-proxy.ts', 'TRECUT_ETREYSER_API_KEY', 'proxy must read the API key server-side');
requireText('api/_lib/trecut-eraser-proxy.ts', 'Authorization', 'proxy must attach bearer authorization');
requireText('api/_lib/trecut-eraser-proxy.ts', 'rewriteVideoRemovalJobPayload', 'worker URLs must be rewritten through the proxy');
requireText('api/v1/trecut/eraser/_handlers/jobs.ts', 'submitRemovalToModal', 'create endpoint must submit to the first-party worker');
requireText('api/v1/trecut/eraser/_handlers/job.ts', 'readModalStatus', 'status endpoint must read worker state');
requireText('api/v1/trecut/eraser/_handlers/output.ts', 'modalCompositeOutputFromPayload', 'output endpoint must stream the final composite');
requireText('src/lib/eraser/gpu.ts', 'upload-target', 'large files must upload directly to the GPU worker');
requireText('src/lib/eraser/gpu.ts', 'runChunkedWorkerUpload', 'mobile uploads must use retryable chunks');
requireText('src/lib/eraser/gpu.ts', 'X-Chunk-SHA256', 'each upload chunk must be checksummed');
requireText('gpu-worker/main.py', '/v1/video-eraser/uploads/{upload_id}/chunks/{chunk_index}', 'worker must accept numbered upload chunks');
requireText('gpu-worker/main.py', 'Chunked upload verified; queued SAM2 + ProPainter removal', 'worker must verify the assembled upload before processing');
requireText('api/v1/trecut/eraser/_handlers/upload-target.ts', 'chunked_upload_url', 'first-party discovery must expose chunked upload');
requireText('api/v1/direct-upload.ts', 'chunked_upload_url', 'licensed discovery must expose chunked upload');
requireText('src/lib/eraser/gpu.ts', 'MAX_PROXY_JSON_BYTES', 'legacy base64 relay must remain size guarded');

// Modal production routing and GPU constraints.
requireText('vercel.json', 'https://officialtreytrizzy-lab--tvapp-video-eraser-gpu-fastapi-app.modal.run', 'Vercel must target the OfficialTreyTrizzy-lab Modal worker');
forbidText('vercel.json', 'wthemif--tvapp-video-eraser-gpu', 'production must not route to the previous Modal workspace');
forbidText('api/v1/direct-upload.ts', '.modal.run', 'direct upload discovery must not hide a hardcoded worker fallback');
forbidText('api/v1/trecut/eraser/_handlers/upload-target.ts', '.modal.run', 'upload discovery must not hide a hardcoded worker fallback');
forbidText('vercel.json', 'californiatrey--tvapp-video-eraser-gpu', 'production must not route to the retired Modal account');
requireText('gpu-worker/modal_app.py', 'gpu="A10G"', 'diffusion inpainting requires a real GPU');
requireText('gpu-worker/modal_app.py', 'max_containers=1', 'in-memory status requires one active worker container');
requireText('gpu-worker/modal_app.py', '@modal.concurrent(max_inputs=1)', 'one diffusion render may run per GPU container');
requireText('gpu-worker/modal_app.py', 'timeout=60 * 45', 'diffusion jobs need a long worker timeout');
requireText('gpu-worker/modal_app.py', 'python /app/pipelines/sam2_propainter_verified.py', 'Modal must execute the verified SAM2 + ProPainter pipeline');
requireText('gpu-worker/modal_app.py', 'flash_attn-2.7.4.post1+cu12torch2.5cxx11abiFALSE-cp311-cp311-linux_x86_64.whl', 'Modal image must include the verified Flash Attention CUDA wheel');
requireText('gpu-worker/modal_app.py', 'pip install einops==0.8.1', 'Wan VACE must receive its explicit tensor-rearrangement dependency');
requireText('gpu-worker/modal_app.py', 'import flash_attn', 'worker startup must verify Flash Attention imports');
requireText('gpu-worker/modal_app.py', '/opt/ProPainter', 'production image must install ProPainter');
requireText('gpu-worker/modal_app.py', '/opt/sam2_checkpoints/sam2.1_hiera_small.pt', 'production image must include SAM2-small for video tracking');
forbidText('gpu-worker/modal_app.py', 'ERASER_PIPELINE_CMD"] = "python /app/pipelines/optical_flow_vace_inpaint.py', 'Modal must not route erasing through Wan VACE');

// Worker status must expose the real four stages, not cosmetic labels.
requireText('gpu-worker/main.py', 'python /app/pipelines/sam2_propainter_verified.py', 'worker default must be the verified SAM2 + ProPainter pipeline');
requireText('gpu-worker/main.py', 'PIPELINE_STAGE:', 'worker must parse pipeline-emitted stage events');
requireText('gpu-worker/main.py', 'frame_extraction', 'job status must begin with frame extraction');
requireText('gpu-worker/main.py', 'SAM2 + ProPainter removal complete', 'completion status must identify the real path');
requireText('gpu-worker/main.py', 'sam2-propainter', 'job endpoint must default to the exact pipeline ID');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_RESOLUTION', 'worker must pass source-resolution preservation');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_FPS', 'worker must pass source-FPS preservation');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_AUDIO', 'worker must pass audio preservation');

const pipeline = 'gpu-worker/pipelines/sam2_propainter.py';
const resilientPipeline = 'gpu-worker/pipelines/sam2_propainter_resilient.py';
const verifiedPipeline = 'gpu-worker/pipelines/sam2_propainter_verified.py';
requireText(pipeline, 'def build_tracked_masks(', 'SAM2 tracking must cover the full clip');
requireText(pipeline, 'def run_propainter(', 'the production eraser must execute ProPainter');
requireText(pipeline, 'inference_propainter.py', 'the eraser must call ProPainter inference');
requireText(pipeline, 'ERASER_PROPAINTER_CHUNK_FRAMES', 'long clips must use bounded temporal chunks');
requireText(pipeline, 'def concatenate_propainter_chunks(', 'temporal chunks must be joined into one output');
requireText(pipeline, 'def composite_inpainted_region(', 'only repaired regions may replace source pixels');
requireText(pipeline, 'def mux_audio(', 'the final export must restore source audio');
requireText(pipeline, '"1:a?"', 'audio export must map original audio when present');
requireText(resilientPipeline, 'validate_video_liveness', 'the resilient layer must reject frozen or invalid renders');
requireText(verifiedPipeline, 'validate_selection_changed', 'the exact painted selection must be verified');
requireText(verifiedPipeline, 'validate_patch_quality', 'visible repair patches must fail the quality gate');
requireText(verifiedPipeline, 'emit_stage("sam2_tracking"', 'SAM2 tracking progress must be machine-readable');
requireText(verifiedPipeline, 'emit_stage("propainter_inpainting"', 'ProPainter progress must be machine-readable');
requireText(verifiedPipeline, 'emit_stage("audio_preserving_export"', 'audio export progress must be machine-readable');
requireText('gpu-worker/requirements.txt', 'opencv-python-headless', 'frame and mask processing require OpenCV');
requireText('gpu-worker/requirements.txt', 'numpy', 'mask processing requires NumPy');


if (failures.length) {
  console.error('\nEraser contract check failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Eraser contract check passed. SAM2 tracking, ProPainter temporal inpainting, source-preserving compositing, validation, and audio-preserving export are locked as the production path.');
