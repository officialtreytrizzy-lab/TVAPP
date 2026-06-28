import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Captions,
  Check,
  Copy,
  Download,
  Film,
  Gauge,
  Layers,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  Scissors,
  Sparkles,
  SplitSquareHorizontal,
  Trash2,
  Type,
  Upload,
  Volume2,
} from 'lucide-react';
import type { OpenCutClip, OpenCutProject, OpenCutTextLayer } from '@/lib/opencut/types';
import { exportOpenCutRender } from '@/lib/opencut/export';
import { formatTime, makeTimelineThumbs, probeOpenCutVideo, uid } from '@/lib/opencut/video';

type Tool = 'trim' | 'split' | 'text' | 'audio' | 'speed' | 'effects' | 'export';

const TOOLS: Array<{ id: Tool; label: string; icon: typeof Scissors }> = [
  { id: 'trim', label: 'Trim', icon: Scissors },
  { id: 'split', label: 'Split', icon: SplitSquareHorizontal },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'audio', label: 'Audio', icon: Music2 },
  { id: 'speed', label: 'Speed', icon: Gauge },
  { id: 'effects', label: 'FX', icon: Sparkles },
  { id: 'export', label: 'Export', icon: Download },
];

const ASPECTS: Array<OpenCutProject['aspect']> = ['9:16', '1:1', '16:9', 'original'];

const FIRST_RUN_STEPS = [
  { icon: Film, title: 'Import your clip', body: 'Start with one vertical video, screen recording, or mobile camera take.' },
  { icon: Scissors, title: 'Shape the moment', body: 'Trim, split, add captions, adjust speed, and keep everything touch-friendly.' },
  { icon: Download, title: 'Export for socials', body: 'Render a clean mobile cut without leaving the Safari editor.' },
];

const QUALITY_CHIPS = ['9:16 ready', 'Safe-area tuned', 'Tap-first controls'];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function aspectClass(aspect: OpenCutProject['aspect'], clip?: OpenCutClip) {
  if (aspect === '9:16') return 'aspect-[9/16]';
  if (aspect === '1:1') return 'aspect-square';
  if (aspect === '16:9') return 'aspect-video';
  if (clip && clip.width && clip.height) return clip.width > clip.height ? 'aspect-video' : 'aspect-[9/16]';
  return 'aspect-[9/16]';
}

export default function MobileOpenCutStudio() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [project, setProject] = useState<OpenCutProject>({
    id: uid('project'),
    name: 'Untitled Cut',
    aspect: '9:16',
    clips: [],
    textLayers: [],
  });
  const [tool, setTool] = useState<Tool>('trim');
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const selectedClip = useMemo(() => {
    return project.clips.find((clip) => clip.id === project.selectedClipId) ?? project.clips[0];
  }, [project.clips, project.selectedClipId]);

  const selectedText = useMemo(() => {
    return project.textLayers.find((layer) => layer.id === selectedTextId) ?? project.textLayers[0];
  }, [project.textLayers, selectedTextId]);

  const activeTool = TOOLS.find((item) => item.id === tool) ?? TOOLS[0];
  const ActiveToolIcon = activeTool.icon;
  const clipDuration = selectedClip ? selectedClip.end - selectedClip.start : 0;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const t = video.currentTime;
      setCurrent(t);
      if (selectedClip && t >= selectedClip.end) {
        video.pause();
        setPlaying(false);
        video.currentTime = selectedClip.start;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [selectedClip]);

  useEffect(() => {
    if (!selectedClip || !videoRef.current) return;
    videoRef.current.src = selectedClip.url;
    videoRef.current.currentTime = selectedClip.start;
    setCurrent(selectedClip.start);
    makeTimelineThumbs(selectedClip.url, 14).then(setThumbs).catch(() => setThumbs([]));
  }, [selectedClip?.id]);

  const importFile = async (file: File) => {
    setExportError(null);
    if (!/video\//i.test(file.type) && !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
      setExportError('Upload an MP4, MOV, WebM, or M4V video.');
      return;
    }
    const meta = await probeOpenCutVideo(file);
    const clip: OpenCutClip = {
      id: uid('clip'),
      name: file.name.replace(/\.[^.]+$/, '') || 'Video clip',
      url: meta.url,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      start: 0,
      end: meta.duration,
      speed: 1,
      volume: 1,
    };
    setProject((prev) => ({
      ...prev,
      name: prev.name === 'Untitled Cut' ? clip.name : prev.name,
      clips: [clip],
      selectedClipId: clip.id,
    }));
    setTool('trim');
  };

  const updateClip = (patch: Partial<OpenCutClip>) => {
    if (!selectedClip) return;
    setProject((prev) => ({
      ...prev,
      clips: prev.clips.map((clip) => (clip.id === selectedClip.id ? { ...clip, ...patch } : clip)),
    }));
  };

  const seekTo = (time: number) => {
    if (!selectedClip || !videoRef.current) return;
    const t = clamp(time, selectedClip.start, selectedClip.end);
    videoRef.current.currentTime = t;
    setCurrent(t);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || !selectedClip) return;
    if (video.paused) {
      if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start;
      video.playbackRate = selectedClip.speed;
      video.volume = selectedClip.volume;
      void video.play();
    } else {
      video.pause();
    }
  };

  const splitAtPlayhead = () => {
    if (!selectedClip) return;
    const t = clamp(current, selectedClip.start + 0.15, selectedClip.end - 0.15);
    const left: OpenCutClip = { ...selectedClip, id: uid('clip'), name: `${selectedClip.name} A`, end: t };
    const right: OpenCutClip = { ...selectedClip, id: uid('clip'), name: `${selectedClip.name} B`, start: t };
    setProject((prev) => ({
      ...prev,
      clips: prev.clips.flatMap((clip) => (clip.id === selectedClip.id ? [left, right] : [clip])),
      selectedClipId: right.id,
    }));
    setTool('trim');
  };

  const duplicateClip = () => {
    if (!selectedClip) return;
    const copy: OpenCutClip = { ...selectedClip, id: uid('clip'), name: `${selectedClip.name} copy` };
    setProject((prev) => ({ ...prev, clips: [...prev.clips, copy], selectedClipId: copy.id }));
  };

  const deleteClip = () => {
    if (!selectedClip) return;
    setProject((prev) => {
      const remaining = prev.clips.filter((clip) => clip.id !== selectedClip.id);
      return { ...prev, clips: remaining, selectedClipId: remaining[0]?.id };
    });
  };

  const addText = () => {
    if (!selectedClip) return;
    const layer: OpenCutTextLayer = {
      id: uid('text'),
      text: 'Tap to edit',
      start: selectedClip.start,
      end: selectedClip.end,
      x: 50,
      y: 78,
      size: 34,
      weight: 800,
      color: '#ffffff',
      background: true,
    };
    setProject((prev) => ({ ...prev, textLayers: [...prev.textLayers, layer] }));
    setSelectedTextId(layer.id);
    setTool('text');
  };

  const updateText = (patch: Partial<OpenCutTextLayer>) => {
    if (!selectedText) return;
    setProject((prev) => ({
      ...prev,
      textLayers: prev.textLayers.map((layer) => (layer.id === selectedText.id ? { ...layer, ...patch } : layer)),
    }));
  };

  const removeText = () => {
    if (!selectedText) return;
    setProject((prev) => ({ ...prev, textLayers: prev.textLayers.filter((layer) => layer.id !== selectedText.id) }));
    setSelectedTextId(null);
  };

  const saveProject = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-opencut-project.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportVideo = async () => {
    if (!selectedClip) return;
    setExporting(true);
    setExportError(null);
    setExportProgress(0);
    try {
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      const target = project.aspect === '16:9' ? { w: 1280, h: 720 } : project.aspect === '1:1' ? { w: 1080, h: 1080 } : project.aspect === 'original' && selectedClip.width > selectedClip.height ? { w: 1280, h: 720 } : { w: 1080, h: 1920 };
      const rendered = await exportOpenCutRender({
        clip: selectedClip,
        textLayers: project.textLayers,
        width: target.w,
        height: target.h,
        fps: 30,
        onProgress: setExportProgress,
      });
      setExportUrl(rendered.url);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const downloadExport = () => {
    if (!exportUrl) return;
    const a = document.createElement('a');
    a.href = exportUrl;
    a.download = `${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-mobile-cut.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const onFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importFile(file);
    event.currentTarget.value = '';
  };

  return (
    <div className="min-h-dvh overflow-x-hidden bg-[#03030a] text-white pb-safe">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-90"
        style={{
          background:
            'radial-gradient(circle at 50% -10%, rgba(168, 85, 247, 0.32), transparent 34%), radial-gradient(circle at 110% 18%, rgba(37, 99, 235, 0.22), transparent 28%), linear-gradient(180deg, #03030a 0%, #080817 52%, #03030a 100%)',
        }}
      />

      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#050510]/85 pt-safe backdrop-blur-2xl">
        <div className="mx-auto flex h-16 max-w-[430px] items-center gap-3 px-4 px-safe">
          <a aria-label="Back to home" href="/" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/[0.08] text-white ring-1 ring-white/10 active:scale-95">
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div className="min-w-0 flex-1">
            <input
              aria-label="Project name"
              value={project.name}
              onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))}
              className="w-full truncate bg-transparent text-[15px] font-black tracking-tight text-white outline-none placeholder:text-white/30"
            />
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold text-white/50">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.9)]" />
              iPhone Studio
            </div>
          </div>
          <button onClick={saveProject} className="rounded-full bg-white/[0.09] px-3 py-2 text-xs font-bold text-white ring-1 ring-white/10 active:scale-95">Save</button>
          <button onClick={() => setTool('export')} className="rounded-full bg-white px-4 py-2 text-xs font-black text-slate-950 shadow-[0_10px_30px_rgba(255,255,255,0.18)] active:scale-95">Export</button>
        </div>
      </header>

      {!selectedClip ? (
        <main className="relative mx-auto flex min-h-[calc(100dvh-4rem)] max-w-[430px] flex-col px-4 px-safe pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5">
          <section className="relative overflow-hidden rounded-[38px] border border-white/10 bg-white/[0.07] p-5 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <div
              aria-hidden="true"
              className="absolute inset-0 opacity-80"
              style={{ background: 'linear-gradient(145deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 48%, rgba(124,58,237,0.16))' }}
            />
            <div className="relative">
              <div className="mb-5 flex items-center justify-between">
                <div className="inline-flex items-center gap-2 rounded-full bg-black/30 px-3 py-1.5 text-[11px] font-bold text-violet-100 ring-1 ring-white/10">
                  <Sparkles className="h-3.5 w-3.5 text-violet-300" /> Premium mobile editor
                </div>
                <div className="rounded-full bg-emerald-400/10 px-3 py-1.5 text-[11px] font-bold text-emerald-200 ring-1 ring-emerald-300/20">Ready</div>
              </div>

              <div className="grid h-24 w-24 place-items-center rounded-[32px] bg-gradient-to-br from-violet-500 via-fuchsia-500 to-blue-500 shadow-[0_20px_60px_rgba(124,58,237,0.45)]">
                <Film className="h-11 w-11" />
              </div>

              <h1 className="mt-7 text-[2.7rem] font-black leading-[0.92] tracking-[-0.08em] text-white">Create your first cut.</h1>
              <p className="mt-4 max-w-sm text-[15px] leading-6 text-white/60">
                Import a video, follow the guided tools, and export a polished vertical edit from Safari without fighting the screen.
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                {QUALITY_CHIPS.map((chip) => (
                  <span key={chip} className="rounded-full bg-white/[0.08] px-3 py-1.5 text-[11px] font-bold text-white/75 ring-1 ring-white/10">{chip}</span>
                ))}
              </div>

              <button onClick={() => fileRef.current?.click()} className="mt-7 flex min-h-14 w-full items-center justify-center gap-2 rounded-[22px] bg-white px-5 py-4 text-base font-black text-slate-950 shadow-[0_18px_50px_rgba(255,255,255,0.18)] active:scale-[0.985]">
                <Upload className="h-5 w-5" /> Import video
              </button>
            </div>
          </section>

          <section className="mt-4 rounded-[30px] border border-white/10 bg-black/25 p-4 backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-black tracking-tight">First-time flow</h2>
              <span className="text-[11px] font-semibold text-white/50">3 steps</span>
            </div>
            <div className="space-y-3">
              {FIRST_RUN_STEPS.map(({ icon: Icon, title, body }, index) => (
                <div key={title} className="flex gap-3 rounded-[22px] bg-white/[0.055] p-3 ring-1 ring-white/10">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/[0.08] text-white ring-1 ring-white/10">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-violet-200">0{index + 1}</span>
                      <h3 className="text-sm font-extrabold text-white">{title}</h3>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-white/50">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </main>
      ) : (
        <main className="relative mx-auto max-w-[430px] px-3 px-safe pb-[calc(env(safe-area-inset-bottom)+6.2rem)] pt-3">
          <section className="relative overflow-hidden rounded-[34px] border border-white/10 bg-black/55 p-2 shadow-[0_30px_90px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
            <div className="mb-2 flex items-center justify-between px-2 pt-1">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-1.5 text-[11px] font-bold text-white/75 ring-1 ring-white/10">
                <Layers className="h-3.5 w-3.5 text-violet-200" /> Preview
              </div>
              <div className="rounded-full bg-black/40 px-3 py-1.5 font-mono text-[11px] text-white/60 ring-1 ring-white/10">{formatTime(current)}</div>
            </div>
            <div className={`relative mx-auto max-h-[43dvh] overflow-hidden rounded-[28px] bg-black ${aspectClass(project.aspect, selectedClip)}`}>
              <video ref={videoRef} playsInline muted controls={false} className="absolute inset-0 h-full w-full object-contain" />
              {project.textLayers.map((layer) => {
                const visible = current >= layer.start && current <= layer.end;
                if (!visible) return null;
                return (
                  <button
                    key={layer.id}
                    onClick={() => { setSelectedTextId(layer.id); setTool('text'); }}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl px-3 py-1.5 text-center font-black leading-tight ring-1 ring-white/10 ${layer.background ? 'bg-black/60 backdrop-blur-md' : ''}`}
                    style={{ left: `${layer.x}%`, top: `${layer.y}%`, color: layer.color, fontSize: `${Math.max(14, layer.size / 3.2)}px` }}
                  >
                    {layer.text}
                  </button>
                );
              })}
              <button onClick={togglePlay} aria-label={playing ? 'Pause video' : 'Play video'} className="absolute left-1/2 top-1/2 grid h-[4.35rem] w-[4.35rem] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white shadow-[0_16px_45px_rgba(0,0,0,0.45)] ring-1 ring-white/20 backdrop-blur-xl active:scale-95">
                {playing ? <Pause className="h-8 w-8" /> : <Play className="ml-1 h-8 w-8" />}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 px-1 text-center text-[11px]">
              <div className="rounded-2xl bg-white/[0.055] px-2 py-2 ring-1 ring-white/10"><span className="block text-white/40">Size</span><span className="font-mono text-white/70">{selectedClip.width}×{selectedClip.height}</span></div>
              <div className="rounded-2xl bg-white/[0.055] px-2 py-2 ring-1 ring-white/10"><span className="block text-white/40">Length</span><span className="font-mono text-white/70">{formatTime(clipDuration)}</span></div>
              <div className="rounded-2xl bg-white/[0.055] px-2 py-2 ring-1 ring-white/10"><span className="block text-white/40">Aspect</span><span className="font-mono text-white/70">{project.aspect}</span></div>
            </div>
          </section>

          <section className="mt-3 rounded-[28px] border border-white/10 bg-white/[0.06] p-3 shadow-[0_18px_55px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="mb-2 flex items-center justify-between text-xs text-white/60">
              <span>{formatTime(selectedClip.start)}</span>
              <span className="font-black text-white">Timeline</span>
              <span>{formatTime(selectedClip.end)}</span>
            </div>
            <input
              type="range"
              min={selectedClip.start}
              max={selectedClip.end}
              step={0.01}
              value={clamp(current, selectedClip.start, selectedClip.end)}
              onChange={(e) => seekTo(Number(e.target.value))}
              className="w-full accent-violet-500"
            />
            <div className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1">
              {(thumbs.length ? thumbs : new Array(10).fill('')).map((src, i) => (
                <button key={i} onClick={() => seekTo(selectedClip.start + ((selectedClip.end - selectedClip.start) * i) / Math.max(1, thumbs.length - 1))} className="h-14 w-10 shrink-0 overflow-hidden rounded-xl bg-slate-900 ring-1 ring-white/10 active:scale-95">
                  {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : null}
                </button>
              ))}
            </div>
            <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
              {project.clips.map((clip) => (
                <button key={clip.id} onClick={() => setProject((p) => ({ ...p, selectedClipId: clip.id }))} className={`min-w-28 rounded-2xl px-3 py-2 text-left text-xs ring-1 active:scale-95 ${clip.id === selectedClip.id ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.055] text-white/60 ring-white/10'}`}>
                  <span className="block truncate font-black">{clip.name}</span>
                  <span className="font-mono text-[10px] opacity-70">{formatTime(clip.end - clip.start)}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="mt-3 min-h-44 rounded-[28px] border border-white/10 bg-white/[0.065] p-4 shadow-[0_18px_55px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="grid h-9 w-9 place-items-center rounded-2xl bg-white/[0.08] ring-1 ring-white/10">
                  <ActiveToolIcon className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black">{activeTool.label}</h3>
                  <p className="text-[11px] text-white/40">Make the next clean edit</p>
                </div>
              </div>
              <button onClick={() => fileRef.current?.click()} className="rounded-full bg-white/[0.08] px-3 py-2 text-[11px] font-bold text-white/70 ring-1 ring-white/10 active:scale-95">
                Replace
              </button>
            </div>

            {tool === 'trim' && (
              <div className="space-y-4">
                <div className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">
                  <label className="block text-xs font-bold text-white/60">Start · {formatTime(selectedClip.start)}</label>
                  <input className="mt-1 w-full accent-violet-500" type="range" min={0} max={selectedClip.duration} step={0.01} value={selectedClip.start} onChange={(e) => updateClip({ start: clamp(Number(e.target.value), 0, selectedClip.end - 0.1) })} />
                </div>
                <div className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">
                  <label className="block text-xs font-bold text-white/60">End · {formatTime(selectedClip.end)}</label>
                  <input className="mt-1 w-full accent-violet-500" type="range" min={0} max={selectedClip.duration} step={0.01} value={selectedClip.end} onChange={(e) => updateClip({ end: clamp(Number(e.target.value), selectedClip.start + 0.1, selectedClip.duration) })} />
                </div>
              </div>
            )}

            {tool === 'split' && (
              <div className="space-y-3">
                <button onClick={splitAtPlayhead} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 font-black text-slate-950 active:scale-[0.985]"><SplitSquareHorizontal className="h-5 w-5" /> Split at playhead</button>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={duplicateClip} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white/[0.09] px-4 py-3 font-bold ring-1 ring-white/10"><Copy className="h-4 w-4" /> Duplicate</button>
                  <button onClick={deleteClip} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-red-500/20 px-4 py-3 font-bold text-red-100 ring-1 ring-red-300/20"><Trash2 className="h-4 w-4" /> Delete</button>
                </div>
              </div>
            )}

            {tool === 'text' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs leading-5 text-white/50">Add captions, titles, or punchline text.</p>
                  <button onClick={addText} className="rounded-full bg-white px-3 py-2 text-xs font-black text-slate-950"><Plus className="inline h-3.5 w-3.5" /> Add</button>
                </div>
                {selectedText ? (
                  <>
                    <input value={selectedText.text} onChange={(e) => updateText({ text: e.target.value })} className="w-full rounded-2xl bg-black/30 px-4 py-3 text-sm font-semibold outline-none ring-1 ring-white/10" />
                    <div className="grid grid-cols-2 gap-2 text-xs text-white/60">
                      <label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">Y position<input type="range" min={10} max={90} value={selectedText.y} onChange={(e) => updateText({ y: Number(e.target.value) })} className="w-full accent-violet-500" /></label>
                      <label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">Size<input type="range" min={22} max={72} value={selectedText.size} onChange={(e) => updateText({ size: Number(e.target.value) })} className="w-full accent-violet-500" /></label>
                    </div>
                    <button onClick={removeText} className="rounded-2xl bg-red-500/20 px-3 py-2 text-xs font-bold text-red-100 ring-1 ring-red-300/20">Remove text</button>
                  </>
                ) : <button onClick={addText} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white/[0.09] px-4 py-4 text-sm font-bold text-white/80 ring-1 ring-white/10"><Captions className="h-4 w-4" /> Add your first text layer</button>}
              </div>
            )}

            {tool === 'audio' && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-black"><Volume2 className="h-4 w-4" /> Clip volume</div>
                <label className="block rounded-2xl bg-black/25 p-3 text-xs font-bold text-white/60 ring-1 ring-white/10">Volume · {Math.round(selectedClip.volume * 100)}%<input type="range" min={0} max={1} step={0.01} value={selectedClip.volume} onChange={(e) => updateClip({ volume: Number(e.target.value) })} className="mt-1 w-full accent-violet-500" /></label>
                <p className="text-xs leading-5 text-white/40">Music, voiceover, and beat sync will connect to the next media-bin pass.</p>
              </div>
            )}

            {tool === 'speed' && (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-2">
                  {[0.5, 0.75, 1, 1.5].map((speed) => <button key={speed} onClick={() => updateClip({ speed })} className={`min-h-12 rounded-2xl px-3 py-3 text-sm font-black ring-1 active:scale-95 ${selectedClip.speed === speed ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>{speed}×</button>)}
                </div>
              </div>
            )}

            {tool === 'effects' && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {['Clean', 'Glow', 'Film', 'Punch', 'Soft', 'Noir'].map((name) => <button key={name} className="min-h-14 rounded-2xl bg-white/[0.08] px-3 py-4 font-bold ring-1 ring-white/10 active:scale-95">{name}</button>)}
                </div>
                <p className="text-xs leading-5 text-white/40">Effect buttons are staged for the next render filter pass.</p>
              </div>
            )}

            {tool === 'export' && (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-2 text-xs">
                  {ASPECTS.map((aspect) => <button key={aspect} onClick={() => setProject((p) => ({ ...p, aspect }))} className={`min-h-11 rounded-2xl px-2 py-2 font-black ring-1 active:scale-95 ${project.aspect === aspect ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>{aspect}</button>)}
                </div>
                <button onClick={exportVideo} disabled={exporting} className="flex min-h-[3.25rem] w-full items-center justify-center gap-2 rounded-[22px] bg-white px-4 py-3 font-black text-slate-950 shadow-[0_15px_40px_rgba(255,255,255,0.14)] disabled:opacity-60">{exporting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />} {exporting ? `Rendering ${Math.round(exportProgress)}%` : 'Render mobile video'}</button>
                {exportUrl && <button onClick={downloadExport} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 font-black text-emerald-950"><Check className="h-5 w-5" /> Download render</button>}
                {exportError && <p className="rounded-2xl bg-red-500/10 p-3 text-xs text-red-100 ring-1 ring-red-300/20">{exportError}</p>}
              </div>
            )}
          </section>

          <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#050510]/90 pb-safe backdrop-blur-2xl">
            <div className="mx-auto max-w-[430px] px-3 pt-2">
              <div className="no-scrollbar flex gap-2 overflow-x-auto pb-2">
                {TOOLS.map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => setTool(id)} className={`flex min-h-[4rem] min-w-[4.85rem] flex-col items-center justify-center gap-1 rounded-[22px] px-3 py-2 text-[11px] font-black ring-1 active:scale-95 ${tool === id ? 'bg-white text-slate-950 ring-white shadow-[0_12px_35px_rgba(255,255,255,0.16)]' : 'bg-white/[0.07] text-white/60 ring-white/10'}`}>
                    <Icon className="h-5 w-5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </nav>
        </main>
      )}

      <input ref={fileRef} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" onChange={onFileInput} />
    </div>
  );
}
