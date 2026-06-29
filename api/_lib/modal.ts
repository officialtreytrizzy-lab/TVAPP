import crypto from 'node:crypto';

export interface RemovalJobRequest {
  source_video_url?: string;
  mask_url?: string;
  source_video_base64?: string;
  mask_base64?: string;
  mode?: 'static_logo' | 'moving_object';
  quality?: 'source' | 'higher';
  preserve_resolution?: boolean;
  preserve_fps?: boolean;
  preserve_audio?: boolean;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
}

export interface ApiJobRecord {
  job_id: string;
  external_job_id?: string;
  status: string;
  service: 'video_removal';
  mode: string;
  quality: string;
  created_at: string;
  status_url: string;
  output_url?: string;
  modal_status_url?: string;
  metadata?: Record<string, unknown>;
}

const memoryJobs = new Map<string, ApiJobRecord>();

export function newPublicJobId(prefix = 'vrem'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
}

export function rememberJob(job: ApiJobRecord) {
  memoryJobs.set(job.job_id, job);
}

export function getRememberedJob(jobId: string): ApiJobRecord | undefined {
  return memoryJobs.get(jobId);
}

export function updateRememberedJob(jobId: string, patch: Partial<ApiJobRecord>): ApiJobRecord | undefined {
  const current = memoryJobs.get(jobId);
  if (!current) return undefined;
  const updated = { ...current, ...patch };
  memoryJobs.set(jobId, updated);
  return updated;
}

export function modalBaseUrl(): string {
  const url = process.env.VITE_ERASER_GPU_WORKER_URL || process.env.ERASER_GPU_WORKER_URL || '';
  return url.replace(/\/$/, '');
}

function absoluteModalUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = modalBaseUrl();
  return `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

export function modalJobStatusUrl(jobId: string): string {
  return absoluteModalUrl(`/v1/video-eraser/jobs/${encodeURIComponent(jobId)}`);
}

export function modalJobOutputUrl(jobId: string): string {
  return absoluteModalUrl(`/v1/video-eraser/jobs/${encodeURIComponent(jobId)}/output`);
}

async function fetchAsBlob(url: string, label: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${label}: HTTP ${response.status}`);
  return await response.blob();
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const clean = base64.includes(',') ? base64.split(',').pop() || '' : base64;
  return new Blob([Buffer.from(clean, 'base64')], { type: mimeType });
}

export async function submitRemovalToModal(jobId: string, input: RemovalJobRequest): Promise<{
  externalJobId: string;
  phase: string;
  progress?: number;
  outputUrl?: string;
  statusUrl?: string;
}> {
  const base = modalBaseUrl();
  if (!base) throw new Error('VITE_ERASER_GPU_WORKER_URL or ERASER_GPU_WORKER_URL is not configured.');

  const form = new FormData();
  let videoBlob: Blob;
  let maskBlob: Blob;

  if (input.source_video_base64) videoBlob = base64ToBlob(input.source_video_base64, 'video/mp4');
  else if (input.source_video_url) videoBlob = await fetchAsBlob(input.source_video_url, 'source_video_url');
  else throw new Error('source_video_url or source_video_base64 is required.');

  if (input.mask_base64) maskBlob = base64ToBlob(input.mask_base64, 'image/png');
  else if (input.mask_url) maskBlob = await fetchAsBlob(input.mask_url, 'mask_url');
  else throw new Error('mask_url or mask_base64 is required.');

  form.append('video', videoBlob, `${jobId}.mp4`);
  form.append('mask', maskBlob, `${jobId}-mask.png`);
  form.append('job_id', jobId);
  form.append('selected_time', '0');
  form.append('selected_frame_index', '0');
  form.append('fps', '30');
  form.append('duration', '0');
  form.append('width', '0');
  form.append('height', '0');
  form.append('pipeline', 'sam2-propainter');
  form.append('quality', input.quality || 'source');
  form.append('preserve_resolution', String(input.preserve_resolution !== false));
  form.append('preserve_fps', String(input.preserve_fps !== false));
  form.append('preserve_audio', String(input.preserve_audio !== false));

  const response = await fetch(`${base}/v1/video-eraser/jobs`, { method: 'POST', body: form });
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const detail = payload?.detail || payload?.error || text || `Modal worker failed with HTTP ${response.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  const externalJobId = payload.jobId || payload.job_id || payload.id || jobId;
  const outputRaw = payload.outputUrl || payload.output_url || payload.finalOutputUrl || payload.final_output_url || payload.previewUrl || payload.preview_url;
  const statusRaw = payload.statusUrl || payload.status_url || `/v1/video-eraser/jobs/${externalJobId}`;

  return {
    externalJobId,
    phase: payload.phase || payload.status || 'queued',
    progress: payload.progress,
    outputUrl: outputRaw ? absoluteModalUrl(outputRaw) : undefined,
    statusUrl: statusRaw ? absoluteModalUrl(statusRaw) : undefined,
  };
}

export async function readModalStatus(statusUrl: string): Promise<any> {
  const response = await fetch(statusUrl);
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(payload?.detail || payload?.error || text || `Modal status failed with HTTP ${response.status}`);
  return payload;
}
