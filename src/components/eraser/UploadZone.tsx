import { useRef, useState } from 'react';
import { UploadCloud, Film, Loader2 } from 'lucide-react';

interface Props {
  onFile: (file: File) => void;
  busy?: boolean;
  error?: string | null;
  maxDuration: number;
}

const ACCEPT = '.mp4,.mov,.webm,video/mp4,video/quicktime,video/webm';

export default function UploadZone({ onFile, busy, error, maxDuration }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const handle = (file?: File | null) => { if (file) onFile(file); };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files?.[0]); }}
      onClick={() => !busy && inputRef.current?.click()}
      className={`relative cursor-pointer rounded-2xl border-2 border-dashed p-10 sm:p-16 text-center transition
        ${drag ? 'border-violet-400 bg-violet-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-violet-500/60 hover:bg-slate-900/70'}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => handle(e.target.files?.[0])}
      />
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-blue-600 shadow-lg shadow-violet-900/40">
        {busy ? <Loader2 className="h-8 w-8 animate-spin text-white" /> : <UploadCloud className="h-8 w-8 text-white" />}
      </div>
      <h3 className="mt-5 text-xl font-bold text-white">
        {busy ? 'Reading your video...' : 'Drop a video or click to upload'}
      </h3>
      <p className="mt-2 text-sm text-slate-400">
        MP4, MOV or WebM &middot; up to {maxDuration} seconds
      </p>
      <div className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-800/80 px-4 py-2 text-xs text-slate-300">
        <Film className="h-4 w-4 text-violet-400" />
        Original audio, FPS &amp; aspect ratio preserved
      </div>
      {error && (
        <p className="mt-5 rounded-lg bg-red-500/10 px-4 py-3 text-sm font-medium text-red-300">{error}</p>
      )}
    </div>
  );
}
