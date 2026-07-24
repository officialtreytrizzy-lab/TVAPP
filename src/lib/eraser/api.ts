// Single-folder local job/state layer for EraserAI.
// No Supabase Edge Function. No hosted backend. The browser stores job metadata
// in localStorage and final output videos in IndexedDB so `npm run dev` works
// as one self-contained repo.

const JOBS_KEY = 'eraserai.local.jobs.v2';
const LEGACY_JOBS_KEY = 'eraserai.local.jobs.v1';
const DEVICE_CREDENTIAL_KEY = 'etreyser.device.credential.v1';
const DB_NAME = 'eraserai-local-output-db';
const DB_VERSION = 1;
const OUTPUT_STORE = 'outputs';
const OUTPUT_CACHE = 'etreyser-local-output-cache-v1';
const OUTPUT_CACHE_PATH = '/__etreyser-local-output__/';
const MAX_RECENT_COMPLETED_JOBS = 3;
export const ERASER_LIBRARY_EVENT = 'etreyser:library-updated';

const ACTIVE_PROCESSING = new Set([
  'segmenting',
  'frame_extraction',
  'optical_flow_tracking',
  'diffusion_inpainting',
  'audio_preserving_export',
  'validation',
  'tracking_mask',
  'smoothing_masks',
  'inpainting',
  'rebuilding_video',
  'attaching_audio',
  'generating_preview',
]);

export interface DeviceIdentity {
  deviceId: string;
  createdAt: string;
  shortId: string;
}

interface StoredDeviceCredential {
  deviceId: string;
  deviceSecret: string;
  createdAt: string;
}

let cachedDeviceCredential: StoredDeviceCredential | null = null;

export interface LocalJob {
  id: string;
  job_id: string;
  user_id: string | null;
  device_id: string;
  file_type: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  frame_count: number;
  original_filename: string | null;
  phase: string;
  progress: number;
  status_message: string;
  error_message: string | null;
  selected_frame_index: number | null;
  mask_width: number | null;
  mask_height: number | null;
  preview_url: string | null;
  final_output_url: string | null;
  final_output_key: string | null;
  output_mime: string | null;
  audio_preserved: boolean | null;
  logs: string[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

type CreateJobPayload = {
  fileType: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  originalFilename: string;
};

type MaskPayload = {
  jobId: string;
  selectedFrameIndex: number;
  maskWidth: number;
  maskHeight: number;
};

type TransitionPayload = {
  jobId: string;
  to: string;
  progress?: number;
  statusMessage?: string;
  log?: string;
  error?: string;
};

type ProgressPayload = {
  jobId: string;
  progress?: number;
  statusMessage?: string;
  log?: string;
};

type CompletePayload = {
  jobId: string;
  previewUrl?: string;
  finalOutputUrl?: string;
  outputMime?: string;
  audioPreserved?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function randomToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function getOrCreateDeviceCredential(): StoredDeviceCredential {
  if (cachedDeviceCredential) return cachedDeviceCredential;
  const fallback: StoredDeviceCredential = {
    deviceId: `device-${randomToken().slice(0, 24)}`,
    deviceSecret: randomToken(),
    createdAt: nowIso(),
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(DEVICE_CREDENTIAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredDeviceCredential>;
      if (parsed.deviceId && parsed.deviceSecret && parsed.createdAt) {
        cachedDeviceCredential = parsed as StoredDeviceCredential;
        return cachedDeviceCredential;
      }
    }
    window.localStorage.setItem(DEVICE_CREDENTIAL_KEY, JSON.stringify(fallback));
    cachedDeviceCredential = fallback;
  } catch {
    // Storage can be unavailable in hardened/private contexts. The in-memory
    // fallback still lets the current session work, but cannot survive reloads.
  }
  cachedDeviceCredential = fallback;
  return cachedDeviceCredential;
}

export function getDeviceIdentity(): DeviceIdentity {
  const credential = getOrCreateDeviceCredential();
  return {
    deviceId: credential.deviceId,
    createdAt: credential.createdAt,
    shortId: credential.deviceId.replace(/^device-/, '').slice(0, 8).toUpperCase(),
  };
}

function currentDeviceId(): string {
  return getOrCreateDeviceCredential().deviceId;
}

function notifyLibraryUpdated(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ERASER_LIBRARY_EVENT));
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readJobs(): LocalJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(JOBS_KEY) ?? window.localStorage.getItem(LEGACY_JOBS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const deviceId = currentDeviceId();
    const normalized = parsed.map((job) => ({
      ...job,
      device_id: String(job?.device_id || job?.user_id || deviceId),
      user_id: String(job?.user_id || job?.device_id || deviceId),
    })) as LocalJob[];
    if (!window.localStorage.getItem(JOBS_KEY) && normalized.length) {
      window.localStorage.setItem(JOBS_KEY, JSON.stringify(normalized));
    }
    return normalized;
  } catch {
    return [];
  }
}

function writeJobs(jobs: LocalJob[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
}

function publicJob(job: LocalJob) {
  return {
    ...job,
    jobId: job.job_id,
    statusMessage: job.status_message,
    finalOutputUrl: job.final_output_url,
    previewUrl: job.preview_url,
    outputMime: job.output_mime,
    audioPreserved: job.audio_preserved,
  };
}

function findJob(incomingJobId: string): LocalJob | null {
  const clean = String(incomingJobId ?? '').trim();
  if (!clean) return null;
  return readJobs().find((job) => job.job_id === clean || job.id === clean) ?? null;
}

function replaceJob(updated: LocalJob): LocalJob {
  const jobs = readJobs();
  const idx = jobs.findIndex((job) => job.id === updated.id || job.job_id === updated.job_id);
  if (idx === -1) {
    jobs.unshift(updated);
  } else {
    jobs[idx] = updated;
  }
  writeJobs(jobs);
  return updated;
}

function updateJob(jobId: string, updater: (job: LocalJob) => LocalJob): LocalJob {
  const job = findJob(jobId);
  if (!job) throw new Error(`Job not found: ${String(jobId || '').trim() || 'missing jobId'}`);
  const updated = updater({ ...job, logs: [...(job.logs ?? [])] });
  updated.updated_at = nowIso();
  return replaceJob(updated);
}

function appendLog(job: LocalJob, log?: string): void {
  if (!log) return;
  job.logs = [...(job.logs ?? []), `${nowIso()} ${log}`].slice(-250);
}

function openOutputDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTPUT_STORE)) {
        db.createObjectStore(OUTPUT_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local output database.'));
  });
}

function outputCacheRequest(key: string): Request {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://local.invalid';
  return new Request(`${origin}${OUTPUT_CACHE_PATH}${encodeURIComponent(key)}`, { method: 'GET' });
}

async function putOutputIndexedDb(key: string, blob: Blob, mimeType: string): Promise<void> {
  const db = await openOutputDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTPUT_STORE, 'readwrite');
      tx.objectStore(OUTPUT_STORE).put({ key, blob, mimeType, createdAt: nowIso() });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted the cleaned-video write.'));
      tx.onerror = () => reject(tx.error ?? new Error('Could not save cleaned video in IndexedDB.'));
    });
  } finally {
    db.close();
  }
}

async function putOutputCache(key: string, blob: Blob, mimeType: string): Promise<void> {
  if (typeof caches === 'undefined') throw new Error('Cache Storage is not available in this browser.');
  const cache = await caches.open(OUTPUT_CACHE);
  await cache.put(outputCacheRequest(key), new Response(blob, {
    headers: {
      'Content-Type': mimeType || blob.type || 'video/mp4',
      'X-ETreyser-Created-At': nowIso(),
    },
  }));
}

async function putOutput(key: string, blob: Blob, mimeType: string): Promise<void> {
  let indexedDbError: Error | null = null;
  try {
    await putOutputIndexedDb(key, blob, mimeType);
    return;
  } catch (error) {
    indexedDbError = error instanceof Error ? error : new Error(String(error));
  }

  try {
    await putOutputCache(key, blob, mimeType);
    return;
  } catch (cacheError) {
    const cacheMessage = cacheError instanceof Error ? cacheError.message : String(cacheError);
    throw new Error(`Device storage failed. IndexedDB: ${indexedDbError.message}. Cache Storage: ${cacheMessage}`);
  }
}

async function getOutputIndexedDb(key: string): Promise<{ blob: Blob; mimeType: string } | null> {
  const db = await openOutputDb();
  try {
    return await new Promise<{ blob: Blob; mimeType: string } | null>((resolve, reject) => {
      const tx = db.transaction(OUTPUT_STORE, 'readonly');
      const req = tx.objectStore(OUTPUT_STORE).get(key);
      req.onsuccess = () => resolve(req.result ? { blob: req.result.blob, mimeType: req.result.mimeType } : null);
      req.onerror = () => reject(req.error ?? new Error('Could not read cleaned video from IndexedDB.'));
    });
  } finally {
    db.close();
  }
}

async function getOutputCache(key: string): Promise<{ blob: Blob; mimeType: string } | null> {
  if (typeof caches === 'undefined') return null;
  const cache = await caches.open(OUTPUT_CACHE);
  const response = await cache.match(outputCacheRequest(key));
  if (!response) return null;
  const blob = await response.blob();
  return { blob, mimeType: response.headers.get('content-type') || blob.type || 'video/mp4' };
}

async function getOutput(key: string): Promise<{ blob: Blob; mimeType: string } | null> {
  try {
    const indexed = await getOutputIndexedDb(key);
    if (indexed?.blob) return indexed;
  } catch {
    // Some mobile browsers reject large Blob values in IndexedDB. Try Cache Storage.
  }
  try {
    return await getOutputCache(key);
  } catch {
    return null;
  }
}

async function deleteOutputIndexedDb(key: string): Promise<void> {
  const db = await openOutputDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTPUT_STORE, 'readwrite');
      tx.objectStore(OUTPUT_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted the delete.'));
      tx.onerror = () => reject(tx.error ?? new Error('Could not delete the IndexedDB video.'));
    });
  } finally {
    db.close();
  }
}

async function deleteOutput(key: string | null): Promise<void> {
  if (!key) return;
  await Promise.all([
    deleteOutputIndexedDb(key).catch(() => undefined),
    (async () => {
      if (typeof caches === 'undefined') return;
      const cache = await caches.open(OUTPUT_CACHE);
      await cache.delete(outputCacheRequest(key));
    })().catch(() => undefined),
  ]);
}

async function discoverWorkerOutputUrl(jobId: string): Promise<string | null> {
  try {
    const response = await fetch('/api/v1/trecut/eraser/upload-target', {
      method: 'GET',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const workerBase = String(payload.worker_base || payload.workerBase || '').replace(/\/$/, '');
    if (!workerBase) return null;
    return `${workerBase}/v1/video-eraser/jobs/${encodeURIComponent(jobId)}/output`;
  } catch {
    return null;
  }
}

async function requestPersistentDeviceStorage(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    // Optional browser capability. IndexedDB remains usable without it.
  }
}

function completedSortTime(job: LocalJob): number {
  return Date.parse(job.completed_at || job.updated_at || job.created_at) || 0;
}

async function pruneCompletedJobsForCurrentDevice(): Promise<void> {
  const deviceId = currentDeviceId();
  const jobs = readJobs();
  const completed = jobs
    .filter((job) => job.device_id === deviceId && job.phase === 'completed')
    .sort((a, b) => completedSortTime(b) - completedSortTime(a));
  const expired = completed.slice(MAX_RECENT_COMPLETED_JOBS);
  if (!expired.length) return;
  const expiredIds = new Set(expired.map((job) => job.id));
  await Promise.all(expired.map((job) => deleteOutput(job.final_output_key).catch(() => undefined)));
  writeJobs(jobs.filter((job) => !expiredIds.has(job.id)));
}

export const eraserApi = {
  createJob: async (p: CreateJobPayload) => {
    const timestamp = nowIso();
    const job: LocalJob = {
      id: uuid(),
      job_id: uuid(),
      user_id: currentDeviceId(),
      device_id: currentDeviceId(),
      file_type: p.fileType || 'video/mp4',
      duration: p.duration,
      fps: p.fps,
      width: p.width,
      height: p.height,
      frame_count: p.frameCount,
      original_filename: p.originalFilename || 'video',
      phase: 'awaiting_mask',
      progress: 18,
      status_message: 'Uploaded & validated. Draw a mask to remove an object.',
      error_message: null,
      selected_frame_index: null,
      mask_width: null,
      mask_height: null,
      preview_url: null,
      final_output_url: null,
      final_output_key: null,
      output_mime: null,
      audio_preserved: null,
      logs: [`${timestamp} create_job local`],
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    };

    const jobs = readJobs();
    jobs.unshift(job);
    writeJobs(jobs);
    return publicJob(job);
  },

  getJob: async (jobId: string) => {
    const job = findJob(jobId);
    if (!job) throw new Error(`Job not found: ${String(jobId || '').trim() || 'missing jobId'}`);
    return publicJob(job);
  },

  setMask: async (p: MaskPayload) => {
    const job = findJob(p.jobId);
    if (!job) throw new Error(`Job not found: ${String(p.jobId || '').trim() || 'missing jobId'}`);

    if (ACTIVE_PROCESSING.has(job.phase)) {
      return { ...publicJob(job), idempotent: true, message: 'Job already processing; mask already accepted.' };
    }

    if (job.phase === 'completed') {
      throw new Error('Completed jobs must be refined with refine_mask or started as a new job.');
    }

    const updated = updateJob(job.job_id, (cur) => {
      cur.phase = 'mask_ready';
      cur.progress = Math.max(cur.progress ?? 0, 20);
      cur.status_message = 'Mask received. Ready to process.';
      cur.error_message = null;
      cur.selected_frame_index = p.selectedFrameIndex;
      cur.mask_width = p.maskWidth;
      cur.mask_height = p.maskHeight;
      appendLog(cur, `set_mask frame=${p.selectedFrameIndex} size=${p.maskWidth}x${p.maskHeight}`);
      return cur;
    });

    return publicJob(updated);
  },

  transition: async (p: TransitionPayload) => {
    const updated = updateJob(p.jobId, (cur) => {
      cur.phase = p.to;
      if (typeof p.progress === 'number') cur.progress = p.progress;
      if (p.statusMessage) cur.status_message = p.statusMessage;
      if (p.error) cur.error_message = p.error;
      appendLog(cur, p.log ?? `transition -> ${p.to}`);
      return cur;
    });
    return publicJob(updated);
  },

  progress: async (p: ProgressPayload) => {
    const updated = updateJob(p.jobId, (cur) => {
      if (typeof p.progress === 'number') cur.progress = p.progress;
      if (p.statusMessage) cur.status_message = p.statusMessage;
      appendLog(cur, p.log);
      return cur;
    });
    return publicJob(updated);
  },

  complete: async (p: CompletePayload) => {
    const updated = updateJob(p.jobId, (cur) => {
      cur.phase = 'completed';
      cur.progress = 100;
      cur.status_message = p.audioPreserved === false
        ? 'Done — original audio could not be captured; exported silent.'
        : 'Done!';
      cur.preview_url = p.previewUrl ?? cur.preview_url;
      cur.final_output_url = p.finalOutputUrl ?? p.previewUrl ?? cur.final_output_url;
      cur.output_mime = p.outputMime ?? cur.output_mime;
      cur.audio_preserved = typeof p.audioPreserved === 'boolean' ? p.audioPreserved : cur.audio_preserved;
      cur.completed_at = nowIso();
      appendLog(cur, `complete mime=${cur.output_mime ?? 'unknown'} audio=${cur.audio_preserved === false ? 'no' : 'yes'}`);
      return cur;
    });
    await requestPersistentDeviceStorage();
    await pruneCompletedJobsForCurrentDevice();
    notifyLibraryUpdated();
    return publicJob(updated);
  },

  cancel: async (jobId: string) => {
    const updated = updateJob(jobId, (cur) => {
      cur.phase = 'cancelled';
      cur.status_message = 'Processing cancelled.';
      appendLog(cur, 'cancelled');
      return cur;
    });
    return publicJob(updated);
  },

  refineMask: async (p: MaskPayload) => {
    const updated = updateJob(p.jobId, (cur) => {
      cur.phase = 'mask_ready';
      cur.progress = Math.max(cur.progress ?? 0, 20);
      cur.status_message = 'Correction mask received. Ready to reprocess.';
      cur.error_message = null;
      cur.selected_frame_index = p.selectedFrameIndex;
      cur.mask_width = p.maskWidth;
      cur.mask_height = p.maskHeight;
      appendLog(cur, `refine_mask frame=${p.selectedFrameIndex} size=${p.maskWidth}x${p.maskHeight}`);
      return cur;
    });
    return publicJob(updated);
  },

  uploadOutput: async (jobId: string, blob: Blob, mimeType: string): Promise<string> => {
    const job = findJob(jobId);
    if (!job) throw new Error(`Job not found: ${String(jobId || '').trim() || 'missing jobId'}`);

    const ext = /mp4/i.test(mimeType) ? 'mp4' : 'webm';
    const key = `${currentDeviceId()}/${job.job_id}-${Date.now()}.${ext}`;
    // Ask the browser for durable storage before the potentially large write.
    // This is especially important on iOS, where temporary site storage can be
    // reclaimed aggressively after memory-heavy video processing.
    await requestPersistentDeviceStorage();
    await putOutput(key, blob, mimeType);

    const objectUrl = URL.createObjectURL(blob);
    updateJob(job.job_id, (cur) => {
      cur.final_output_key = key;
      cur.final_output_url = objectUrl;
      cur.output_mime = mimeType;
      appendLog(cur, `saved output locally key=${key}`);
      return cur;
    });
    notifyLibraryUpdated();

    return objectUrl;
  },

  listJobs: async (): Promise<LocalJob[]> => {
    const deviceId = currentDeviceId();
    return readJobs()
      .filter((job) => job.device_id === deviceId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  },

  listRecentCompletedJobs: async (): Promise<LocalJob[]> => {
    await pruneCompletedJobsForCurrentDevice();
    const deviceId = currentDeviceId();
    return readJobs()
      .filter((job) => job.device_id === deviceId && job.phase === 'completed')
      .sort((a, b) => completedSortTime(b) - completedSortTime(a))
      .slice(0, MAX_RECENT_COMPLETED_JOBS);
  },

  getDeviceIdentity: (): DeviceIdentity => getDeviceIdentity(),

  resolveOutputUrl: async (job: Pick<LocalJob, 'job_id' | 'final_output_key' | 'final_output_url'>): Promise<string | null> => {
    if (job.final_output_key) {
      try {
        const stored = await getOutput(job.final_output_key);
        if (stored?.blob) return URL.createObjectURL(stored.blob);
      } catch {
        // Fall back to the retained worker URL so the user can retry the device save.
      }
    }
    if (job.final_output_url) return job.final_output_url;
    // Compatibility recovery for jobs completed before the durable-save fix.
    // Those records were marked completed but stored neither a key nor URL.
    return discoverWorkerOutputUrl(job.job_id);
  },

  deleteJob: async (jobId: string): Promise<void> => {
    const deviceId = currentDeviceId();
    const jobs = readJobs();
    const job = jobs.find((row) => (row.job_id === jobId || row.id === jobId) && row.device_id === deviceId);
    if (!job) return;
    await deleteOutput(job.final_output_key).catch(() => undefined);
    writeJobs(jobs.filter((row) => row.id !== job.id));
    notifyLibraryUpdated();
  },

  clearLocalJobs: async (): Promise<void> => {
    const deviceId = currentDeviceId();
    const jobs = readJobs();
    const owned = jobs.filter((job) => job.device_id === deviceId);
    await Promise.all(owned.map((job) => deleteOutput(job.final_output_key).catch(() => undefined)));
    writeJobs(jobs.filter((job) => job.device_id !== deviceId));
    notifyLibraryUpdated();
  },
};
