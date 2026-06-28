// Re-encode processed frames into a downloadable video WITH the original audio.
// Uses canvas.captureStream + MediaRecorder. The original audio is captured from
// a parallel <video> playing the source, combined into one MediaStream so the
// exported file preserves duration, original audio, and aspect ratio.
//
// Hardened: explicit feature detection (captureStream / MediaRecorder /
// requestVideoFrameCallback), full original-resolution output, and an honest
// `hasAudio` flag so the UI never claims audio is preserved when it isn't.

export interface ExportResult {
  blob: Blob;
  url: string;
  mimeType: string;
  effectiveFps: number;
  hasAudio: boolean;
  outW: number;
  outH: number;
}

export interface ExportSupport {
  ok: boolean;
  reason?: string;
  canvasCapture: boolean;
  mediaRecorder: boolean;
}

type CanvasWithCapture = HTMLCanvasElement & {
  captureStream: (frameRate?: number) => MediaStream;
};

type VideoWithCapture = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
  requestVideoFrameCallback?: (callback: () => void) => number;
};

/** Detect whether the current browser can run the MediaRecorder export path. */
export function detectExportSupport(): ExportSupport {
  const canvasCapture =
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream === 'function';
  const mediaRecorder = typeof MediaRecorder !== 'undefined';
  if (!canvasCapture)
    return { ok: false, canvasCapture, mediaRecorder, reason: 'This browser does not support canvas.captureStream(), which is required to export the cleaned video. Try desktop Chrome, Edge, or Firefox.' };
  if (!mediaRecorder)
    return { ok: false, canvasCapture, mediaRecorder, reason: 'This browser does not support MediaRecorder, which is required to export the cleaned video. Try desktop Chrome, Edge, or Firefox.' };
  return { ok: true, canvasCapture, mediaRecorder };
}

function pickMime(): string {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    } catch { /* ignore */ }
  }
  return 'video/webm';
}

/** Extension for a download, derived from the actual recorder MIME type (NOT a blob URL). */
export function extForMime(mimeType: string): 'mp4' | 'webm' {
  return /mp4/i.test(mimeType) ? 'mp4' : 'webm';
}

/**
 * @param drawFrameAt called with the current playback time; should render the
 *        processed frame for that time onto `ctx` at the OUTPUT resolution.
 */
export async function encodeVideo(params: {
  outW: number;            // output (source) width
  outH: number;            // output (source) height
  duration: number;
  sourceUrl: string;       // original video object URL (for audio)
  fps: number;
  drawFrameAt: (time: number, ctx: CanvasRenderingContext2D) => void;
  onProgress?: (frac: number) => void;
}): Promise<ExportResult> {
  const { outW, outH, duration, sourceUrl, fps, drawFrameAt, onProgress } = params;

  const support = detectExportSupport();
  if (!support.ok) throw new Error(support.reason);

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  let canvasStream: MediaStream;
  try {
    canvasStream = (canvas as CanvasWithCapture).captureStream(fps);
  } catch (e) {
    throw new Error('Failed to capture the video canvas for export on this browser.');
  }

  // audio source video element (drives the timeline so audio+video stay in sync)
  const audioVideo = document.createElement('video');
  audioVideo.src = sourceUrl;
  audioVideo.muted = false;
  audioVideo.volume = 1;
  audioVideo.playsInline = true;
  audioVideo.crossOrigin = 'anonymous';
  await new Promise<void>((res, rej) => {
    audioVideo.onloadedmetadata = () => res();
    audioVideo.onerror = () => rej(new Error('Could not load source video for audio muxing.'));
    setTimeout(() => res(), 4000);
  });

  // Try to attach the original audio track.
  let hasAudio = false;
  let combined = canvasStream;
  try {
    const audioCapture = audioVideo as VideoWithCapture;
    const capture = audioCapture.captureStream ?? audioCapture.mozCaptureStream;
    const srcStream: MediaStream | undefined = capture ? capture.call(audioCapture) : undefined;
    const audioTracks: MediaStreamTrack[] = srcStream ? srcStream.getAudioTracks() : [];
    if (audioTracks.length) {
      combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
      hasAudio = true;
    }
  } catch { /* no audio track available -> silent export with warning */ }

  const mimeType = pickMime();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 12_000_000 });
  } catch {
    recorder = new MediaRecorder(combined);
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const realMime = recorder.mimeType || mimeType;
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: realMime }));
  });

  recorder.start(100);

  // drive the canvas from the audio video's actual playback time -> perfect sync & duration
  const playable = await audioVideo.play().then(() => true).catch(() => false);
  const videoWithTiming = audioVideo as VideoWithCapture;
  const hasRVFC = typeof videoWithTiming.requestVideoFrameCallback === 'function';
  let frameCount = 0;

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => { if (!resolved) { resolved = true; resolve(); } };
    const render = () => {
      if (resolved) return;
      const t = playable ? audioVideo.currentTime : Math.min(duration, frameCount / fps);
      drawFrameAt(t, ctx);
      frameCount++;
      onProgress?.(Math.min(1, t / duration));
      if ((playable && (audioVideo.ended || t >= duration - 0.02)) ||
          (!playable && t >= duration - 0.02)) { finish(); return; }
      if (hasRVFC) videoWithTiming.requestVideoFrameCallback?.(render);
      else requestAnimationFrame(render);
    };
    // If source can't play (e.g. autoplay blocked), still render a timed sequence.
    if (!playable) {
      const start = performance.now();
      const tick = () => {
        if (resolved) return;
        const t = Math.min(duration, (performance.now() - start) / 1000);
        drawFrameAt(t, ctx);
        frameCount++;
        onProgress?.(Math.min(1, t / duration));
        if (t >= duration - 0.02) { finish(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } else if (hasRVFC) {
      videoWithTiming.requestVideoFrameCallback?.(render);
    } else {
      requestAnimationFrame(render);
    }
    // hard safety timeout so the recorder never hangs forever
    setTimeout(finish, (duration + 3) * 1000);
  });

  try { audioVideo.pause(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 150));
  try { recorder.stop(); } catch { /* ignore */ }
  const blob = await done;
  const url = URL.createObjectURL(blob);
  const effectiveFps = duration > 0 ? frameCount / duration : fps;
  return { blob, url, mimeType: realMime, effectiveFps, hasAudio, outW, outH };
}
