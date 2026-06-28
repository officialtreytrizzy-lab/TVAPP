import { Play, Pause, SkipBack, SkipForward, MapPin } from 'lucide-react';

interface Props {
  duration: number;
  current: number;
  playing: boolean;
  fps: number;
  onSeek: (t: number) => void;
  onTogglePlay: () => void;
  onStep: (dir: 1 | -1) => void;
  onAddKeyframe: () => void;
  disabled?: boolean;
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export default function Timeline({ duration, current, playing, fps, onSeek, onTogglePlay, onStep, onAddKeyframe, disabled }: Props) {
  return (
    <div className="rounded-xl bg-slate-900/70 p-3 sm:p-4 ring-1 ring-slate-800">
      <div className="flex items-center gap-2 sm:gap-3">
        <button onClick={() => onStep(-1)} disabled={disabled} title="Previous frame"
          className="rounded-lg bg-slate-800 p-2.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40">
          <SkipBack className="h-4 w-4" />
        </button>
        <button onClick={onTogglePlay} disabled={disabled} title={playing ? 'Pause' : 'Play'}
          className="rounded-lg bg-violet-600 p-2.5 text-white hover:bg-violet-500 disabled:opacity-40">
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button onClick={() => onStep(1)} disabled={disabled} title="Next frame"
          className="rounded-lg bg-slate-800 p-2.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40">
          <SkipForward className="h-4 w-4" />
        </button>

        <div className="ml-1 flex-1">
          <input
            type="range" min={0} max={Math.max(0.001, duration)} step={1 / Math.max(1, fps)}
            value={current} disabled={disabled}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="w-full accent-violet-500"
          />
        </div>

        <div className="hidden sm:block font-mono text-xs text-slate-300 tabular-nums">
          {fmt(current)} <span className="text-slate-500">/ {fmt(duration)}</span>
        </div>
        <button onClick={onAddKeyframe} disabled={disabled} title="Add correction keyframe"
          className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2.5 text-xs font-medium text-amber-300 hover:bg-slate-700 disabled:opacity-40">
          <MapPin className="h-4 w-4" /> <span className="hidden md:inline">Keyframe</span>
        </button>
      </div>
      <div className="mt-2 sm:hidden text-center font-mono text-xs text-slate-300 tabular-nums">
        {fmt(current)} / {fmt(duration)}
      </div>
    </div>
  );
}
