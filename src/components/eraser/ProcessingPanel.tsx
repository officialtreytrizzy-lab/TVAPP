import { useState } from 'react';
import { Loader2, Download, X, Sparkles, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { EraserOutputQuality } from '@/lib/eraser/gpu';

const PHASE_LABEL: Record<string, string> = {
  awaiting_mask: 'Awaiting mask',
  mask_ready: 'Mask ready',
  segmenting: 'Segmenting',
  tracking_mask: 'Tracking object',
  smoothing_masks: 'Smoothing masks',
  inpainting: 'Inpainting',
  rebuilding_video: 'Rebuilding video',
  attaching_audio: 'Reattaching audio',
  generating_preview: 'Exporting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface Props {
  phase: string;
  progress: number;
  statusMessage: string;
  error?: string | null;
  hasMask: boolean;
  processing: boolean;
  canProcess?: boolean;
  finalUrl: string | null;
  originalUrl: string | null;
  processingMode?: string;
  outputQuality: EraserOutputQuality;
  onOutputQualityChange: (quality: EraserOutputQuality) => void;
  onProcess: () => void;
  onCancel: () => void;
  onDownload: () => void;
}

export default function ProcessingPanel({
  phase, progress, statusMessage, error, hasMask, processing, canProcess = true, finalUrl, originalUrl,
  processingMode = 'browser fallback', outputQuality, onOutputQualityChange, onProcess, onCancel, onDownload,
}: Props) {

  const [showAfter, setShowAfter] = useState(true);
  const done = phase === 'completed' && finalUrl;
  const usingGpu = /gpu/i.test(processingMode);
  const displayProgress = usingGpu && processing && phase === 'segmenting' && progress <= 22 ? 20 : progress;

  return (
    <div className="space-y-4 rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm font-semibold text-white">Processing</span>
          <p className="mt-0.5 text-xs text-slate-500">Mode: {processingMode}</p>
        </div>
        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-violet-300">
          {PHASE_LABEL[phase] ?? phase}
        </span>
      </div>

      {usingGpu && !done && !processing && (
        <div className="rounded-lg bg-slate-950/40 p-3 ring-1 ring-slate-800">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-300">Render quality</span>
            <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
              {outputQuality === 'higher' ? 'Higher quality' : 'Source quality'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              onClick={() => onOutputQualityChange('source')}
              className={`rounded-md px-3 py-2 font-medium transition ${outputQuality === 'source' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              Same quality
            </button>
            <button
              type="button"
              onClick={() => onOutputQualityChange('higher')}
              className={`rounded-md px-3 py-2 font-medium transition ${outputQuality === 'higher' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              Higher quality
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Same quality preserves the original size, frame rate, and audio. Higher quality keeps the same size and uses a cleaner export with less compression.
          </p>
        </div>
      )}

      {(processing || displayProgress > 0) && phase !== 'awaiting_mask' && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-400">
            <span>{statusMessage}</span>
            <span className="font-mono text-slate-300">{Math.round(displayProgress)}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500 transition-all duration-300"
              style={{ width: `${displayProgress}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {!done && !processing && (
        <button onClick={onProcess} disabled={!hasMask || !canProcess}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-3 font-semibold text-white shadow-lg shadow-violet-900/30 transition hover:from-violet-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-40">
          <Sparkles className="h-5 w-5" /> {usingGpu ? 'Process with GPU AI' : 'Process Video'}
        </button>
      )}
      {!hasMask && !done && !processing && canProcess && (
        <p className="text-center text-xs text-slate-500">Draw over the object you want removed to enable processing.</p>
      )}
      {!canProcess && !done && !processing && (
        <p className="text-center text-xs text-amber-400">This job is already processing. Keep this tab open.</p>
      )}

      {processing && (
        <button onClick={onCancel}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-3 font-medium text-red-300 hover:bg-slate-700">
          <X className="h-4 w-4" /> Cancel Processing
        </button>
      )}
      {processing && (
        <div className="flex items-center justify-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {usingGpu ? 'GPU worker is processing — keep this tab open.' : 'Working in your browser — keep this tab open.'}
        </div>
      )}

      {done && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm font-medium text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Object removed across the whole clip.
          </div>
          <div className="overflow-hidden rounded-lg ring-1 ring-slate-800">
            <video key={showAfter ? 'after' : 'before'} src={showAfter ? finalUrl! : (originalUrl ?? finalUrl!)}
              controls className="w-full bg-black" />
          </div>
          <div className="flex rounded-lg bg-slate-800 p-1 text-sm">
            <button onClick={() => setShowAfter(false)}
              className={`flex-1 rounded-md py-1.5 font-medium ${!showAfter ? 'bg-slate-700 text-white' : 'text-slate-400'}`}>Before</button>
            <button onClick={() => setShowAfter(true)}
              className={`flex-1 rounded-md py-1.5 font-medium ${showAfter ? 'bg-violet-600 text-white' : 'text-slate-400'}`}>After</button>
          </div>
          <button onClick={onDownload}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-500">
            <Download className="h-5 w-5" /> Download final video
          </button>
        </div>
      )}
    </div>
  );
}
