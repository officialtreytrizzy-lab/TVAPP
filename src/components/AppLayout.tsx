import { useEffect, useState, useCallback } from 'react';
import Editor from './eraser/Editor';
import { eraserApi, type LocalJob } from '@/lib/eraser/api';
import { Wand2, MousePointerClick, Scan, Film, Sparkles, Github, Mail, History, X, Play, HardDrive, Clapperboard, Code2 } from 'lucide-react';

const HERO = 'https://d64gsuwffb70l.cloudfront.net/6a407d389662950bf1dfa607_1782611760246_970a59e4.jpg';
const STEPS = [
  { icon: Film, title: 'Upload', body: 'Drop a clip up to 30s. We read its real FPS, duration & resolution.' },
  { icon: MousePointerClick, title: 'Scribble', body: 'Pause on a frame and brush over the object you want gone.' },
  { icon: Scan, title: 'Track', body: 'Optical-flow tracking follows the target across every frame.' },
  { icon: Wand2, title: 'Inpaint & Export', body: 'Diffusion inpainting fills the hole; export with original audio.' },
];

interface ReopenState {
  job: LocalJob;
  url: string;
}

function HistoryDrawer({ jobs, onClose, onReopen }: { jobs: LocalJob[]; onClose: () => void; onReopen: (j: LocalJob) => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto overscroll-contain bg-slate-900 p-5 pt-safe pb-safe ring-1 ring-slate-800" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-bold text-white"><History className="h-5 w-5 text-violet-400" /> Local jobs</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        {jobs.length === 0 && <p className="text-sm text-slate-400">No jobs yet. Upload a video to get started.</p>}
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li key={j.id} className="rounded-xl bg-slate-800/70 p-4 ring-1 ring-slate-700">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-white">{j.original_filename || 'video'}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${j.phase === 'completed' ? 'bg-emerald-500/20 text-emerald-300' : j.phase === 'failed' ? 'bg-red-500/20 text-red-300' : 'bg-slate-700 text-slate-300'}`}>{j.phase}</span>
              </div>
              <p className="mt-1 font-mono text-xs text-slate-500">{j.job_id.slice(0, 8)} · {new Date(j.created_at).toLocaleString()}</p>
              {j.phase === 'completed' && (j.final_output_key || j.final_output_url) && (
                <button onClick={() => onReopen(j)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500">
                  <Play className="h-3.5 w-3.5" /> Reopen preview
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function AppLayout() {
  const [year] = useState(new Date().getFullYear());
  const [showHistory, setShowHistory] = useState(false);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [reopen, setReopen] = useState<ReopenState | null>(null);
  const [reopenError, setReopenError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const rows = await eraserApi.listJobs();
    setJobs(rows);
  }, []);

  useEffect(() => {
    loadJobs();
    const onFocus = () => loadJobs();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadJobs]);

  const scrollToEditor = () => document.getElementById('editor')?.scrollIntoView({ behavior: 'smooth' });

  const reopenJob = async (job: LocalJob) => {
    setReopenError(null);
    try {
      const url = await eraserApi.resolveOutputUrl(job);
      if (!url) throw new Error('This job does not have a saved local output video.');
      setReopen({ job, url });
      setShowHistory(false);
      scrollToEditor();
    } catch (e) {
      setReopenError((e as Error).message);
    }
  };

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 pt-safe backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 px-safe">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-blue-600"><Wand2 className="h-5 w-5 text-white" /></div>
            <span className="text-lg font-bold tracking-tight">Video E<span className="text-violet-400">Treyser</span></span>
          </div>
          <div className="flex items-center gap-2">
            <a href="/api-docs" className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-slate-700 hover:bg-slate-700">
              <Code2 className="h-4 w-4" /> <span className="hidden sm:inline">API</span>
            </a>
            <a href="/studio" className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-900/30 hover:bg-violet-500">
              <Clapperboard className="h-4 w-4" /> <span className="hidden sm:inline">OpenCut</span>
            </a>
            <button onClick={() => { loadJobs(); setShowHistory(true); }} className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700">
              <History className="h-4 w-4" /> <span className="hidden sm:inline">Local jobs</span>
            </button>
            <span className="hidden items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/20 sm:flex">
              <HardDrive className="h-3.5 w-3.5" /> One-folder mode
            </span>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <img src={HERO} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/60 via-slate-950/80 to-slate-950" />
        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:py-28 text-center">
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-xs font-medium text-violet-200"><Sparkles className="h-3.5 w-3.5" /> Real in-browser object removal plus protected API access</div>
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-6xl">Erase anything from your <span className="bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent">video</span></h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-300">Scribble over an unwanted person, logo, or object on a single frame. The app tracks it through the whole clip, inpaints the gap, exports a clean video, and exposes protected API endpoints for developers.</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button onClick={scrollToEditor} className="rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 px-7 py-3.5 text-base font-semibold text-white shadow-lg shadow-violet-900/40 hover:from-violet-500 hover:to-blue-500">Upload a video</button>
            <a href="/studio" className="rounded-xl bg-slate-800 px-7 py-3.5 text-base font-semibold text-white ring-1 ring-slate-700 hover:bg-slate-700">Open mobile editor</a>
            <a href="/api-docs" className="rounded-xl bg-slate-900 px-7 py-3.5 text-base font-semibold text-white ring-1 ring-violet-500/40 hover:bg-slate-800">View API docs</a>
            <span className="text-sm text-slate-400">Use the UI here or integrate with the Trey Video API from your own app.</span>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <div key={s.title} className="rounded-2xl bg-slate-900/60 p-5 ring-1 ring-slate-800">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600/20 text-violet-300"><s.icon className="h-5 w-5" /></div>
              <div className="mb-1 text-xs font-mono text-slate-500">0{i + 1}</div>
              <h3 className="font-semibold text-white">{s.title}</h3>
              <p className="mt-1 text-sm text-slate-400">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="editor" className="mx-auto max-w-6xl px-4 pb-20">
        <div className="mb-6 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">Video Eraser</h2>
          <p className="mt-2 text-slate-400">Upload a clip, draw your mask, and remove the target across the entire video.</p>
        </div>
        {reopenError && (
          <div className="mb-6 rounded-2xl border border-red-700/40 bg-red-500/10 p-4 text-sm text-red-300">
            {reopenError}
          </div>
        )}
        {reopen && (
          <div className="mb-6 rounded-2xl border border-violet-700/40 bg-slate-900/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-medium text-white">Reopened: {reopen.job.original_filename || reopen.job.job_id.slice(0, 8)}</span>
              <button onClick={() => { URL.revokeObjectURL(reopen.url); setReopen(null); }} className="text-slate-400 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <video src={reopen.url} controls className="w-full rounded-lg bg-black" />
          </div>
        )}
        <div className="rounded-3xl border border-slate-800 bg-slate-900/30 p-4 sm:p-6"><Editor /></div>
      </section>

      <footer className="border-t border-slate-800 bg-slate-950">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-2"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-blue-600"><Wand2 className="h-4 w-4 text-white" /></div><span className="font-bold">Video ETreyser</span></div>
            <p className="mt-3 text-sm text-slate-400">Video object removal that runs from one local app folder and exposes a protected API.</p>
          </div>
          <div><h4 className="mb-3 text-sm font-semibold text-white">Pipeline</h4><ul className="space-y-2 text-sm text-slate-400"><li>Frame extraction</li><li>Optical-flow tracking</li><li>Diffusion inpainting</li><li>Audio-preserving export</li></ul></div>
          <div><h4 className="mb-3 text-sm font-semibold text-white">Specs</h4><ul className="space-y-2 text-sm text-slate-400"><li>MP4 · MOV · WebM</li><li>Up to 30 seconds</li><li>Original FPS & audio</li><li>Aspect ratio preserved</li></ul></div>
          <div><h4 className="mb-3 text-sm font-semibold text-white">Studio</h4><div className="flex gap-3 text-slate-400"><a href="/studio" className="rounded-lg bg-slate-900 p-2 hover:text-white"><Clapperboard className="h-4 w-4" /></a><a href="/api-docs" className="rounded-lg bg-slate-900 p-2 hover:text-white"><Code2 className="h-4 w-4" /></a><a href="#" className="rounded-lg bg-slate-900 p-2 hover:text-white"><Github className="h-4 w-4" /></a><a href="#" className="rounded-lg bg-slate-900 p-2 hover:text-white"><Mail className="h-4 w-4" /></a></div></div>
        </div>
        <div className="border-t border-slate-800 px-4 py-5 pb-safe text-center text-xs text-slate-500">© {year} Video ETreyser. Only edit videos you own or have permission to edit.</div>
      </footer>

      {showHistory && <HistoryDrawer jobs={jobs} onClose={() => setShowHistory(false)} onReopen={reopenJob} />}
    </div>
  );
}
