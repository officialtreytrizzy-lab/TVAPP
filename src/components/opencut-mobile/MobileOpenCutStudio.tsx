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
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'export', label: 'Export', icon: Download },
];

const ASPECTS: Array<OpenCutProject['aspect']> = ['9:16', '1:1', '16:9', 'original'];

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
      video.play();
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

  return (
    <div className="min-h-dvh overflow-hidden bg-[#05060b] text-white pb-safe">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#080915]/92 pt-safe backdrop-blur-xl">
        <div className="flex h-14 items-center gap-3 px-3">
          <a href="/" className="grid h-10 w-10 place-items-center rounded-full bg-white/8 text-white active:scale-95"><ArrowLeft className="h-5 w-5" /></a>
          <div className="min-w-0 flex-1">
            <input
              value={project.name}
              onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))}
              className="w-full truncate bg-transparent text-sm font-bold outline-none"
            />
            <p className="text-[11px] text-white/45">OpenCut Mobile Studio</p>
          </div>
          <button onClick={saveProject} className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-white active:scale-95">Save</button>
          <button onClick={() => setTool('export')} className="rounded-full bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-blue-900/30 active:scale-95">Export</button>
        </div>
      </header>

      {!selectedClip ? (
        <main className="mx-auto flex min-h-[calc(100dvh-80px)] max-w-md flex-col items-center justify-center px-5 text-center">
          <div className="mb-5 grid h-20 w-20 place-items-center rounded-[28px] bg-gradient-to-br from-violet-600 to-blue-600 shadow-xl shadow-violet-900/30">
            <Film className="h-10 w-10" />
          </div>
          <h1 className="text-3xl font-black tracking-tight">OpenCut Mobile</h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/55">CapCut-style iPhone editor built directly into Trey TV. Import a clip, trim it, split it, add text, adjust speed, and export a mobile cut.</p>
          <button onClick={() => fileRef.current?.click()} className="mt-8 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-blue-600 px-5 py-4 text-base font-bold active:scale-[0.99]"><Upload className="h-5 w-5" /> Import video</button>
          <input ref={fileRef} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </main>
      ) : (
        <main className="mx-auto grid max-w-md grid-rows-[auto_auto_1fr_auto] gap-3 px-3 py-3">
          <section className="relative rounded-[30px] bg-black/80 p-2 ring-1 ring-white/10 shadow-2xl shadow-black/40">
            <div className={`relative mx-auto max-h-[52dvh] overflow-hidden rounded-[24px] bg-black ${aspectClass(project.aspect, selectedClip)}`}>
              <video ref={videoRef} playsInline muted controls={false} className="absolute inset-0 h-full w-full object-contain" />
              {project.textLayers.map((layer) => {
                const visible = current >= layer.start && current <= layer.end;
                if (!visible) return null;
                return (
                  <button
                    key={layer.id}
                    onClick={() => { setSelectedTextId(layer.id); setTool('text'); }}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-xl px-3 py-1 text-center font-extrabold leading-tight ${layer.background ? 'bg-black/55' : ''}`}
                    style={{ left: `${layer.x}%`, top: `${layer.y}%`, color: layer.color, fontSize: `${Math.max(14, layer.size / 3.2)}px` }}
                  >
                    {layer.text}
                  </button>
                );
              })}
              <button onClick={togglePlay} className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/42 text-white backdrop-blur-md active:scale-95">
                {playing ? <Pause className="h-8 w-8" /> : <Play className="ml-1 h-8 w-8" />}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between px-2 text-[11px] font-mono text-white/55">
              <span>{formatTime(current)}</span>
              <span>{selectedClip.width}×{selectedClip.height}</span>
              <span>{formatTime(selectedClip.end - selectedClip.start)}</span>
            </div>
          </section>

          <section className="rounded-[24px] bg-white/[0.06] p-3 ring-1 ring-white/10">
            <div className="mb-2 flex items-center justify-between text-xs text-white/55">
              <span>{formatTime(selectedClip.start)}</span>
              <span className="font-semibold text-white">Timeline</span>
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
            <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
              {(thumbs.length ? thumbs : new Array(10).fill('')).map((src, i) => (
                <button key={i} onClick={() => seekTo(selectedClip.start + ((selectedClip.end - selectedClip.start) * i) / Math.max(1, thumbs.length - 1))} className="h-14 w-10 shrink-0 overflow-hidden rounded-md bg-slate-800 ring-1 ring-white/10">
                  {src ? <img src={src} className="h-full w-full object-cover" /> : null}
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {project.clips.map((clip) => (
                <button key={clip.id} onClick={() => setProject((p) => ({ ...p, selectedClipId: clip.id }))} className={`min-w-24 rounded-xl px-3 py-2 text-left text-xs ring-1 ${clip.id === selectedClip.id ? 'bg-violet-600 text-white ring-violet-300/40' : 'bg-white/5 text-white/60 ring-white/10'}`}>
                  <span className="block truncate font-semibold">{clip.name}</span>
                  <span className="font-mono text-[10px] opacity-70">{formatTime(clip.end - clip.start)}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="min-h-44 rounded-[24px] bg-white/[0.06] p-3 ring-1 ring-white/10">
            {tool === 'trim' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between"><h3 className="font-bold">Trim clip</h3><span className="text-xs text-white/45">Drag start/end</span></div>
                <label className="block text-xs text-white/55">Start · {formatTime(selectedClip.start)}</label>
                <input className="w-full accent-violet-500" type="range" min={0} max={selectedClip.duration} step={0.01} value={selectedClip.start} onChange={(e) => updateClip({ start: clamp(Number(e.target.value), 0, selectedClip.end - 0.1) })} />
                <label className="block text-xs text-white/55">End · {formatTime(selectedClip.end)}</label>
                <input className="w-full accent-violet-500" type="range" min={0} max={selectedClip.duration} step={0.01} value={selectedClip.end} onChange={(e) => updateClip({ end: clamp(Number(e.target.value), selectedClip.start + 0.1, selectedClip.duration) })} />
              </div>
            )}
            {tool === 'split' && (
              <div className="space-y-3">
                <h3 className="font-bold">Clip actions</h3>
                <button onClick={splitAtPlayhead} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-4 py-3 font-bold"><SplitSquareHorizontal className="h-5 w-5" /> Split at playhead</button>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={duplicateClip} className="flex items-center justify-center gap-2 rounded-2xl bg-white/10 px-4 py-3 font-semibold"><Copy className="h-4 w-4" /> Duplicate</button>
                  <button onClick={deleteClip} className="flex items-center justify-center gap-2 rounded-2xl bg-red-500/20 px-4 py-3 font-semibold text-red-200"><Trash2 className="h-4 w-4" /> Delete</button>
                </div>
              </div>
            )}
            {tool === 'text' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between"><h3 className="font-bold">Text / captions</h3><button onClick={addText} className="rounded-full bg-violet-600 px-3 py-1.5 text-xs font-bold"><Plus className="inline h-3.5 w-3.5" /> Add</button></div>
                {selectedText ? (
                  <>
                    <input value={selectedText.text} onChange={(e) => updateText({ text: e.target.value })} className="w-full rounded-2xl bg-black/30 px-4 py-3 text-sm outline-none ring-1 ring-white/10" />
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <label>Y position<input type="range" min={10} max={90} value={selectedText.y} onChange={(e) => updateText({ y: Number(e.target.value) })} className="w-full accent-violet-500" /></label>
                      <label>Size<input type="range" min={22} max={72} value={selectedText.size} onChange={(e) => updateText({ size: Number(e.target.value) })} className="w-full accent-violet-500" /></label>
                    </div>
                    <button onClick={removeText} className="rounded-xl bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-200">Remove text</button>
                  </>
                ) : <button onClick={addText} className="w-full rounded-2xl bg-white/10 px-4 py-4 text-sm text-white/80">Add your first text layer</button>}
              </div>
            )}
            {tool === 'audio' && (
              <div className="space-y-3">
                <h3 className="font-bold">Audio</h3>
                <label className="block text-xs text-white/55">Clip volume · {Math.round(selectedClip.volume * 100)}%</label>
                <input type="range" min={0} max={1} step={0.01} value={selectedClip.volume} onChange={(e) => updateClip({ volume: Number(e.target.value) })} className="w-full accent-violet-500" />
                <p className="text-xs text-white/45">Music, voiceover, and beat sync will connect to the next media-bin pass.</p>
              </div>
            )}
            {tool === 'speed' && (
              <div className="space-y-3">
                <h3 className="font-bold">Speed</h3>
                <div className="grid grid-cols-4 gap-2">
                  {[0.5, 0.75, 1, 1.5].map((speed) => <button key={speed} onClick={() => updateClip({ speed })} className={`rounded-xl px-3 py-3 text-sm font-bold ${selectedClip.speed === speed ? 'bg-violet-600' : 'bg-white/10'}`}>{speed}×</button>)}
                </div>
              </div>
            )}
            {tool === 'effects' && (
              <div className="space-y-3">
                <h3 className="font-bold">Effects</h3>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {['Clean', 'Glow', 'Film', 'Punch', 'Soft', 'Noir'].map((name) => <button key={name} className="rounded-2xl bg-white/10 px-3 py-4 font-semibold">{name}</button>)}
                </div>
                <p className="text-xs text-white/45">Effect buttons are staged for the next render filter pass.</p>
              </div>
            )}
            {tool === 'export' && (
              <div className="space-y-3">
                <h3 className="font-bold">Export</h3>
                <div className="grid grid-cols-4 gap-2 text-xs">
                  {ASPECTS.map((aspect) => <button key={aspect} onClick={() => setProject((p) => ({ ...p, aspect }))} className={`rounded-xl px-2 py-2 font-bold ${project.aspect === aspect ? 'bg-violet-600' : 'bg-white/10'}`}>{aspect}</button>)}
                </div>
                <button onClick={exportVideo} disabled={exporting} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-3 font-bold disabled:opacity-60">{exporting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />} {exporting ? `Rendering ${Math.round(exportProgress)}%` : 'Render mobile video'}</button>
                {exportUrl && <button onClick={downloadExport} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 font-bold"><Check className="h-5 w-5" /> Download render</button>}
                {exportError && <p className="rounded-xl bg-red-500/10 p-3 text-xs text-red-200">{exportError}</p>}
              </div>
            )}
          </section>

          <nav className="sticky bottom-0 z-30 -mx-3 border-t border-white/10 bg-[#080915]/95 px-2 pb-safe pt-2 backdrop-blur-xl">
            <div className="flex gap-2 overflow-x-auto pb-2">
              {TOOLS.map(({ id, label, icon: Icon }) => (
                <button key={id} onClick={() => setTool(id)} className={`flex min-w-20 flex-col items-center gap-1 rounded-2xl px-3 py-2 text-[11px] font-semibold active:scale-95 ${tool === id ? 'bg-violet-600 text-white' : 'bg-white/7 text-white/65'}`}>
                  <Icon className="h-5 w-5" />
                  {label}
                </button>
              ))}
            </div>
          </nav>
        </main>
      )}
      <input ref={fileRef} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
    </div>
  );
}
