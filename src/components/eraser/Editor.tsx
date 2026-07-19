import { useCallback, useEffect, useRef, useState } from 'react';
import UploadZone from './UploadZone';
import MaskCanvas, { type MaskCanvasHandle } from './MaskCanvas';
import Timeline from './Timeline';
import Controls from './Controls';
import ProcessingPanel from './ProcessingPanel';
import { probeVideo } from '@/lib/eraser/frames';
import { eraserApi } from '@/lib/eraser/api';
import type { PipelineOutput } from '@/lib/eraser/pipeline';
import { gpuRemovalLabel, isGpuRemovalConfigured, runGpuRemoval, type EraserOutputQuality } from '@/lib/eraser/gpu';
import { RotateCcw, ShieldCheck } from 'lucide-react';

const MAX_DURATION = 30;

// Phases where the backend job is actively crunching — Process must be blocked + set_mask skipped.
const ACTIVE_PROCESSING = new Set([
  'segmenting', 'tracking_mask', 'smoothing_masks', 'inpainting',
  'frame_extraction', 'optical_flow_tracking', 'diffusion_inpainting',
  'audio_preserving_export', 'validation',
  'rebuilding_video', 'attaching_audio', 'generating_preview',
]);
// Phases where it's safe to (re)start processing.
const PROCESS_READY = new Set(['awaiting_mask', 'mask_ready', 'failed', 'cancelled']);
type MaskResponse = Awaited<ReturnType<typeof eraserApi.setMask>> | Awaited<ReturnType<typeof eraserApi.refineMask>>;
// Errors that mean "the mask was already accepted / job already running" — never fail on these.
function isIdempotencyError(msg: string): boolean {
  return /Mask can only be set|already processing|mask already accepted/i.test(msg || '');
}


interface Meta { duration: number; width: number; height: number; fps: number; url: string; filename: string; }

export default function Editor() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const maskRef = useRef<MaskCanvasHandle | null>(null);
  const cancelRef = useRef({ cancelled: false });
  const outputRef = useRef<PipelineOutput | null>(null);
  const sourceFileRef = useRef<File | null>(null);
  // Synchronous lock — fires before setProcessing(true) renders, blocking double-tap/mobile dupes.
  const processingLockRef = useRef(false);
  const maskAnchorTimeRef = useRef<number | null>(null);

  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [erasing, setErasing] = useState(false);
  const [maskVisible, setMaskVisible] = useState(true);
  const [hasMask, setHasMask] = useState(false);
  const [outputQuality, setOutputQuality] = useState<EraserOutputQuality>('source');

  const [phase, setPhase] = useState('awaiting_mask');
  const [progress, setProgress] = useState(18);
  const [statusMessage, setStatusMessage] = useState('Scrub to a frame and draw your mask.');
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);

  const onFile = useCallback(async (file: File) => {
    setUploadError(null);
    setUploadBusy(true);
    try {
      const supported = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
      const okExt = /\.(mp4|mov|webm|m4v)$/i.test(file.name);
      if (!supported.includes(file.type) && !okExt) throw new Error('Unsupported format. Please upload MP4, MOV, or WebM.');
      const maxMb = 300;
      if (file.size > maxMb * 1024 * 1024) throw new Error(`File too large. Max ${maxMb}MB.`);

      const probed = await probeVideo(file);
      if (!probed.duration || isNaN(probed.duration)) throw new Error('Could not read video duration.');
      if (probed.duration > MAX_DURATION + 0.25) {
        URL.revokeObjectURL(probed.url);
        throw new Error(`Video is ${probed.duration.toFixed(1)}s. Maximum allowed is ${MAX_DURATION}s.`);
      }
      const frameCount = Math.round(probed.duration * probed.fps);
      const job = await eraserApi.createJob({
        fileType: file.type || 'video/mp4', duration: probed.duration, fps: probed.fps,
        width: probed.width, height: probed.height, frameCount, originalFilename: file.name,
      });
      sourceFileRef.current = file;
      setJobId(job.jobId);
      setMeta({ duration: probed.duration, width: probed.width, height: probed.height, fps: probed.fps, url: probed.url, filename: file.name });
      setPhase(job.phase);
      setProgress(job.progress);
      setStatusMessage(job.statusMessage);
    } catch (e) {
      sourceFileRef.current = null;
      setUploadError((e as Error).message);
    } finally {
      setUploadBusy(false);
    }
  }, []);

  // video time sync
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrent(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, [meta]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v || !meta) return;
    const safeTime = Math.max(0, Math.min(meta.duration, t));
    const anchorTime = maskAnchorTimeRef.current;
    if (anchorTime !== null && Math.abs(safeTime - anchorTime) > 0.5 / Math.max(meta.fps, 1)) {
      maskRef.current?.clear();
      maskAnchorTimeRef.current = null;
      setHasMask(false);
      setStatusMessage('Frame changed. Mark the object again on this exact frame.');
    }
    v.currentTime = safeTime;
    setCurrent(safeTime);
  };
  const togglePlay = () => { const v = videoRef.current; if (!v) return; if (v.paused) v.play(); else v.pause(); };
  const step = (dir: 1 | -1) => {
    if (!meta) return;
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    seek(v.currentTime + dir * (1 / meta.fps));
  };

  const refreshHasMask = () => setHasMask(maskRef.current?.hasMask() ?? false);

  const freezeMaskFrame = () => {
    const v = videoRef.current;
    if (!v || !meta) return;
    v.pause();
    const exactTime = Math.max(0, Math.min(meta.duration, v.currentTime));
    if (maskAnchorTimeRef.current === null) maskAnchorTimeRef.current = exactTime;
    v.currentTime = maskAnchorTimeRef.current;
    setCurrent(maskAnchorTimeRef.current);
    setStatusMessage(`Mask locked to frame ${Math.round(maskAnchorTimeRef.current * meta.fps)}.`);
  };

  const process = async (isRefine = false) => {
    if (!jobId || !meta || !videoRef.current || !maskRef.current) return;
    // Synchronous lock first — blocks a double-tap before setProcessing(true) renders.
    if (processingLockRef.current) return;
    const maskCanvas = maskRef.current.getMaskCanvas();
    if (!maskCanvas || !maskRef.current.hasMask()) return;
    processingLockRef.current = true;
    setError(null);
    setFinalUrl(null);
    setProcessing(true);
    cancelRef.current = { cancelled: false };
    videoRef.current.pause();
    try {
      // Sync the local job phase before touching the mask. If the job is already
      // crunching from a prior tap, do NOT set the mask again. Just adopt
      // the current state and let the existing run finish.
      try {
        const cur = await eraserApi.getJob(jobId);
        if (cur && ACTIVE_PROCESSING.has(cur.phase)) {
          setPhase(cur.phase);
          setProgress(cur.progress ?? 20);
          setStatusMessage('This job is already processing. Keep this tab open.');
          return; // finally clears the lock; the in-flight run owns completion
        }
      } catch { /* non-fatal: fall through to normal flow */ }

      const selectedTime = Math.max(0, Math.min(meta.duration, maskAnchorTimeRef.current ?? videoRef.current.currentTime));
      const selectedFrameIndex = Math.max(0, Math.round(selectedTime * meta.fps));
      const payload = { jobId, selectedFrameIndex, maskWidth: meta.width, maskHeight: meta.height };
      let maskRes: MaskResponse;
      if (isRefine) maskRes = await eraserApi.refineMask(payload);
      else maskRes = await eraserApi.setMask(payload);
      // Local state may idempotently report the job is already processing — adopt and bail.
      if (maskRes?.idempotent || (maskRes?.phase && ACTIVE_PROCESSING.has(maskRes.phase))) {
        setPhase(maskRes.phase);
        setProgress(maskRes.progress ?? 20);
        setStatusMessage('This job is already processing. Keep this tab open.');
        return;
      }
      setPhase('mask_ready');
      setProgress(20);

      const useGpu = isGpuRemovalConfigured() && !!sourceFileRef.current;
      if (!useGpu) {
        throw new Error(
          'The required frame-extraction, optical-flow, diffusion-inpainting GPU pipeline is not configured.',
        );
      }

      const out: PipelineOutput = await runGpuRemoval({
        jobId,
        file: sourceFileRef.current!,
        sourceUrl: meta.url,
        fps: meta.fps,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        selectedTime,
        selectedFrameIndex,
        maskCanvas,
        outputQuality,
        cancelRef: cancelRef.current,
        onPhase: (ph, pr, msg) => { setPhase(ph); setProgress(pr); setStatusMessage(msg); },
      });

      let savedLibraryUrl = '';
      let librarySaveError = '';
      try {
        const outputResponse = await fetch(out.localUrl || out.finalUrl);
        if (!outputResponse.ok) throw new Error(`Could not read completed video (HTTP ${outputResponse.status}).`);
        const outputBlob = await outputResponse.blob();
        if (!outputBlob.size) throw new Error('Completed video was empty.');
        savedLibraryUrl = await eraserApi.uploadOutput(jobId, outputBlob, out.mimeType);
      } catch (saveError) {
        librarySaveError = (saveError as Error).message;
        await eraserApi.progress({
          jobId,
          statusMessage: 'Video completed, but this device could not save it to Recent Jobs.',
          log: `device library save failed: ${librarySaveError}`,
        }).catch(() => undefined);
      }

      await eraserApi.complete({
        jobId,
        previewUrl: savedLibraryUrl || undefined,
        finalOutputUrl: savedLibraryUrl || undefined,
        outputMime: out.mimeType,
        audioPreserved: out.hasAudio,
      });

      const completedOutput: PipelineOutput = {
        ...out,
        finalUrl: savedLibraryUrl || out.finalUrl,
      };
      outputRef.current = completedOutput;
      setFinalUrl(completedOutput.finalUrl);
      setPhase('completed');
      setProgress(100);
      setStatusMessage(
        librarySaveError
          ? `Done, but Recent Jobs could not save this output on the device: ${librarySaveError}`
          : `Done and saved to this device's Recent Jobs library (${outputQuality === 'higher' ? 'higher quality' : 'source quality'}).`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === '__CANCELLED__') {
        await eraserApi.cancel(jobId).catch(() => {});
        setPhase('cancelled'); setStatusMessage('Processing cancelled.'); setProgress(20);
      } else if (isIdempotencyError(msg)) {
        // Duplicate set_mask / "already processing" — never kill a valid job over this.
        try {
          const cur = await eraserApi.getJob(jobId);
          if (cur) { setPhase(cur.phase); setProgress(cur.progress ?? 20); }
        } catch { /* ignore */ }
        setStatusMessage('This job is already processing. Keep this tab open.');
      } else {
        await eraserApi.transition({ jobId, to: 'failed', error: msg, statusMessage: 'Processing failed.', log: `error: ${msg}` }).catch(() => {});
        setPhase('failed'); setError(msg);
      }
    } finally {
      processingLockRef.current = false;
      setProcessing(false);
    }
  };

  const cancel = () => { cancelRef.current.cancelled = true; };

  const download = () => {
    const out = outputRef.current;
    if (!out || !meta) return;
    // Prefer the in-session blob (instant), fall back to the permanent storage URL.
    const href = out.localUrl || finalUrl || out.finalUrl;
    if (!href) return;
    const ext = /mp4/i.test(out.mimeType) ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = href;
    a.download = meta.filename.replace(/\.[^.]+$/, '') + `-erased-${outputQuality}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  const reset = () => {
    if (meta) URL.revokeObjectURL(meta.url);
    const sessionOutputUrl = outputRef.current?.localUrl;
    if (sessionOutputUrl?.startsWith('blob:') && sessionOutputUrl !== finalUrl) URL.revokeObjectURL(sessionOutputUrl);
    if (finalUrl?.startsWith('blob:')) URL.revokeObjectURL(finalUrl);
    setMeta(null); setJobId(null); setFinalUrl(null); setError(null);
    setPhase('awaiting_mask'); setProgress(18); setProcessing(false); setHasMask(false);
    sourceFileRef.current = null;
    outputRef.current = null;
    maskAnchorTimeRef.current = null;
  };

  const addKeyframe = () => {
    setStatusMessage('Drew a correction mask? Click Process again to re-run with this keyframe.');
    maskRef.current?.clear();
    maskAnchorTimeRef.current = null;
    setHasMask(false);
  };

  if (!meta) {
    return (
      <div className="mx-auto max-w-3xl">
        <UploadZone onFile={onFile} busy={uploadBusy} error={uploadError} maxDuration={MAX_DURATION} />
      </div>
    );
  }

  const ar = meta.width / meta.height;
  const editing = !processing && phase !== 'completed';
  const processingMode = gpuRemovalLabel();

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      {/* Left: video + canvas + timeline */}
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl bg-black ring-1 ring-slate-800">
          <div className="relative mx-auto w-full max-h-screen-video touch-none select-none" style={{ aspectRatio: String(ar) }}>
            <video
              ref={videoRef} src={meta.url} playsInline muted controls={false}
              disablePictureInPicture
              className="absolute inset-0 h-full w-full object-contain"
            />
            <MaskCanvas
              ref={maskRef}
              frameW={meta.width} frameH={meta.height} videoEl={videoRef.current}
              brushSize={brushSize} erasing={erasing} maskVisible={maskVisible}
              onStrokeStart={freezeMaskFrame} onStrokeEnd={refreshHasMask} disabled={!editing}
            />
          </div>
        </div>
        <Timeline
          duration={meta.duration} current={current} playing={playing} fps={meta.fps}
          onSeek={seek} onTogglePlay={togglePlay} onStep={step} onAddKeyframe={addKeyframe}
          disabled={processing}
        />
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span className="rounded bg-slate-800 px-2 py-1 font-mono">{meta.width}×{meta.height}</span>
          <span className="rounded bg-slate-800 px-2 py-1 font-mono">{Math.round(meta.fps)} fps</span>
          <span className="rounded bg-slate-800 px-2 py-1 font-mono">{meta.duration.toFixed(1)}s</span>
          <span className="rounded bg-slate-800 px-2 py-1 font-mono">{processingMode}</span>
          <button onClick={reset} className="ml-auto inline-flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-slate-300 hover:bg-slate-700">
            <RotateCcw className="h-3.5 w-3.5" /> New video
          </button>
        </div>
      </div>

      {/* Right: tools + processing */}
      <div className="space-y-4">
        <Controls
          erasing={erasing} setErasing={setErasing} brushSize={brushSize} setBrushSize={setBrushSize}
          maskVisible={maskVisible} toggleMask={() => setMaskVisible((v) => !v)}
          onUndo={() => { maskRef.current?.undo(); refreshHasMask(); }}
          onRedo={() => { maskRef.current?.redo(); refreshHasMask(); }}
          onClear={() => { maskRef.current?.clear(); maskAnchorTimeRef.current = null; refreshHasMask(); }}
          disabled={!editing}
        />
        <ProcessingPanel
          phase={phase} progress={progress} statusMessage={statusMessage} error={error}
          hasMask={hasMask} processing={processing} canProcess={PROCESS_READY.has(phase)}
          finalUrl={finalUrl} originalUrl={meta.url} processingMode={processingMode}
          outputQuality={outputQuality} onOutputQualityChange={setOutputQuality}
          onProcess={() => process(false)} onCancel={cancel} onDownload={download}
        />

        {phase === 'completed' && (
          <button onClick={() => { setPhase('awaiting_mask'); setFinalUrl(null); setProgress(20); maskRef.current?.clear(); maskAnchorTimeRef.current = null; setHasMask(false); }}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-amber-300 hover:bg-slate-700">
            Refine with another keyframe
          </button>
        )}
        <div className="flex items-start gap-2 rounded-xl bg-slate-900/50 p-3 text-xs text-slate-400 ring-1 ring-slate-800">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          Only upload videos you own or have permission to edit. This tool is for legitimate cleanup, creative editing, and object removal. Do not use it to bypass copyright, remove ownership marks from content you do not control, or misrepresent edited media.
        </div>
      </div>
    </div>
  );
}
