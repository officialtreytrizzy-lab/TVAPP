import crypto from 'node:crypto';

export interface RemovalJobRequest {
  source_video_url?: string;
  mask_url?: string;
  source_video_base64?: string;
  mask_base64?: string;
  mode?: 'static_logo' | 'moving_object';
  quality?: 'source' | 'higher';
  selected_time?: number | string;
  selected_frame_index?: number | string;
  fps?: number | string;
  duration?: number | string;
  width?: number | string;
  height?: number | string;
  pipeline?: string;
  mask_semantics?: string;
  preserve_resolution?: boolean;
  preserve_fps?: boolean;
  preserve_audio?: boolean;
  output_mode?: 'composite' | 'patch' | string;
  return_mode?: 'composite' | 'patch' | string;
  result_mode?: 'full_video' | 'patch' | string;
  output_kind?: 'full_video' | 'patch' | string;
  composite_output?: boolean;
  full_frame_output?: boolean;
  full_video_output?: boolean;
  patch_only?: boolean;
  return_patch?: boolean;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
}

export interface AiRemixJobRequest {
  source_video_url?: string;
  source_video_base64?: string;
  mask_url?: string;
  mask_base64?: string;
  prompt: string;
  intent?: string;
  strength?: 'light' | 'medium' | 'heavy' | string;
  preserve_audio?: boolean;
  preserve_face?: boolean;
  preserve_motion?: boolean;
  quality?: 'draft' | 'source' | 'high' | string;
  metadata?: Record<string, unknown>;
}

export interface MixTransitionJobRequest {
  clip_a_url?: string;
  clip_b_url?: string;
  clip_a_base64?: string;
  clip_b_base64?: string;
  duration?: number;
  quality?: 'source' | 'higher';
  webhook_url?: string;
  metadata?: Record<string, unknown>;
}

export interface ApiJobRecord {
  job_id: string;
  external_job_id?: string;
  status: string;
  service: 'video_removal' | 'video_transition' | 'ai_remix';
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

export function absoluteModalUrl(pathOrUrl: string): string {
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

export function modalMixTransitionStatusUrl(jobId: string): string {
  return absoluteModalUrl(`/v1/video-transitions/mix/jobs/${encodeURIComponent(jobId)}`);
}

export function modalMixTransitionOutputUrl(jobId: string): string {
  return absoluteModalUrl(`/v1/video-transitions/mix/jobs/${encodeURIComponent(jobId)}/output`);
}

export function modalAiRemixStatusUrl(jobId: string): string {
  return absoluteModalUrl(`/v1/ai-remix/jobs/${encodeURIComponent(jobId)}`);
}

export function modalAiRemixOutputUrl(jobId: string): string {
  return absoluteModalUrl(`/v1/ai-remix/jobs/${encodeURIComponent(jobId)}/output`);
}

export function modalCompositeOutputFromPayload(modal: any): string | undefined {
  // Strict on purpose for video removal. The worker's generic output/preview
  // fields have been returning raw patch/blob artifacts. Only accept names that
  // explicitly mean the final full-frame composited erased video.
  return modal.finalCompositeUrl
    || modal.final_composite_url
    || modal.compositeOutputUrl
    || modal.composite_output_url
    || modal.fullVideoUrl
    || modal.full_video_url
    || modal.finalOutputUrl
    || modal.final_output_url;
}

export function modalAiRemixOutputFromPayload(modal: any): string | undefined {
  return modal.finalCompositeUrl
    || modal.final_composite_url
    || modal.compositeOutputUrl
    || modal.composite_output_url
    || modal.fullVideoUrl
    || modal.full_video_url
    || modal.finalOutputUrl
    || modal.final_output_url
    || modal.outputUrl
    || modal.output_url;
}

function modalLooseOutputFromPayload(modal: any): string | undefined {
  return modal.outputUrl
    || modal.output_url
    || modal.resultUrl
    || modal.result_url
    || modal.videoUrl
    || modal.video_url
    || modal.previewUrl
    || modal.preview_url;
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

function metadataValue(input: RemovalJobRequest, key: string, fallback: string | number): string {
  const direct = input[key as keyof RemovalJobRequest];
  const fromMetadata = input.metadata?.[key];
  const value = direct ?? fromMetadata ?? fallback;
  return String(value);
}

function appendRemovalOutputIntent(form: FormData, input: RemovalJobRequest): void {
  const outputMode = input.output_mode || 'composite';
  const returnMode = input.return_mode || 'composite';
  const resultMode = input.result_mode || 'full_video';
  const outputKind = input.output_kind || 'full_video';
  const compositeOutput = input.composite_output !== false;
  const patchOnly = input.patch_only === true;
  const returnPatch = input.return_patch === true;
  const fullFrameOutput = input.full_frame_output !== false;
  const fullVideoOutput = input.full_video_output !== false;

  // These keys intentionally overlap because worker versions differ. Unknown
  // fields are harmless; known fields force the worker to return the finished
  // erased video instead of the raw patch/crop artifact.
  form.append('output_mode', outputMode);
  form.append('return_mode', returnMode);
  form.append('result_mode', resultMode);
  form.append('output_kind', outputKind);
  form.append('composite_output', String(compositeOutput));
  form.append('patch_only', String(patchOnly));
  form.append('return_patch', String(returnPatch));
  form.append('full_frame_output', String(fullFrameOutput));
  form.append('full_video_output', String(fullVideoOutput));
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
  form.append('selected_time', metadataValue(input, 'selected_time', 0));
  form.append('selected_frame_index', metadataValue(input, 'selected_frame_index', 0));
  form.append('fps', metadataValue(input, 'fps', 30));
  form.append('duration', metadataValue(input, 'duration', 0));
  form.append('width', metadataValue(input, 'width', 0));
  form.append('height', metadataValue(input, 'height', 0));
  form.append('pipeline', input.pipeline || String(input.metadata?.pipeline || 'sam2-propainter'));
  form.append('mask_semantics', input.mask_semantics || String(input.metadata?.mask_semantics || 'alpha_gt_0_remove'));
  form.append('quality', input.quality || 'source');
  form.append('preserve_resolution', String(input.preserve_resolution !== false));
  form.append('preserve_fps', String(input.preserve_fps !== false));
  form.append('preserve_audio', String(input.preserve_audio !== false));
  appendRemovalOutputIntent(form, input);

  const response = await fetch(`${base}/v1/video-eraser/jobs`, { method: 'POST', body: form });
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const detail = payload?.detail || payload?.error || text || `Modal worker failed with HTTP ${response.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  const externalJobId = payload.jobId || payload.job_id || payload.id || jobId;
  const outputRaw = modalCompositeOutputFromPayload(payload);
  const statusRaw = payload.statusUrl || payload.status_url || `/v1/video-eraser/jobs/${externalJobId}`;

  return {
    externalJobId,
    phase: payload.phase || payload.status || 'queued',
    progress: payload.progress,
    outputUrl: outputRaw ? absoluteModalUrl(outputRaw) : undefined,
    statusUrl: statusRaw ? absoluteModalUrl(statusRaw) : undefined,
  };
}

export async function submitAiRemixToModal(jobId: string, input: AiRemixJobRequest): Promise<{
  externalJobId: string;
  phase: string;
  progress?: number;
  outputUrl?: string;
  statusUrl?: string;
}> {
  const base = modalBaseUrl();
  if (!base) throw new Error('VITE_ERASER_GPU_WORKER_URL or ERASER_GPU_WORKER_URL is not configured.');
  if (!input.prompt?.trim()) throw new Error('prompt is required.');

  const form = new FormData();
  let videoBlob: Blob;
  if (input.source_video_base64) videoBlob = base64ToBlob(input.source_video_base64, 'video/mp4');
  else if (input.source_video_url) videoBlob = await fetchAsBlob(input.source_video_url, 'source_video_url');
  else throw new Error('source_video_url or source_video_base64 is required.');

  form.append('video', videoBlob, `${jobId}.mp4`);
  if (input.mask_base64) form.append('mask', base64ToBlob(input.mask_base64, 'image/png'), `${jobId}-mask.png`);
  else if (input.mask_url) form.append('mask', await fetchAsBlob(input.mask_url, 'mask_url'), `${jobId}-mask.png`);
  form.append('job_id', jobId);
  form.append('prompt', input.prompt);
  form.append('intent', input.intent || 'full_video_to_video');
  form.append('strength', input.strength || 'medium');
  form.append('preserve_audio', String(input.preserve_audio !== false));
  form.append('preserve_face', String(input.preserve_face !== false));
  form.append('preserve_motion', String(input.preserve_motion !== false));
  form.append('quality', input.quality || 'source');

  const response = await fetch(`${base}/v1/ai-remix/jobs`, { method: 'POST', body: form });
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const detail = payload?.detail || payload?.error || text || `Modal AI Remix worker failed with HTTP ${response.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  const externalJobId = payload.jobId || payload.job_id || payload.id || jobId;
  const outputRaw = modalAiRemixOutputFromPayload(payload);
  const statusRaw = payload.statusUrl || payload.status_url || `/v1/ai-remix/jobs/${externalJobId}`;

  return {
    externalJobId,
    phase: payload.phase || payload.status || 'queued',
    progress: payload.progress,
    outputUrl: outputRaw ? absoluteModalUrl(outputRaw) : undefined,
    statusUrl: statusRaw ? absoluteModalUrl(statusRaw) : undefined,
  };
}

export async function submitMixTransitionToModal(jobId: string, input: MixTransitionJobRequest): Promise<{
  externalJobId: string;
  phase: string;
  progress?: number;
  outputUrl?: string;
  statusUrl?: string;
}> {
  const base = modalBaseUrl();
  if (!base) throw new Error('VITE_ERASER_GPU_WORKER_URL or ERASER_GPU_WORKER_URL is not configured.');

  const form = new FormData();
  let clipABlob: Blob;
  let clipBBlob: Blob;

  if (input.clip_a_base64) clipABlob = base64ToBlob(input.clip_a_base64, 'video/mp4');
  else if (input.clip_a_url) clipABlob = await fetchAsBlob(input.clip_a_url, 'clip_a_url');
  else throw new Error('clip_a_url or clip_a_base64 is required.');

  if (input.clip_b_base64) clipBBlob = base64ToBlob(input.clip_b_base64, 'video/mp4');
  else if (input.clip_b_url) clipBBlob = await fetchAsBlob(input.clip_b_url, 'clip_b_url');
  else throw new Error('clip_b_url or clip_b_base64 is required.');

  form.append('clip_a', clipABlob, `${jobId}-a.mp4`);
  form.append('clip_b', clipBBlob, `${jobId}-b.mp4`);
  form.append('job_id', jobId);
  form.append('duration', String(input.duration || 1));
  form.append('quality', input.quality || 'source');

  const response = await fetch(`${base}/v1/video-transitions/mix/jobs`, { method: 'POST', body: form });
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const detail = payload?.detail || payload?.error || text || `Modal transition worker failed with HTTP ${response.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  const externalJobId = payload.jobId || payload.job_id || payload.id || jobId;
  const outputRaw = modalLooseOutputFromPayload(payload) || payload.finalOutputUrl || payload.final_output_url;
  const statusRaw = payload.statusUrl || payload.status_url || `/v1/video-transitions/mix/jobs/${externalJobId}`;

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
