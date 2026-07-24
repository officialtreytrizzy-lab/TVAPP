import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'src/lib/eraser/gpu.ts',
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
requireText('src/lib/eraser/gpu.ts', "form.append('pipeline', 'sam2-propainter')", 'frontend must request the SAM2 + ProPainter production pipeline');
forbidText('src/lib/eraser/gpu.ts', 'VITE_ERASER_GPU_API_KEY', 'server credentials must never enter browser code');
forbidText('src/lib/eraser/gpu.ts', "'optical-flow-vace-diffusion'", 'frontend must not request the generative VACE eraser path');
requireText('src/lib/eraser/gpu.ts', "raw.includes('frame_extraction')", 'frontend must preserve the frame-extraction phase');
requireText('src/lib/eraser/gpu.ts', "raw.includes('optical_flow_tracking')", 'frontend must preserve the optical-flow phase');
requireText('src/lib/eraser/gpu.ts', "raw.includes('diffusion_inpainting')", 'frontend must preserve the diffusion phase');
requireText('src/lib/eraser/gpu.ts', "raw.includes('audio_preserving_export')", 'frontend must preserve the export phase');
requireText('src/components/eraser/ProcessingPanel.tsx', "frame_extraction: 'Frame extraction'", 'progress UI must name stage 1');
requireText('src/components/eraser/ProcessingPanel.tsx', "optical_flow_tracking: 'Optical-flow tracking'", 'progress UI must name stage 2');
requireText('src/components/eraser/ProcessingPanel.tsx', "diffusion_inpainting: 'Diffusion inpainting'", 'progress UI must name stage 3');
requireText('src/components/eraser/ProcessingPanel.tsx', "audio_preserving_export: 'Audio-preserving export'", 'progress UI must name stage 4');
requireText('src/components/eraser/Editor.tsx', 'const out: PipelineOutput = await runGpuRemoval', 'editor must execute the GPU pipeline directly');
forbidText('src/components/eraser/Editor.tsx', 'runBrowserFallback', 'production must not silently switch to another algorithm');
forbidText('src/components/eraser/Editor.tsx', 'runPipeline({', 'production must not execute browser fallback processing');


// Device-authenticated three-job recent library.
requireText('src/lib/eraser/api.ts', "DEVICE_CREDENTIAL_KEY = 'etreyser.device.credential.v1'", 'the device must possess a stable private library credential');
requireText('src/lib/eraser/api.ts', 'MAX_RECENT_COMPLETED_JOBS = 3', 'the device library must retain exactly three completed jobs');
requireText('src/lib/eraser/api.ts', 'device_id: currentDeviceId()', 'new eraser jobs must be scoped to the current device');
requireText('src/lib/eraser/api.ts', 'navigator.storage.persist()', 'the browser should request durable device storage when available');
requireText('src/lib/eraser/api.ts', 'pruneCompletedJobsForCurrentDevice', 'saving a fourth completed job must evict the oldest');
requireText('src/lib/eraser/api.ts', 'deleteOutput(job.final_output_key)', 'eviction must remove the saved IndexedDB video, not only metadata');
requireText('src/lib/eraser/api.ts', 'listRecentCompletedJobs', 'the library must expose only recent completed jobs');
requireText('src/components/eraser/Editor.tsx', 'eraserApi.uploadOutput(jobId, outputBlob, out.mimeType)', 'GPU outputs must be persisted to the device library');
requireText('src/components/eraser/Editor.tsx', 'await eraserApi.complete({', 'GPU completion must finalize local device metadata');
requireText('src/components/AppLayout.tsx', 'Recent eraser jobs', 'the user interface must expose the recent completed-job library');
requireText('src/components/AppLayout.tsx', 'Unlocked by this device', 'the library must explain its possession-based device access');
requireText('src/components/AppLayout.tsx', 'eraserApi.listRecentCompletedJobs()', 'the drawer must not show failed or unfinished jobs');

requireText('api/_lib/modal.ts', "'sam2-propainter'", 'licensed API calls must use the SAM2 + ProPainter production pipeline');
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
requireText('vercel.json', 'https://wthemif--tvapp-video-eraser-gpu-fastapi-app.modal.run', 'Vercel must target the wthemif Modal worker');
requireText('api/v1/direct-upload.ts', 'modalBaseUrl()', 'direct uploads must use configured worker URL only');
requireText('api/v1/direct-upload.ts', 'worker_not_configured', 'direct uploads must fail clearly when worker URL is missing');
requireText('api/v1/trecut/eraser/_handlers/upload-target.ts', 'modalBaseUrl()', 'upload discovery must use configured worker URL only');
requireText('api/v1/trecut/eraser/_handlers/upload-target.ts', 'worker_not_configured', 'upload discovery must fail clearly when worker URL is missing');
forbidText('api/v1/direct-upload.ts', 'modal.run', 'direct uploads must not silently fall back to a hardcoded worker');
forbidText('api/v1/trecut/eraser/_handlers/upload-target.ts', 'modal.run', 'upload discovery must not silently fall back to a hardcoded worker');
forbidText('vercel.json', 'californiatrey--tvapp-video-eraser-gpu', 'production must not route to the retired Modal account');
requireText('gpu-worker/modal_app.py', 'gpu="A10G"', 'ProPainter inpainting requires a real GPU');
requireText('gpu-worker/modal_app.py', 'max_containers=1', 'in-memory status requires one active worker container');
requireText('gpu-worker/modal_app.py', '@modal.concurrent(max_inputs=1)', 'one ProPainter render may run per GPU container');
requireText('gpu-worker/modal_app.py', 'timeout=60 * 45', 'ProPainter jobs need a long worker timeout');
requireText('gpu-worker/modal_app.py', 'python /app/pipelines/sam2_propainter.py', 'Modal must execute the SAM2 + ProPainter eraser pipeline');
requireText('gpu-worker/modal_app.py', '/opt/ProPainter', 'production image must install ProPainter');
requireText('gpu-worker/modal_app.py', 'flash_attn-2.7.4.post1+cu12torch2.5cxx11abiFALSE-cp311-cp311-linux_x86_64.whl', 'Modal image must include the verified Flash Attention CUDA wheel');
requireText('gpu-worker/modal_app.py', 'pip install einops==0.8.1', 'Wan VACE must receive its explicit tensor-rearrangement dependency');
requireText('gpu-worker/modal_app.py', 'import flash_attn', 'worker startup must verify Flash Attention imports');
requireText('gpu-worker/modal_app.py', '/opt/sam2_checkpoints/sam2.1_hiera_tiny.pt', 'production image must include SAM2-tiny for constrained matte refinement');
forbidText('gpu-worker/modal_app.py', 'python /app/pipelines/sam2_propainter_verified.py', 'Modal must not execute the retired production entrypoint');

// Worker status must expose the real ProPainter path, not the generative VACE eraser.
requireText('gpu-worker/main.py', 'python /app/pipelines/sam2_propainter.py', 'worker default must be the SAM2 + ProPainter pipeline');
requireText('gpu-worker/main.py', 'PIPELINE_STAGE:', 'worker must parse pipeline-emitted stage events');
requireText('gpu-worker/main.py', 'frame_extraction', 'job status must begin with frame extraction');
requireText('gpu-worker/main.py', 'SAM2 + ProPainter removal complete', 'completion status must identify the real path');
requireText('gpu-worker/main.py', 'sam2-propainter', 'job endpoint must default to the exact pipeline ID');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_RESOLUTION', 'worker must pass source-resolution preservation');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_FPS', 'worker must pass source-FPS preservation');
requireText('gpu-worker/main.py', 'ERASER_PRESERVE_AUDIO', 'worker must pass audio preservation');

const pipeline = 'gpu-worker/pipelines/optical_flow_vace_inpaint.py';
requireText(pipeline, 'def extract_frames(', 'stage 1 must perform actual frame extraction');
requireText(pipeline, 'cv2.calcOpticalFlowFarneback', 'stage 2 must use dense optical flow');
requireText(pipeline, 'cv2.calcOpticalFlowPyrLK', 'stage 2 must include sparse optical-flow recovery');
requireText(pipeline, 'def track_masks_with_optical_flow(', 'tracked masks must be written for the full clip');
requireText(pipeline, 'def is_scene_cut(', 'tracking must recognize shot changes');
requireText(pipeline, 'def reacquire_from_anchor(', 'tracking must recover after scene cuts when possible');
requireText(pipeline, 'def build_vace_mask_video(', 'tracked masks must be converted into a temporal diffusion condition');
requireText(pipeline, 'semantics=white_generate_black_preserve', 'VACE mask semantics must be explicit');
requireText(pipeline, 'def build_vace_condition_video(', 'white mask regions must be neutralized in the diffusion condition video');
requireText(pipeline, 'condition_mode = \"structural_prior\"', 'production diffusion must support the high-resolution structural prior');
requireText(pipeline, 'preserve_generated_prior=True', 'the production path must feed the structural prior into diffusion');
requireText(pipeline, '"--task"', 'stage 3 must invoke a named Wan task');
requireText(pipeline, '"vace-1.3B"', 'stage 3 must execute Wan VACE diffusion');
requireText(pipeline, '"--src_video"', 'diffusion must receive the source video');
requireText(pipeline, '"--src_mask"', 'diffusion must receive the tracked temporal mask');
requireText(pipeline, 'def run_diffusion_inpainting(', 'long clips must be processed as overlapping diffusion chunks');
requireText(pipeline, 'def fixed_repair_roi(', 'compact fixed marks must render through a higher-resolution context crop');
requireText(pipeline, 'def crop_source_for_fixed_roi(', 'fixed-mark source video must be cropped losslessly before diffusion');
requireText(pipeline, 'def crop_masks_for_fixed_roi(', 'tracked masks must map exactly into the fixed repair ROI');
requireText(pipeline, 'def source_preserving_composite(', 'only repaired mask pixels may replace source pixels');
requireText(pipeline, 'def harmonize_composite_frame(', 'final patches must receive adaptive color and texture harmonization');
requireText(pipeline, 'def structural_prior_frame(', 'a full-resolution deterministic prior must protect diffusion from hallucinated fills');
requireText(pipeline, 'def build_structural_prior_video(', 'the structural prior must cover the complete timeline');
requireText(pipeline, 'def quality_gated_composite_frame(', 'diffusion must compete against the structural prior before export');
requireText(pipeline, 'diffusion_score + required_margin < prior_score', 'diffusion may replace the prior only after a material quality win');
requireText(pipeline, 'def nearest_background_texture(', 'missing patch grain must be sampled from real nearby source texture');
requireText(pipeline, 'def transfer_local_texture(', 'smooth diffusion repairs must receive only the missing local texture energy');
requireText(pipeline, 'patch_mask = binary[crop_y1:crop_y2, crop_x1:crop_x2].copy()', 'gradient cloning must never mutate the authoritative matte');
requireText(pipeline, 'composite_masks,', 'final validation must inspect the refined composite matte');
requireText(pipeline, 'cv2.seamlessClone', 'patch boundaries must use gradient-domain blending');
requireText(pipeline, 'cv2.VideoWriter_fourcc(*\"FFV1\")', 'the intermediate composite must remain lossless');
requireText('gpu-worker/pipelines/sam2_refinement.py', 'def fuse_semantic_mask(', 'SAM2 output must be constrained to the optical-flow envelope');
requireText('gpu-worker/pipelines/sam2_refinement.py', 'not fixed_screen_position', 'SAM2 must not alter moving-object tracking');
requireText(pipeline, 'def mux_original_audio(', 'stage 4 must restore the original soundtrack');
requireText(pipeline, '"1:a?"', 'audio export must map original audio when present');
requireText(pipeline, 'Original audio stream copied without re-encoding', 'compatible source audio must be stream-copied');
requireText(pipeline, 'Original audio packet hash preserved', 'copied audio must be validated bit-for-bit');
requireText(pipeline, 'def validate_output(', 'final dimensions, frames, audio and selected-region change must be verified');
requireText(pipeline, 'emit_stage("frame_extraction"', 'stage order must be machine-readable');
requireText(pipeline, 'emit_stage("optical_flow_tracking"', 'optical-flow stage must be machine-readable');
requireText(pipeline, 'emit_stage("diffusion_inpainting"', 'diffusion stage must be machine-readable');
requireText(pipeline, '"audio_preserving_export"', 'export stage must be machine-readable');
requireText(pipeline, 'build_semantic_composite_masks', 'SAM2 may refine the composite matte without replacing optical-flow tracking');
forbidText(pipeline, 'ProPainter', 'the exact production pipeline must not execute ProPainter');
requireText(pipeline, 'cv2.inpaint(source_frame, binary, radius, cv2.INPAINT_NS)', 'the explicit structural prior must use full-resolution Navier-Stokes reconstruction');

requireText('scripts/verify_optical_flow_vace_pipeline.py', 'verify_moving_mask_tracking', 'regression test must cover moving optical-flow tracking');
requireText('scripts/verify_optical_flow_vace_pipeline.py', 'verify_fixed_screen_selection', 'regression test must cover fixed inset marks');
requireText('scripts/verify_optical_flow_vace_pipeline.py', 'verify_fixed_roi_geometry', 'regression test must prove fixed marks gain effective diffusion resolution');
requireText('scripts/verify_optical_flow_vace_pipeline.py', 'verify_vace_condition_mask', 'regression test must verify gray generated regions and retained black-mask pixels');
requireText('scripts/verify_optical_flow_vace_pipeline.py', 'verify_structural_prior_quality_gate', 'regression test must reject a visibly worse diffusion candidate');
requireText('scripts/verify_optical_flow_vace_pipeline.py', 'verify_full_pipeline_with_stubbed_diffusion', 'regression test must exercise the complete four-stage path and audio export');
requireText('scripts/verify_optical_flow_vace_pipeline.py', 'verify_vace_frame_contract', 'regression test must cover VACE frame-count constraints');
requireText('gpu-worker/requirements.txt', 'opencv-python-headless', 'frame extraction and optical flow require OpenCV');
requireText('gpu-worker/requirements.txt', 'numpy', 'mask and flow operations require NumPy');

if (failures.length) {
  console.error('\nEraser contract check failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Eraser contract check passed. SAM2 + ProPainter removal is locked as the production eraser path; Wan VACE remains available for AI Remix.');
