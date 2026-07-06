import type { PipelineOutput } from './pipeline';

export type EraserOutputQuality = 'source' | 'higher';

interface GpuRemovalInput {
  jobId: string;
  file: File;
  sourceUrl: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
  selectedTime: number;
  selectedFrameIndex: number;
  maskCanvas: HTMLCanvasElement;
  outputQuality?: EraserOutputQuality;
  cancelRef: { cancelled: boolean };
  onPhase?: (phase: string, progress: number, msg: string) => void;
}

interface WorkerJobResponse {
  id?: string;
  jobId?: string;
  job_id?: string;
  statusUrl?: string;
  status_url?: string;
  outputUrl?: string;
  output_url?: string;
  finalOutputUrl?: string;
  final_output_url?: string;
  previewUrl?: string;
  preview_url?: string;
  progress?: number;
  phase?: string;
  status?: string;
  statusMessage?: string;
  status_message?: string;
  error?: string;
  error_message?: string;
}

function envFlag(name: string, fallback = 'false'): boolean {
  return String(import.meta.env[name] ?? fallback).toLowerCase() === 'true';
}

// Server-side proxy is the production route. The real GPU/API token stays in
// Vercel server env, so old VITE_TRECUT_ERASER_USE_PROXY=false build values
// must not force the live app back into browser fallback.
const ALLOW_REMOTE_API = envFlag('VITE_ETREYSER_ALLOW_REMOTE_API');
const ALLOW_MODAL = envFlag('VITE_ETREYSER_ALLOW_MODAL');
const ALLOW_CLOUD_GPU = envFlag('VITE_ETREYSER_ALLOW_CLOUD_GPU');
const DIRECT_WORKER_ALLOWED = ALLOW_REMOTE_API || ALLOW_MODAL || ALLOW_CLOUD_GPU;
const RAW_DIRECT_WORKER_URL = String(import.meta.env.VITE_ERASER_GPU_WORKER_URL ?? '').replace(/\/$/, '');
const DIRECT_WORKER_URL = DIRECT_WORKER_ALLOWED ? RAW_DIRECT_WORKER_URL : '';
const ERASER_API_PROXY_URL = String(import.meta.env.VITE_TRECUT_ERASER_PROXY_URL ?? '/api/v1/trecut/eraser').replace(/\/$/, '');
const PROXY_EXPLICITLY_DISABLED = envFlag('VITE_TRECUT_ERASER_DISABLE_PROXY');
const USE_ERASER_API_PROXY = !PROXY_EXPLICITLY_DISABLED && ERASER_API_PROXY_URL.length > 0;
const POLL_MS = 1400;
const MAX_POLLS = 900; // about 21 minutes

export function isGpuRemovalConfigured(): boolean {
  return USE_ERASER_API_PROXY || DIRECT_WORKER_URL.length > 0;
}

export function gpuRemovalLabel(): string {
  if (USE_ERASER_API_PROXY && ERASER_API_PROXY_URL) return 'eTreyser GPU proxy';
  if (DIRECT_WORKER_URL) return 'GPU AI worker';
  return 'browser fallback';
}

export function gpuRemovalDiagnostics() {
  return {
    label: gpuRemovalLabel(),
    configured: isGpuRemovalConfigured(),
    proxyEnabled: USE_ERASER_API_PROXY,
    proxyUrl: ERASER_API_PROXY_URL,
    proxyExplicitlyDisabled: PROXY_EXPLICITLY_DISABLED,
    directWorkerEnabled: Boolean(DIRECT_WORKER_URL),
    directWorkerAllowed: DIRECT_WORKER_ALLOWED,
    directWorkerUrlConfigured: Boolean(RAW_DIRECT_WORKER_URL),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('Could not export mask PNG.'));
      else resolve(blob);
    }, 'image/png');
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not prepare upload for eTreyser API.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
}

function absoluteUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('blob:')) return pathOrUrl;
  return `${baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function getRemoteJobId(payload: WorkerJobResponse): string {
  return payload.jobId || payload.job_id || payload.id || '';
}

function getOutputUrl(payload: WorkerJobResponse, baseUrl: string): string {
  const raw = payload.outputUrl || payload.output_url || payload.finalOutputUrl || payload.final_output_url || payload.previewUrl || payload.preview_url || '';
  return raw ? absoluteUrl(baseUrl, raw) : '';
}

function getStatusUrl(payload: WorkerJobResponse, baseUrl: string, pathPrefix: string): string {
  const explicit = payload.statusUrl || payload.status_url;
  if (explicit) return absoluteUrl(baseUrl, explicit);
  const remoteJobId = getRemoteJobId(payload);
  if (!remoteJobId) return '';
  return `${baseUrl}${pathPrefix}/${encodeURIComponent(remoteJobId)}`;
}

function normalizePhase(payload: WorkerJobResponse): string {
  const raw = String(payload.phase || payload.status || '').toLowerCase();
  if (raw.includes('segment')) return 'segmenting';
  if (raw.includes('track') || raw.includes('mask')) return 'tracking_mask';
  if (raw.includes('paint') || raw.includes('fill')) return 'inpainting';
  if (raw.includes('export') || raw.includes('encode') || raw.includes('preview')) return 'generating_preview';
  if (raw.includes('complete') || raw.includes('done') || raw.includes('success')) return 'completed';
  if (raw.includes('fail') || raw.includes('error')) return 'failed';
  return raw || 'segmenting';
}

async function parseWorkerResponse(res: Response): Promise<WorkerJobResponse> {
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text || `GPU worker failed with HTTP ${res.status}.`;
    try {
      const payload = JSON.parse(text);
      message = payload?.error?.message || payload?.detail || payload?.error || message;
    } catch { /* keep raw message */ }
    throw new Error(message);
  }
  if (contentType.includes('application/json')) return (await res.json()) as WorkerJobResponse;
  if (contentType.startsWith('video/')) {
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    return { phase: 'completed', progress: 100, outputUrl: url };
  }
  const text = await res.text();
  try { return JSON.parse(text) as WorkerJobResponse; } catch { return { phase: 'completed', progress: 100, outputUrl: text }; }
}

async function fetchStatus(statusUrl: string): Promise<WorkerJobResponse> {
  const res = await fetch(statusUrl, { method: 'GET' });
  return parseWorkerResponse(res);
}

async function requestDirectWorkerCancel(remoteJobId: string): Promise<void> {
  if (!remoteJobId || !DIRECT_WORKER_URL) return;
  await fetch(`${DIRECT_WORKER_URL}/v1/video-eraser/jobs/${encodeURIComponent(remoteJobId)}/cancel`, {
    method: 'POST',
  }).catch(() => undefined);
}

function makePipelineOutput(outputUrl: string, input: GpuRemovalInput): PipelineOutput {
  return {
    finalUrl: outputUrl,
    localUrl: outputUrl,
    mimeType: 'video/mp4',
    hasAudio: true,
    outW: input.width,
    outH: input.height,
    effectiveFps: input.fps,
    frameCount: Math.round(input.duration * input.fps),
    procW: input.width,
    procH: input.height,
    lowConfidenceFrames: [],
    inpaintedFrames: [],
    originalFrames: [],
    timestamps: [],
    confidence: [],
  };
}

async function waitForRemovalOutput(options: {
  initialPayload: WorkerJobResponse;
  baseUrl: string;
  statusPathPrefix: string;
  input: GpuRemovalInput;
  onCancel?: (remoteJobId: string) => Promise<void>;
}): Promise<PipelineOutput> {
  const { baseUrl, statusPathPrefix, input, onCancel } = options;
  const { outputQuality = 'source', cancelRef, onPhase } = input;
  let payload = options.initialPayload;
  let remoteJobId = getRemoteJobId(payload);
  let outputUrl = getOutputUrl(payload, baseUrl);

  if (outputUrl) {
    onPhase?.('completed', 100, outputQuality === 'higher' ? 'AI removal complete in higher quality.' : 'AI removal complete at source quality.');
    return makePipelineOutput(outputUrl, input);
  }

  const statusUrl = getStatusUrl(payload, baseUrl, statusPathPrefix);
  if (!statusUrl) throw new Error('eTreyser did not return a status URL or output URL.');

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    if (cancelRef.cancelled) {
      if (onCancel) await onCancel(remoteJobId);
      throw new Error('__CANCELLED__');
    }

    await sleep(POLL_MS);
    payload = await fetchStatus(statusUrl);
    remoteJobId = getRemoteJobId(payload) || remoteJobId;
    const phase = normalizePhase(payload);
    const progress = Math.max(24, Math.min(99, Number(payload.progress ?? (24 + poll * 2))));
    const msg = payload.statusMessage || payload.status_message || 'eTreyser is removing the selected object...';
    onPhase?.(phase === 'completed' ? 'generating_preview' : phase, progress, msg);

    if (phase === 'failed') throw new Error(payload.error || payload.error_message || payload.statusMessage || payload.status_message || 'AI video removal failed.');

    outputUrl = getOutputUrl(payload, baseUrl);
    if (phase === 'completed' || outputUrl) {
      if (!outputUrl) throw new Error('eTreyser completed but did not return an output URL.');
      onPhase?.('completed', 100, outputQuality === 'higher' ? 'AI removal complete in higher quality.' : 'AI removal complete at source quality.');
      return makePipelineOutput(outputUrl, input);
    }
  }

  throw new Error('AI video removal timed out.');
}

async function runApiProxyRemoval(input: GpuRemovalInput): Promise<PipelineOutput> {
  if (!USE_ERASER_API_PROXY) throw new Error('Remote eTreyser API proxy is disabled. Set VITE_TRECUT_ERASER_DISABLE_PROXY=false or leave it unset for the production GPU proxy.');
  const { jobId, file, fps, duration, width, height, selectedTime, selectedFrameIndex, maskCanvas, outputQuality = 'source', onPhase } = input;

  onPhase?.('segmenting', 22, 'Sending video and mask to eTreyser GPU proxy...');

  const maskBlob = await canvasToPngBlob(maskCanvas);
  const [sourceVideoBase64, maskBase64] = await Promise.all([
    blobToDataUrl(file),
    blobToDataUrl(maskBlob),
  ]);

  const createRes = await fetch(`${ERASER_API_PROXY_URL}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_video_base64: sourceVideoBase64,
      mask_base64: maskBase64,
      mode: 'static_logo',
      quality: outputQuality,
      selected_time: selectedTime,
      selected_frame_index: selectedFrameIndex,
      fps,
      duration,
      width,
      height,
      pipeline: 'sam2-propainter',
      mask_semantics: 'alpha_gt_0_remove',
      preserve_resolution: true,
      preserve_fps: true,
      preserve_audio: true,
      output_mode: 'composite',
      return_mode: 'composite',
      result_mode: 'full_video',
      output_kind: 'full_video',
      composite_output: true,
      full_frame_output: true,
      full_video_output: true,
      patch_only: false,
      return_patch: false,
      metadata: {
        source: 'trecut_eraser_tool',
        local_job_id: jobId,
        selected_time: selectedTime,
        selected_frame_index: selectedFrameIndex,
        fps,
        duration,
        width,
        height,
        pipeline: 'sam2-propainter',
        mask_semantics: 'alpha_gt_0_remove',
      },
    }),
  });

  const initialPayload = await parseWorkerResponse(createRes);
  return waitForRemovalOutput({
    initialPayload,
    baseUrl: ERASER_API_PROXY_URL,
    statusPathPrefix: '/jobs',
    input,
  });
}

async function runDirectWorkerRemoval(input: GpuRemovalInput): Promise<PipelineOutput> {
  if (!DIRECT_WORKER_URL) throw new Error('GPU video eraser worker is disabled or not configured. Enable VITE_ETREYSER_ALLOW_CLOUD_GPU=true only when you intentionally want direct remote GPU processing.');

  const {
    jobId,
    file,
    fps,
    duration,
    width,
    height,
    selectedTime,
    selectedFrameIndex,
    maskCanvas,
    outputQuality = 'source',
    onPhase,
  } = input;

  onPhase?.('segmenting', 22, 'Sending video and mask to GPU AI worker...');

  const maskBlob = await canvasToPngBlob(maskCanvas);
  const form = new FormData();
  form.append('video', file, file.name || 'video.mp4');
  form.append('mask', maskBlob, 'mask.png');
  form.append('job_id', jobId);
  form.append('selected_time', String(selectedTime));
  form.append('selected_frame_index', String(selectedFrameIndex));
  form.append('fps', String(fps));
  form.append('duration', String(duration));
  form.append('width', String(width));
  form.append('height', String(height));
  form.append('pipeline', 'sam2-propainter');
  form.append('mask_semantics', 'alpha_gt_0_remove');
  form.append('quality', outputQuality);
  form.append('preserve_resolution', 'true');
  form.append('preserve_fps', 'true');
  form.append('preserve_audio', 'true');

  const createRes = await fetch(`${DIRECT_WORKER_URL}/v1/video-eraser/jobs`, {
    method: 'POST',
    body: form,
  });

  const initialPayload = await parseWorkerResponse(createRes);
  return waitForRemovalOutput({
    initialPayload,
    baseUrl: DIRECT_WORKER_URL,
    statusPathPrefix: '/v1/video-eraser/jobs',
    input,
    onCancel: requestDirectWorkerCancel,
  });
}

export async function runGpuRemoval(input: GpuRemovalInput): Promise<PipelineOutput> {
  if (USE_ERASER_API_PROXY && ERASER_API_PROXY_URL) return runApiProxyRemoval(input);
  return runDirectWorkerRemoval(input);
}
