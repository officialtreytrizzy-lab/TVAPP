// Single-folder local job/state layer for EraserAI.
// No Supabase Edge Function. No hosted backend. The browser stores job metadata
// in localStorage and final output videos in IndexedDB so `npm run dev` works
// as one self-contained repo.

const JOBS_KEY = 'eraserai.local.jobs.v1';
const DB_NAME = 'eraserai-local-output-db';
const DB_VERSION = 1;
const OUTPUT_STORE = 'outputs';

const ACTIVE_PROCESSING = new Set([
  'segmenting',
  'tracking_mask',
  'smoothing_masks',
  'inpainting',
  'rebuilding_video',
  'attaching_audio',
  'generating_preview',
]);

export interface LocalJob {
  id: string;
  job_id: string;
  user_id: string | null;
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

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readJobs(): LocalJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(JOBS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
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

async function putOutput(key: string, blob: Blob, mimeType: string): Promise<void> {
  const db = await openOutputDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OUTPUT_STORE, 'readwrite');
    tx.objectStore(OUTPUT_STORE).put({ key, blob, mimeType, createdAt: nowIso() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not save cleaned video locally.'));
  });
  db.close();
}

async function getOutput(key: string): Promise<{ blob: Blob; mimeType: string } | null> {
  const db = await openOutputDb();
  const result = await new Promise<{ blob: Blob; mimeType: string } | null>((resolve, reject) => {
    const tx = db.transaction(OUTPUT_STORE, 'readonly');
    const req = tx.objectStore(OUTPUT_STORE).get(key);
    req.onsuccess = () => resolve(req.result ? { blob: req.result.blob, mimeType: req.result.mimeType } : null);
    req.onerror = () => reject(req.error ?? new Error('Could not read cleaned video locally.'));
  });
  db.close();
  return result;
}

export const eraserApi = {
  createJob: async (p: CreateJobPayload) => {
    const timestamp = nowIso();
    const job: LocalJob = {
      id: uuid(),
      job_id: uuid(),
      user_id: null,
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
    const key = `${job.job_id}-${Date.now()}.${ext}`;
    await putOutput(key, blob, mimeType);

    const objectUrl = URL.createObjectURL(blob);
    updateJob(job.job_id, (cur) => {
      cur.final_output_key = key;
      cur.final_output_url = objectUrl;
      cur.output_mime = mimeType;
      appendLog(cur, `saved output locally key=${key}`);
      return cur;
    });

    return objectUrl;
  },

  listJobs: async (): Promise<LocalJob[]> => {
    return readJobs().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  },

  resolveOutputUrl: async (job: Pick<LocalJob, 'final_output_key' | 'final_output_url'>): Promise<string | null> => {
    if (job.final_output_key) {
      const stored = await getOutput(job.final_output_key);
      if (stored?.blob) return URL.createObjectURL(stored.blob);
    }
    return job.final_output_url ?? null;
  },

  clearLocalJobs: async (): Promise<void> => {
    writeJobs([]);
  },
};
