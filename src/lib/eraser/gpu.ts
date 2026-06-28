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

const WORKER_URL = String(import.meta.env.VITE_ERASER_GPU_WORKER_URL ?? '').replace(/\/$/, '');
const API_KEY = String(import.meta.env.VITE_ERASER_GPU_API_KEY ?? '');
const POLL_MS = 1400;
const MAX_POLLS = 900; // about 21 minutes

export function isGpuRemovalConfigured(): boolean {
  return WORKER_URL.length > 0;
}

export function gpuRemovalLabel(): string {
  return isGpuRemovalConfigured() ? 'GPU AI worker' : 'browser fallback';
}

function authHeaders(): HeadersInit {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
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

function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${WORKER_URL}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function getRemoteJobId(payload: WorkerJobResponse): string {
  return payload.jobId || payload.job_id || payload.id || '';
}

function getOutputUrl(payload: WorkerJobResponse): string {
  const raw = payload.outputUrl || payload.output_url || payload.finalOutputUrl || payload.final_output_url || payload.previewUrl || payload.preview_url || '';
  return raw ? absoluteUrl(raw) : '';
}

function getStatusUrl(payload: WorkerJobResponse): string {
  const explicit = payload.statusUrl || payload.status_url;
  if (explicit) return absoluteUrl(explicit);
  const remoteJobId = getRemoteJobId(payload);
  if (!remoteJobId) return '';
  return `${WORKER_URL}/v1/video-eraser/jobs/${encodeURIComponent(remoteJobId)}`;
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
    throw new Error(text || `GPU worker failed with HTTP ${res.status}.`);
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
  const res = await fetch(statusUrl, { method: 'GET', headers: authHeaders() });
  return parseWorkerResponse(res);
}

async function requestCancel(remoteJobId: string): Promise<void> {
  if (!remoteJobId) return;
  await fetch(`${WORKER_URL}/v1/video-eraser/jobs/${encodeURIComponent(remoteJobId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  }).catch(() => undefined);
}

export async function runGpuRemoval(input: GpuRemovalInput): Promise<PipelineOutput> {
  if (!WORKER_URL) throw new Error('GPU video eraser worker is not configured.');

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
    cancelRef,
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

  const createRes = await fetch(`${WORKER_URL}/v1/video-eraser/jobs`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  let payload = await parseWorkerResponse(createRes);
  let remoteJobId = getRemoteJobId(payload);
  let outputUrl = getOutputUrl(payload);

  if (outputUrl) {
    onPhase?.('completed', 100, outputQuality === 'higher' ? 'GPU AI removal complete in higher quality.' : 'GPU AI removal complete at source quality.');
    return {
      finalUrl: outputUrl,
      localUrl: outputUrl,
      mimeType: 'video/mp4',
      hasAudio: true,
      outW: width,
      outH: height,
      effectiveFps: fps,
      frameCount: Math.round(duration * fps),
      procW: width,
      procH: height,
      lowConfidenceFrames: [],
      inpaintedFrames: [],
      originalFrames: [],
      timestamps: [],
      confidence: [],
    };
  }

  const statusUrl = getStatusUrl(payload);
  if (!statusUrl) throw new Error('GPU worker did not return a status URL or output URL.');

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    if (cancelRef.cancelled) {
      await requestCancel(remoteJobId);
      throw new Error('__CANCELLED__');
    }

    await sleep(POLL_MS);
    payload = await fetchStatus(statusUrl);
    remoteJobId = getRemoteJobId(payload) || remoteJobId;
    const phase = normalizePhase(payload);
    const progress = Math.max(24, Math.min(99, Number(payload.progress ?? (24 + poll * 2))));
    const msg = payload.statusMessage || payload.status_message || 'GPU AI worker is removing the selected object...';
    onPhase?.(phase === 'completed' ? 'generating_preview' : phase, progress, msg);

    if (phase === 'failed') throw new Error(payload.error || payload.error_message || 'GPU AI video removal failed.');

    outputUrl = getOutputUrl(payload);
    if (phase === 'completed' || outputUrl) {
      if (!outputUrl) throw new Error('GPU worker completed but did not return an output URL.');
      onPhase?.('completed', 100, outputQuality === 'higher' ? 'GPU AI removal complete in higher quality.' : 'GPU AI removal complete at source quality.');
      return {
        finalUrl: outputUrl,
        localUrl: outputUrl,
        mimeType: 'video/mp4',
        hasAudio: true,
        outW: width,
        outH: height,
        effectiveFps: fps,
        frameCount: Math.round(duration * fps),
        procW: width,
        procH: height,
        lowConfidenceFrames: [],
        inpaintedFrames: [],
        originalFrames: [],
        timestamps: [],
        confidence: [],
      };
    }
  }

  throw new Error('GPU AI video removal timed out.');
}
