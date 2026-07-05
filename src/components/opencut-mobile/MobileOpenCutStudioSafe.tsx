import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Download, Film, Loader2, Music2, Play, Plus, Sparkles, Type, Upload, Volume2 } from 'lucide-react';
import type { OpenCutAudioTrack, OpenCutClip, OpenCutProject, OpenCutTextLayer, OpenCutTransitionType } from '@/lib/opencut/types';
import { exportOpenCutRender } from '@/lib/opencut/export';
import { formatTime, probeOpenCutAudio, probeOpenCutVideo, uid } from '@/lib/opencut/video';

type Aspect = OpenCutProject['aspect'];

const TRANSITIONS: OpenCutTransitionType[] = ['fade', 'flash', 'zoom', 'glitch', 'wipe'];

function projectDuration(clips: OpenCutClip[]) {
  return clips.reduce((sum, clip) => sum + Math.max(0.1, (clip.end - clip.start) / Math.max(0.1, clip.speed || 1)), 0);
}

function aspectClass(aspect: Aspect) {
  if (aspect === '16:9') return 'aspect-video';
  if (aspect === '1:1') return 'aspect-square';
  return 'aspect-[9/16]';
}

function targetSize(aspect: Aspect) {
  if (aspect === '16:9') return { width: 1280, height: 720 };
  if (aspect === '1:1') return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

export default function MobileOpenCutStudioSafe() {
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const [project, setProject] = useState<OpenCutProject>({
    id: uid('project'),
    name: 'Untitled Promo',
    aspect: '9:16',
    clips: [],
    textLayers: [],
    audioTracks: [],
  });
  const [selectedClipId, setSelectedClipId] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportMimeType, setExportMimeType] = useState('video/webm');
  const [message, setMessage] = useState<string | null>(null);

  const selectedClip = useMemo(
    () => project.clips.find((clip) => clip.id === selectedClipId) ?? project.clips[0],
    [project.clips, selectedClipId],
  );
  const duration = projectDuration(project.clips);

  const importVideos = async (files: FileList | null) => {
    if (!files?.length) return;
    setMessage(null);
    const nextClips: OpenCutClip[] = [];
    for (const file of Array.from(files)) {
      if (!/video\//i.test(file.type) && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) continue;
      const meta = await probeOpenCutVideo(file);
      nextClips.push({
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
        brightness: 100,
        contrast: 100,
        saturation: 100,
        blur: 0,
        opacity: 1,
        rotate: 0,
        flipX: false,
        fit: 'cover',
        fadeIn: 0.18,
        fadeOut: 0.18,
        transition: TRANSITIONS[nextClips.length % TRANSITIONS.length],
        transitionDuration: 0.35,
      });
    }

    if (!nextClips.length) {
      setMessage('Upload MP4, MOV, M4V, or WebM video clips.');
      return;
    }

    setProject((prev) => ({
      ...prev,
      name: prev.name === 'Untitled Promo' ? `${nextClips[0].name} Promo` : prev.name,
      clips: [...prev.clips, ...nextClips],
      selectedClipId: prev.selectedClipId ?? nextClips[0].id,
    }));
    setSelectedClipId((current) => current ?? nextClips[0].id);
  };

  const importAudio = async (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    if (!/audio\//i.test(file.type) && !/\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name)) {
      setMessage('Upload MP3, WAV, M4A, AAC, or OGG audio.');
      return;
    }
    const meta = await probeOpenCutAudio(file);
    const track: OpenCutAudioTrack = {
      id: uid('audio'),
      name: file.name.replace(/\.[^.]+$/, '') || 'Audio track',
      url: meta.url,
      duration: meta.duration,
      volume: 0.85,
      start: 0,
      fadeIn: 0.25,
      fadeOut: 0.6,
    };
    setProject((prev) => ({ ...prev, audioTracks: [...prev.audioTracks, track] }));
  };

  const addPromoText = () => {
    const layer: OpenCutTextLayer = {
      id: uid('text'),
      text: project.textLayers.length ? 'Out now everywhere' : 'NEW DROP',
      start: 0,
      end: Math.max(3, duration || 5),
      x: 50,
      y: project.textLayers.length ? 88 : 18,
      size: project.textLayers.length ? 32 : 52,
      weight: 900,
      color: project.textLayers.length ? '#f5d0fe' : '#ffffff',
      background: project.textLayers.length > 0,
      shadow: true,
      uppercase: !project.textLayers.length,
      animation: project.textLayers.length ? 'glow' : 'pop',
    };
    setProject((prev) => ({ ...prev, textLayers: [...prev.textLayers, layer] }));
  };

  const autoStylePromo = () => {
    setProject((prev) => ({
      ...prev,
      clips: prev.clips.map((clip, index) => ({
        ...clip,
        fit: 'cover',
        transition: TRANSITIONS[index % TRANSITIONS.length],
        transitionDuration: 0.35,
        brightness: index % 2 ? 110 : 104,
        contrast: index % 2 ? 98 : 124,
        saturation: index % 2 ? 118 : 130,
      })),
      textLayers: prev.textLayers.length
        ? prev.textLayers
        : [
            {
              id: uid('text'),
              text: 'NEW DROP',
              start: 0,
              end: Math.max(3, projectDuration(prev.clips) || 5),
              x: 50,
              y: 18,
              size: 52,
              weight: 900,
              color: '#ffffff',
              background: false,
              shadow: true,
              uppercase: true,
              animation: 'pop',
            },
            {
              id: uid('text'),
              text: '@treytrizzy',
              start: 0,
              end: Math.max(3, projectDuration(prev.clips) || 5),
              x: 50,
              y: 88,
              size: 32,
              weight: 900,
              color: '#f5d0fe',
              background: true,
              shadow: true,
              animation: 'glow',
            },
          ],
    }));
  };

  const exportPromo = async () => {
    if (!project.clips.length) {
      setMessage('Import at least one video clip before exporting.');
      return;
    }
    setExporting(true);
    setExportProgress(0);
    setMessage(null);
    try {
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      const { width, height } = targetSize(project.aspect);
      const rendered = await exportOpenCutRender({
        clips: project.clips,
        textLayers: project.textLayers,
        audioTracks: project.audioTracks,
        width,
        height,
        fps: 30,
        onProgress: setExportProgress,
      });
      setExportUrl(rendered.url);
      setExportMimeType(rendered.mimeType);
      const warnings = 'warnings' in rendered ? rendered.warnings : [];
      setMessage(warnings?.length ? warnings.join(' ') : 'Export ready.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const downloadExport = () => {
    if (!exportUrl) return;
    const extension = exportMimeType.includes('mp4') ? 'mp4' : 'webm';
    const link = document.createElement('a');
    link.href = exportUrl;
    link.download = `${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-promo.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const updateSelectedClip = (patch: Partial<OpenCutClip>) => {
    if (!selectedClip) return;
    setProject((prev) => ({
      ...prev,
      clips: prev.clips.map((clip) => (clip.id === selectedClip.id ? { ...clip, ...patch } : clip)),
    }));
  };

  const updateAudio = (id: string, patch: Partial<OpenCutAudioTrack>) => {
    setProject((prev) => ({
      ...prev,
      audioTracks: prev.audioTracks.map((track) => (track.id === id ? { ...track, ...patch } : track)),
    }));
  };

  return (
    <div className="min-h-dvh bg-[#03030a] text-white">
      <main className="mx-auto flex min-h-dvh max-w-[430px] flex-col gap-4 px-4 py-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.28em] text-violet-200">OpenCut Promo</p>
            <input
              value={project.name}
              onChange={(event) => setProject((prev) => ({ ...prev, name: event.target.value }))}
              className="mt-1 w-full bg-transparent text-2xl font-black tracking-tight outline-none"
              aria-label="Project name"
            />
          </div>
          <button onClick={exportPromo} disabled={exporting} className="rounded-full bg-white px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-50">
            {exporting ? `${Math.round(exportProgress)}%` : 'Export'}
          </button>
        </header>

        <section className={`relative overflow-hidden rounded-[32px] border border-white/10 bg-black ${aspectClass(project.aspect)}`}>
          {selectedClip ? (
            <video key={selectedClip.id} src={selectedClip.url} controls playsInline muted className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full min-h-[420px] place-items-center p-6 text-center">
              <div>
                <div className="mx-auto grid h-20 w-20 place-items-center rounded-[28px] bg-violet-500/30 ring-1 ring-white/10">
                  <Film className="h-10 w-10" />
                </div>
                <h1 className="mt-5 text-4xl font-black leading-none tracking-tight">Create a promo video.</h1>
                <p className="mt-3 text-sm leading-6 text-white/55">Import clips, audio, and text. Then export a watermark-free promo cut.</p>
              </div>
            </div>
          )}
          {project.textLayers.map((layer) => (
            <div
              key={layer.id}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl px-3 py-1.5 text-center font-black leading-tight ${layer.background ? 'bg-black/60' : ''}`}
              style={{ left: `${layer.x}%`, top: `${layer.y}%`, color: layer.color, fontSize: `${Math.max(14, layer.size / 3)}px` }}
            >
              {layer.uppercase ? layer.text.toUpperCase() : layer.text}
            </div>
          ))}
        </section>

        <section className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-2xl bg-white/[0.07] p-3 ring-1 ring-white/10"><span className="block text-white/45">Clips</span><b>{project.clips.length}</b></div>
          <div className="rounded-2xl bg-white/[0.07] p-3 ring-1 ring-white/10"><span className="block text-white/45">Audio</span><b>{project.audioTracks.length}</b></div>
          <div className="rounded-2xl bg-white/[0.07] p-3 ring-1 ring-white/10"><span className="block text-white/45">Length</span><b>{formatTime(duration)}</b></div>
        </section>

        <section className="rounded-[28px] border border-white/10 bg-white/[0.06] p-4">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => videoInputRef.current?.click()} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white px-3 py-3 text-sm font-black text-slate-950"><Upload className="h-4 w-4" /> Add clips</button>
            <button onClick={() => audioInputRef.current?.click()} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white/[0.08] px-3 py-3 text-sm font-black ring-1 ring-white/10"><Music2 className="h-4 w-4" /> Add audio</button>
            <button onClick={addPromoText} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white/[0.08] px-3 py-3 text-sm font-black ring-1 ring-white/10"><Type className="h-4 w-4" /> Add text</button>
            <button onClick={autoStylePromo} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-violet-400 px-3 py-3 text-sm font-black text-slate-950"><Sparkles className="h-4 w-4" /> Auto style</button>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2 text-xs">
            {(['9:16', '1:1', '16:9', 'original'] as Aspect[]).map((aspect) => (
              <button
                key={aspect}
                onClick={() => setProject((prev) => ({ ...prev, aspect }))}
                className={`rounded-2xl px-2 py-3 font-black ring-1 ${project.aspect === aspect ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.07] text-white ring-white/10'}`}
              >
                {aspect}
              </button>
            ))}
          </div>
        </section>

        {selectedClip ? (
          <section className="rounded-[28px] border border-white/10 bg-white/[0.06] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-black">{selectedClip.name}</h2>
                <p className="text-xs text-white/45">{selectedClip.transition} · {selectedClip.speed}x</p>
              </div>
              <button onClick={() => updateSelectedClip({ speed: selectedClip.speed === 1 ? 1.5 : 1 })} className="rounded-full bg-white/[0.08] px-3 py-2 text-xs font-bold ring-1 ring-white/10">
                <Play className="mr-1 inline h-3 w-3" /> Speed
              </button>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {project.clips.map((clip, index) => (
                <button key={clip.id} onClick={() => setSelectedClipId(clip.id)} className={`min-w-28 rounded-2xl px-3 py-2 text-left text-xs ring-1 ${clip.id === selectedClip.id ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.07] text-white ring-white/10'}`}>
                  <span className="block truncate font-black">{index + 1}. {clip.name}</span>
                  <span className="text-[10px] opacity-70">{formatTime(clip.end - clip.start)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {project.audioTracks.length ? (
          <section className="rounded-[28px] border border-white/10 bg-white/[0.06] p-4">
            <h2 className="mb-3 text-sm font-black">Audio tracks</h2>
            <div className="space-y-3">
              {project.audioTracks.map((track) => (
                <div key={track.id} className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">
                  <div className="flex items-center gap-2 text-sm font-bold"><Volume2 className="h-4 w-4" /> <span className="truncate">{track.name}</span></div>
                  <input type="range" min={0} max={1} step={0.01} value={track.volume} onChange={(event) => updateAudio(track.id, { volume: Number(event.target.value) })} className="mt-2 w-full accent-violet-500" />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {exportUrl ? (
          <button onClick={downloadExport} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-emerald-400 px-4 py-3 font-black text-slate-950">
            <Download className="h-5 w-5" /> Download export
          </button>
        ) : null}

        {exporting ? <div className="rounded-2xl bg-white/[0.07] p-3 text-sm font-bold ring-1 ring-white/10"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Rendering {Math.round(exportProgress)}%</div> : null}
        {message ? <div className="rounded-2xl bg-white/[0.07] p-3 text-sm text-white/70 ring-1 ring-white/10">{message}</div> : null}
      </main>

      <input ref={videoInputRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/*" multiple className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => void importVideos(event.target.files)} />
      <input ref={audioInputRef} type="file" accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/*" className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => void importAudio(event.target.files?.[0])} />
    </div>
  );
}
