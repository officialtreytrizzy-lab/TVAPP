// Orchestrates the REAL in-browser object-removal pipeline and drives the
// one-folder local job state machine with real progress at each phase.
// Precision mode: keep user masks tight, track only selected pixels, and avoid temporal blur smearing.
import { extractFrames } from './frames';
import { expandScribbleToObjectMask, countMaskPixels } from './segment';
import { trackMask, smoothMasks } from './track';
import { inpaint, type Mask } from './inpaint';
import { encodeVideo } from './exporter';
import { eraserApi } from './api';

export interface PipelineInput {
  jobId: string;
  video: HTMLVideoElement;
  sourceUrl: string;
  fps: number;
  duration: number;
  selectedTime: number; // seconds where user drew the mask
  // offscreen canvas at intrinsic frame resolution with the user's mask painted (alpha>0 = remove)
  maskCanvas: HTMLCanvasElement;
  cancelRef: { cancelled: boolean };
  onPhase?: (phase: string, progress: number, msg: string) => void;
}

export interface PipelineOutput {
  finalUrl: string;       // permanent storage URL (refresh/cross-device safe)
  localUrl: string;       // in-session blob URL for instant preview/download
  outputBlob?: Blob;      // already-downloaded result, reused for durable device storage
  mimeType: string;       // real recorder MIME (drives download extension)
  hasAudio: boolean;      // honest: was original audio actually muxed in
  outW: number;           // exported (source) width
  outH: number;           // exported (source) height
  effectiveFps: number;
  frameCount: number;
  procW: number;
  procH: number;
  lowConfidenceFrames: number[]; // frame indices where tracking confidence dropped
  // processed (inpainted) frames + timestamps kept for preview / refine
  inpaintedFrames: ImageData[];
  originalFrames: ImageData[];
  timestamps: number[];
  confidence: number[];
}

function rasterizeMask(maskCanvas: HTMLCanvasElement, procW: number, procH: number): Mask {
  const c = document.createElement('canvas');
  c.width = procW;
  c.height = procH;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(maskCanvas, 0, 0, procW, procH);
  const d = ctx.getImageData(0, 0, procW, procH).data;
  const mask = new Uint8Array(procW * procH);
  for (let i = 0; i < procW * procH; i++) mask[i] = d[i * 4 + 3] > 40 ? 1 : 0;
  return mask;
}

async function step(jobId: string, to: string, progress: number, msg: string, log: string, onPhase?: PipelineInput['onPhase']) {
  await eraserApi.transition({ jobId, to, progress, statusMessage: msg, log });
  onPhase?.(to, progress, msg);
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { jobId, video, sourceUrl, fps, duration, selectedTime, maskCanvas, cancelRef, onPhase } = input;
  const guard = () => { if (cancelRef.cancelled) throw new Error('__CANCELLED__'); };

  guard();
  await step(jobId, 'segmenting', 24, 'Preparing tight object mask from your mark...', 'segmenting: tight user mask -> selected target', onPhase);

  const ext = await extractFrames(
    video,
    { fps, duration, maxSide: 960, maxFrames: 300 },
    (frac) => onPhase?.('segmenting', 24 + frac * 6, `Extracting frames (${Math.round(frac * 100)}%)...`)
  );

  guard();
  const { frames, timestamps, procW, procH, frameCount } = ext;

  let keyIndex = 0;
  let bestDt = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const dt = Math.abs(timestamps[i] - selectedTime);
    if (dt < bestDt) {
      bestDt = dt;
      keyIndex = i;
    }
  }

  const scribbleMask = rasterizeMask(maskCanvas, procW, procH);
  const scribblePx = countMaskPixels(scribbleMask);
  const keyMask = expandScribbleToObjectMask(frames[keyIndex], scribbleMask);
  const keyMaskPx = countMaskPixels(keyMask);
  const maxSafeMaskPx = Math.max(keyMaskPx * 3, Math.round(procW * procH * 0.012));

  await eraserApi.progress({
    jobId,
    progress: 32,
    statusMessage: 'Tight mask built on keyframe.',
    log: `keyframe=${keyIndex} scribble px=${scribblePx} tight mask px=${keyMaskPx} max safe px=${maxSafeMaskPx}`,
  });

  guard();
  await step(jobId, 'tracking_mask', 36, 'Tracking only the pixels you selected...', 'tracking_mask: selected-pixel matching', onPhase);
  const { masks, confidence } = trackMask(frames, keyIndex, keyMask, (frac) =>
    onPhase?.('tracking_mask', 36 + frac * 12, `Tracking selected pixels (${Math.round(frac * 100)}%)...`)
  );
  guard();

  const lowConfidenceFrames: number[] = [];
  for (let i = 0; i < confidence.length; i++) {
    const m = masks[i];
    const masked = !!m && m.some((v) => v === 1);
    if (masked && confidence[i] < 0.45) lowConfidenceFrames.push(i);
  }

  const lcLog = lowConfidenceFrames.length
    ? `low tracking confidence on ${lowConfidenceFrames.length} frame(s), first @ frame ${lowConfidenceFrames[0]}`
    : 'tracking confidence OK on all masked frames';
  await eraserApi.progress({ jobId, progress: 50, statusMessage: 'Selected target tracked through clip.', log: `tracked ${masks.length} frames; ${lcLog}` });
  if (lowConfidenceFrames.length) {
    onPhase?.('tracking_mask', 50, `Tracking confidence dropped around frame ${lowConfidenceFrames[0]}. Add another keyframe if the preview misses the target.`);
  }

  await step(jobId, 'smoothing_masks', 52, 'Checking for tiny mask gaps...', 'smoothing_masks: minimal temporal gap fill', onPhase);
  const smoothed = smoothMasks(masks, procW, procH);
  guard();

  await step(jobId, 'inpainting', 54, 'Filling the selected pixels without extra blur...', 'inpainting: tight fill no temporal smear', onPhase);
  const inpaintedFrames: ImageData[] = new Array(frameCount);
  let skippedOversizedMasks = 0;
  for (let i = 0; i < frameCount; i++) {
    guard();
    const src = frames[i];
    const copy = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    const m = smoothed[i];
    const maskPx = countMaskPixels(m);
    if (maskPx > 0 && maskPx <= maxSafeMaskPx) {
      inpaint(copy, m, { iterations: 16, feather: 1, grow: 0 });
    } else if (maskPx > maxSafeMaskPx) {
      skippedOversizedMasks++;
    }
    inpaintedFrames[i] = copy;
    const frac = (i + 1) / frameCount;
    const p = 54 + frac * 26;
    if (i % 5 === 0 || i === frameCount - 1) {
      await eraserApi.progress({
        jobId,
        progress: p,
        statusMessage: `Inpainting frames (${i + 1}/${frameCount})...`,
        log: i === frameCount - 1 ? `inpainted ${frameCount} frames; skipped oversized masks=${skippedOversizedMasks}` : undefined,
      });
    }
    onPhase?.('inpainting', p, `Inpainting frames (${i + 1}/${frameCount})...`);
  }

  // Do not temporally blend inpainted pixels. Averaging neighbouring frames made
  // the cleaned area look like a visible moving blur/smear.

  guard();
  await step(jobId, 'rebuilding_video', 82, 'Rebuilding video from processed frames...', 'rebuilding_video: encode at original FPS', onPhase);

  const outW = video.videoWidth || procW;
  const outH = video.videoHeight || procH;
  const procBuf = document.createElement('canvas');
  procBuf.width = procW;
  procBuf.height = procH;
  const procCtx = procBuf.getContext('2d')!;

  const drawFrameAt = (time: number, ctx: CanvasRenderingContext2D) => {
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < timestamps.length; i++) {
      const dt = Math.abs(timestamps[i] - time);
      if (dt < best) {
        best = dt;
        idx = i;
      }
    }
    procCtx.putImageData(inpaintedFrames[idx], 0, 0);
    ctx.drawImage(procBuf, 0, 0, procW, procH, 0, 0, outW, outH);
  };

  await step(jobId, 'attaching_audio', 90, 'Reattaching original audio...', 'attaching_audio: muxing source audio track', onPhase);
  await step(jobId, 'generating_preview', 94, 'Generating preview & final export...', 'generating_preview: MediaRecorder mux', onPhase);

  const enc = await encodeVideo({
    outW,
    outH,
    duration,
    sourceUrl,
    fps,
    drawFrameAt,
    onProgress: (frac) => onPhase?.('generating_preview', 94 + frac * 3, `Exporting (${Math.round(frac * 100)}%)...`),
  });
  guard();

  await eraserApi.progress({ jobId, progress: 97, statusMessage: 'Saving cleaned video locally...', log: `encoded ${outW}x${outH} mime=${enc.mimeType} audio=${enc.hasAudio ? 'yes' : 'no'}` });

  let savedUrl = '';
  try {
    savedUrl = await eraserApi.uploadOutput(jobId, enc.blob, enc.mimeType);
  } catch (e) {
    await eraserApi.progress({ jobId, statusMessage: 'Cleaned video ready (local save failed; session-only URL).', log: `local output save failed: ${(e as Error).message}` });
  }

  const persistentUrl = savedUrl || enc.url;
  await eraserApi.complete({
    jobId,
    previewUrl: persistentUrl,
    finalOutputUrl: savedUrl || undefined,
    outputMime: enc.mimeType,
    audioPreserved: enc.hasAudio,
  });
  onPhase?.('completed', 100, enc.hasAudio ? 'Done!' : 'Done — original audio could not be captured; exported silent.');

  return {
    finalUrl: persistentUrl,
    localUrl: enc.url,
    mimeType: enc.mimeType,
    hasAudio: enc.hasAudio,
    outW,
    outH,
    effectiveFps: enc.effectiveFps,
    frameCount,
    procW,
    procH,
    lowConfidenceFrames,
    inpaintedFrames,
    originalFrames: frames,
    timestamps,
    confidence,
  };
}
