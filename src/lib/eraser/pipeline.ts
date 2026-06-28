// Orchestrates the REAL in-browser object-removal pipeline and drives the
// one-folder local job state machine with real progress at each phase.
import { extractFrames } from './frames';
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
  c.width = procW; c.height = procH;
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

  // mask_ready -> segmenting (build clean binary mask from scribble)
  guard();
  await step(jobId, 'segmenting', 24, 'Segmenting object from your scribble...', 'segmenting: scribble -> binary mask', onPhase);

  // extract frames at a higher working resolution (better fills) while staying tractable.
  const ext = await extractFrames(
    video,
    { fps, duration, maxSide: 960, maxFrames: 300 },
    (frac) => onPhase?.('segmenting', 24 + frac * 6, `Extracting frames (${Math.round(frac * 100)}%)...`)
  );

  guard();
  const { frames, timestamps, procW, procH, frameCount } = ext;

  // map selected time to nearest extracted frame
  let keyIndex = 0, bestDt = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const dt = Math.abs(timestamps[i] - selectedTime);
    if (dt < bestDt) { bestDt = dt; keyIndex = i; }
  }
  const keyMask = rasterizeMask(maskCanvas, procW, procH);
  await eraserApi.progress({ jobId, progress: 32, statusMessage: 'Object segmented on keyframe.', log: `keyframe=${keyIndex} mask px=${keyMask.reduce((a, b) => a + b, 0)}` });

  // segmenting -> tracking_mask
  guard();
  await step(jobId, 'tracking_mask', 36, 'Tracking object across all frames...', 'tracking_mask: optical-flow propagation', onPhase);
  const { masks, confidence } = trackMask(frames, keyIndex, keyMask, (frac) =>
    onPhase?.('tracking_mask', 36 + frac * 12, `Tracking object (${Math.round(frac * 100)}%)...`)
  );
  guard();
  // Flag low-confidence ranges so the UI can ask for a correction keyframe instead
  // of blindly erasing the wrong area.
  const lowConfidenceFrames: number[] = [];
  for (let i = 0; i < confidence.length; i++) {
    const m = masks[i];
    const masked = !!m && m.some((v) => v === 1);
    if (masked && confidence[i] < 0.45) lowConfidenceFrames.push(i);
  }

  const lcLog = lowConfidenceFrames.length
    ? `low tracking confidence on ${lowConfidenceFrames.length} frame(s), first @ frame ${lowConfidenceFrames[0]}`
    : 'tracking confidence OK on all masked frames';
  await eraserApi.progress({ jobId, progress: 50, statusMessage: 'Object tracked through clip.', log: `tracked ${masks.length} frames; ${lcLog}` });
  if (lowConfidenceFrames.length) {
    onPhase?.('tracking_mask', 50, `Tracking confidence dropped around frame ${lowConfidenceFrames[0]}. Consider adding another keyframe after preview.`);
  }


  // tracking_mask -> smoothing_masks
  await step(jobId, 'smoothing_masks', 52, 'Smoothing masks over time...', 'smoothing_masks: temporal smoothing + feather', onPhase);
  const smoothed = smoothMasks(masks, procW, procH);
  guard();

  // smoothing_masks -> inpainting
  await step(jobId, 'inpainting', 54, 'Inpainting removed region across frames...', 'inpainting: PDE/diffusion fill', onPhase);
  const inpaintedFrames: ImageData[] = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    guard();
    const src = frames[i];
    const copy = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    const m = smoothed[i];
    const hasMask = m.some((v) => v === 1);
    if (hasMask) inpaint(copy, m, { iterations: 50, feather: 3 });
    inpaintedFrames[i] = copy;
    const frac = (i + 1) / frameCount;
    const p = 54 + frac * 26;
    if (i % 5 === 0 || i === frameCount - 1) {
      await eraserApi.progress({ jobId, progress: p, statusMessage: `Inpainting frames (${i + 1}/${frameCount})...`, log: i === frameCount - 1 ? `inpainted ${frameCount} frames` : undefined });
    }
    onPhase?.('inpainting', p, `Inpainting frames (${i + 1}/${frameCount})...`);
  }

  // temporal flicker reduction: blend each inpainted-masked pixel with neighbours
  for (let i = 1; i < frameCount - 1; i++) {
    const m = smoothed[i];
    const a = inpaintedFrames[i - 1].data, b = inpaintedFrames[i].data, c = inpaintedFrames[i + 1].data;
    for (let p = 0; p < procW * procH; p++) {
      if (!m[p]) continue;
      const o = p * 4;
      b[o] = (a[o] + 2 * b[o] + c[o]) / 4;
      b[o + 1] = (a[o + 1] + 2 * b[o + 1] + c[o + 1]) / 4;
      b[o + 2] = (a[o + 2] + 2 * b[o + 2] + c[o + 2]) / 4;
    }
  }

  // inpainting -> rebuilding_video
  guard();
  await step(jobId, 'rebuilding_video', 82, 'Rebuilding video from processed frames...', 'rebuilding_video: encode at original FPS', onPhase);

  // Output at the ORIGINAL source resolution (no silent downgrade). We render each
  // processed (proc-res) frame onto a small buffer, then scale it up to the source
  // dimensions on the export canvas, preserving the original aspect ratio.
  const outW = video.videoWidth || procW;
  const outH = video.videoHeight || procH;
  const procBuf = document.createElement('canvas');
  procBuf.width = procW; procBuf.height = procH;
  const procCtx = procBuf.getContext('2d')!;

  const drawFrameAt = (time: number, ctx: CanvasRenderingContext2D) => {
    let idx = 0, best = Infinity;
    for (let i = 0; i < timestamps.length; i++) {
      const dt = Math.abs(timestamps[i] - time);
      if (dt < best) { best = dt; idx = i; }
    }
    procCtx.putImageData(inpaintedFrames[idx], 0, 0);
    // scale proc frame up to source resolution (aspect ratio identical -> no distortion)
    ctx.drawImage(procBuf, 0, 0, procW, procH, 0, 0, outW, outH);
  };

  // attaching_audio + generating_preview happen inside encode (audio muxed in)
  await step(jobId, 'attaching_audio', 90, 'Reattaching original audio...', 'attaching_audio: muxing source audio track', onPhase);
  await step(jobId, 'generating_preview', 94, 'Generating preview & final export...', 'generating_preview: MediaRecorder mux', onPhase);

  const enc = await encodeVideo({
    outW, outH, duration, sourceUrl, fps,
    drawFrameAt,
    onProgress: (frac) => onPhase?.('generating_preview', 94 + frac * 3, `Exporting (${Math.round(frac * 100)}%)...`),
  });
  guard();

  await eraserApi.progress({ jobId, progress: 97, statusMessage: 'Saving cleaned video locally...', log: `encoded ${outW}x${outH} mime=${enc.mimeType} audio=${enc.hasAudio ? 'yes' : 'no'}` });

  // Persist the REAL file into IndexedDB so the result survives a refresh in this browser.
  // The tab-local blob URL is kept only for instant in-session preview/download.
  let savedUrl = '';
  try {
    savedUrl = await eraserApi.uploadOutput(jobId, enc.blob, enc.mimeType);
  } catch (e) {
    // If local save fails, fall back to the blob URL for this session but log it.
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
    outW, outH,
    effectiveFps: enc.effectiveFps,
    frameCount, procW, procH,
    lowConfidenceFrames,
    inpaintedFrames, originalFrames: frames, timestamps, confidence,
  };
}

