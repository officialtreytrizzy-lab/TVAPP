import { Brush, Eraser, Undo2, Redo2, Trash2, Eye, EyeOff } from 'lucide-react';

interface Props {
  erasing: boolean;
  setErasing: (v: boolean) => void;
  brushSize: number;
  setBrushSize: (n: number) => void;
  maskVisible: boolean;
  toggleMask: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  disabled?: boolean;
}

export default function Controls({
  erasing, setErasing, brushSize, setBrushSize, maskVisible, toggleMask, onUndo, onRedo, onClear, disabled,
}: Props) {
  const tool = (active: boolean) =>
    `flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
      active ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
    }`;
  const btn = 'flex items-center justify-center gap-2 rounded-lg bg-slate-800 px-3 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40';

  return (
    <div className="space-y-4 rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-800">
      <div className="flex gap-2">
        <button className={tool(!erasing)} onClick={() => setErasing(false)} disabled={disabled}>
          <Brush className="h-4 w-4" /> Brush
        </button>
        <button className={tool(erasing)} onClick={() => setErasing(true)} disabled={disabled}>
          <Eraser className="h-4 w-4" /> Erase mask
        </button>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
          <span>Brush size</span><span className="font-mono text-slate-300">{brushSize}px</span>
        </div>
        <input type="range" min={6} max={80} value={brushSize}
          onChange={(e) => setBrushSize(parseInt(e.target.value))} disabled={disabled}
          className="w-full accent-violet-500" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button className={btn} onClick={onUndo} disabled={disabled}><Undo2 className="h-4 w-4" /> Undo</button>
        <button className={btn} onClick={onRedo} disabled={disabled}><Redo2 className="h-4 w-4" /> Redo</button>
        <button className={btn} onClick={onClear} disabled={disabled}><Trash2 className="h-4 w-4" /> Clear</button>
        <button className={btn} onClick={toggleMask} disabled={disabled}>
          {maskVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {maskVisible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}
