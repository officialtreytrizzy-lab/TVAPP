// Real frame extraction from an HTMLVideoElement via precise seeking.
// Returns ImageData frames at a working resolution (longest side capped) so the
// in-browser inpainting/tracking stays tractable while preserving aspect ratio.

type VideoFrameCallbackElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => void) => number;
};

export interface ExtractResult {
  frames: ImageData[];
  timestamps: number[];
  procW: number;
  procH: number;
  fps: number;
  duration: number;
  frameCount: number;
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  // Hardened: never hang forever. Resolve on `seeked`, or after a timeout, and
  // retry once if the first attempt times out (some decoders drop the event).
  const attempt = (target: number, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
      };
      const onSeeked = () => { if (!settled) { cleanup(); resolve(true); } };
      const timer = setTimeout(() => { if (!settled) { cleanup(); resolve(false); } }, timeoutMs);
      video.addEventListener('seeked', onSeeked);
      try { video.currentTime = target; } catch { if (!settled) { cleanup(); resolve(false); } }
    });

  return (async () => {
    const dur = video.duration || t;
    const target = Math.max(0, Math.min(t, dur - 0.001));
    const ok = await attempt(target, 3000);
    if (!ok) {
      // retry with a tiny nudge
      await attempt(Math.max(0, target - 0.005), 3000);
    }
  })();
}


export async function extractFrames(
  video: HTMLVideoElement,
  opts: { maxSide?: number; maxFrames?: number; fps: number; duration: number },
  onProgress?: (frac: number, count: number) => void
): Promise<ExtractResult> {
  const vw = video.videoWidth, vh = video.videoHeight;
  const maxSide = opts.maxSide ?? 640;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const procW = Math.max(2, Math.round(vw * scale));
  const procH = Math.max(2, Math.round(vh * scale));

  const totalSourceFrames = Math.max(1, Math.round(opts.duration * opts.fps));
  const maxFrames = opts.maxFrames ?? 300;
  const frameCount = Math.min(totalSourceFrames, maxFrames);

  const canvas = document.createElement('canvas');
  canvas.width = procW; canvas.height = procH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  const frames: ImageData[] = [];
  const timestamps: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    const t = (i / Math.max(1, frameCount - 1)) * Math.max(0, opts.duration - 0.04);
    await seekTo(video, t);
    ctx.drawImage(video, 0, 0, procW, procH);
    frames.push(ctx.getImageData(0, 0, procW, procH));
    timestamps.push(t);
    onProgress?.((i + 1) / frameCount, i + 1);
  }
  return { frames, timestamps, procW, procH, fps: opts.fps, duration: opts.duration, frameCount };
}

/** Read intrinsic metadata (duration, dimensions, estimated fps) from a video file. */
export function probeVideo(file: File): Promise<{
  duration: number; width: number; height: number; fps: number; url: string; video: HTMLVideoElement;
}> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    video.onloadedmetadata = () => {
      // FPS isn't directly exposed; estimate via requestVideoFrameCallback when available,
      // else default to 30. We refine using rVFC sampling below.
      const base = {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        fps: 30,
        url, video,
      };
      // try to measure fps quickly
      const videoWithFrames = video as VideoFrameCallbackElement;
      if (typeof videoWithFrames.requestVideoFrameCallback === 'function') {
        let last = 0, count = 0, firstTime = 0;
        const cb = (_now: DOMHighResTimeStamp, meta: { mediaTime: number }) => {
          if (count === 0) firstTime = meta.mediaTime;
          last = meta.mediaTime; count++;
          if (count >= 6 || last - firstTime > 0.4) {
            const span = last - firstTime;
            const est = span > 0 ? Math.round((count - 1) / span) : 30;
            video.pause();
            resolve({ ...base, fps: est > 0 && est < 121 ? est : 30 });
          } else {
            videoWithFrames.requestVideoFrameCallback?.(cb);
          }
        };
        video.play().then(() => videoWithFrames.requestVideoFrameCallback?.(cb)).catch(() => resolve(base));
        setTimeout(() => { try { video.pause(); } catch { /* ignore pause failure */ } resolve(base); }, 1200);
      } else {
        resolve(base);
      }
    };
    video.onerror = () => reject(new Error('Could not read video metadata'));
  });
}
