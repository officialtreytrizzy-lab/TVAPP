import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
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
import type { OpenCutAudioTrack, OpenCutClip, OpenCutProject, OpenCutTextAnimation, OpenCutTextLayer, OpenCutTransitionType } from '@/lib/opencut/types';
import { exportOpenCutRender } from '@/lib/opencut/export';
import { formatTime, makeTimelineThumbs, probeOpenCutAudio, probeOpenCutVideo, uid } from '@/lib/opencut/video';

type Tool = 'trim' | 'split' | 'text' | 'captions' | 'stickers' | 'audio' | 'speed' | 'transitions' | 'filters' | 'adjust' | 'transform' | 'canvas' | 'export';

const TOOLS: Array<{ id: Tool; label: string; icon: typeof Scissors }> = [
  { id: 'trim', label: 'Trim', icon: Scissors },
  { id: 'split', label: 'Split', icon: SplitSquareHorizontal },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'captions', label: 'Captions', icon: Captions },
  { id: 'stickers', label: 'Stickers', icon: Sparkles },
  { id: 'audio', label: 'Audio', icon: Music2 },
  { id: 'speed', label: 'Speed', icon: Gauge },
  { id: 'transitions', label: 'Transitions', icon: Sparkles },
  { id: 'filters', label: 'Filters', icon: Sparkles },
  { id: 'adjust', label: 'Adjust', icon: Gauge },
  { id: 'transform', label: 'Transform', icon: Layers },
  { id: 'canvas', label: 'Canvas', icon: Film },
  { id: 'export', label: 'Export', icon: Download },
];

const ASPECTS: Array<OpenCutProject['aspect']> = ['9:16', '1:1', '16:9', 'original'];

const FILTER_PRESETS: Array<{ label: string; patch: Partial<OpenCutClip> }> = [
  { label: 'Clean', patch: { filterPreset: 'Clean', brightness: 102, contrast: 104, saturation: 106, blur: 0 } },
  { label: 'Glow', patch: { filterPreset: 'Glow', brightness: 112, contrast: 96, saturation: 118, blur: 0 } },
  { label: 'Film', patch: { filterPreset: 'Film', brightness: 96, contrast: 118, saturation: 82, blur: 0 } },
  { label: 'Punch', patch: { filterPreset: 'Punch', brightness: 104, contrast: 128, saturation: 126, blur: 0 } },
  { label: 'Soft', patch: { filterPreset: 'Soft', brightness: 108, contrast: 90, saturation: 94, blur: 0.6 } },
  { label: 'Noir', patch: { filterPreset: 'Noir', brightness: 94, contrast: 138, saturation: 0, blur: 0 } },
  { label: 'Drama', patch: { filterPreset: 'Drama', brightness: 92, contrast: 145, saturation: 114, blur: 0 } },
  { label: 'Vivid', patch: { filterPreset: 'Vivid', brightness: 105, contrast: 114, saturation: 142, blur: 0 } },
];

const TEXT_PRESETS: Array<{ label: string; patch: Partial<OpenCutTextLayer> }> = [
  { label: 'Hook Pop', patch: { text: 'NEW DROP', y: 78, size: 54, weight: 900, color: '#ffffff', background: true, shadow: true, uppercase: true, animation: 'pop' } },
  { label: 'Lyric Glow', patch: { text: 'Out now everywhere', y: 82, size: 36, weight: 900, color: '#f5d0fe', background: true, shadow: true, animation: 'glow' } },
  { label: 'Title Slide', patch: { text: 'MAIN CHARACTER', y: 18, size: 44, weight: 900, color: '#ffffff', background: false, shadow: true, uppercase: true, animation: 'slide-up' } },
  { label: 'Lower Third', patch: { text: '@treytrizzy', y: 88, size: 30, weight: 800, color: '#f5d0fe', background: true, shadow: true, animation: 'fade' } },
];

const STICKERS = ['🔥', '💎', '✨', '🖤', '🎬', '⚡', '👑', '💿', '📍', '🧊', '🌪️', '🚀'];
const TRANSITIONS: OpenCutTransitionType[] = ['none', 'fade', 'flash', 'wipe', 'zoom', 'glitch'];
const TEXT_ANIMATIONS: OpenCutTextAnimation[] = ['none', 'pop', 'fade', 'slide-up', 'glow', 'typewriter'];

const FIRST_RUN_STEPS = [
  { icon: Film, title: 'Import clips', body: 'Choose multiple videos to build a promo reel, teaser, announcement, or music-video short.' },
  { icon: Music2, title: 'Add audio', body: 'Drop in an audio file, set volume, then cut clips around the sound.' },
  { icon: Sparkles, title: 'Style the promo', body: 'Add animated text, stickers, filters, speed, fades, and transitions before export.' },
];

const QUALITY_CHIPS = ['Multi-clip promo', 'Audio-ready', 'Animated text'];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function segmentDuration(clip: OpenCutClip) {
  return Math.max(0.1, (clip.end - clip.start) / Math.max(0.1, clip.speed || 1));
}

function projectDuration(clips: OpenCutClip[]) {
  return clips.reduce((sum, clip) => sum + segmentDuration(clip), 0);
}

function clipStartInProject(clips: OpenCutClip[], clipId?: string) {
  let time = 0;
  for (const clip of clips) {
    if (clip.id === clipId) return time;
    time += segmentDuration(clip);
  }
  return 0;
}

function aspectClass(aspect: OpenCutProject['aspect'], clip?: OpenCutClip) {
  if (aspect === '9:16') return 'aspect-[9/16]';
  if (aspect === '1:1') return 'aspect-square';
  if (aspect === '16:9') return 'aspect-video';
  if (clip && clip.width && clip.height) return clip.width > clip.height ? 'aspect-video' : 'aspect-[9/16]';
  return 'aspect-[9/16]';
}

function cssClipFilter(clip?: OpenCutClip) {
  if (!clip) return undefined;
  return `brightness(${clip.brightness ?? 100}%) contrast(${clip.contrast ?? 100}%) saturate(${clip.saturation ?? 100}%) blur(${clip.blur ?? 0}px)`;
}

function clipStyle(clip?: OpenCutClip) {
  if (!clip) return undefined;
  return {
    filter: cssClipFilter(clip),
    opacity: clip.opacity ?? 1,
    transform: `rotate(${clip.rotate ?? 0}deg) scaleX(${clip.flipX ? -1 : 1})`,
    objectFit: clip.fit === 'cover' ? 'cover' : 'contain',
  } as const;
}

function textPreviewClass(animation?: OpenCutTextAnimation) {
  if (animation === 'glow') return 'shadow-[0_0_22px_rgba(217,70,239,0.8)]';
  if (animation === 'pop') return 'scale-105';
  if (animation === 'slide-up') return '-translate-y-[58%]';
  return '';
}

function isStickerLayer(layer: OpenCutTextLayer) {
  return STICKERS.includes(layer.text.trim());
}

function timelinePercent(start: number, end: number, total: number) {
  const safeTotal = Math.max(0.1, total);
  const left = clamp((start / safeTotal) * 100, 0, 100);
  const width = clamp(((end - start) / safeTotal) * 100, 1.5, 100 - left);
  return { left: `${left}%`, width: `${width}%` };
}

export default function MobileOpenCutStudio() {
  const videoFileRef = useRef<HTMLInputElement | null>(null);
  const audioFileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingTimelineSeekRef = useRef<{ clipId: string; sourceTime: number } | null>(null);

  const [project, setProject] = useState<OpenCutProject>({
    id: uid('project'),
    name: 'Untitled Promo',
    aspect: '9:16',
    clips: [],
    textLayers: [],
    audioTracks: [],
  });
  const [tool, setTool] = useState<Tool>('trim');
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportMimeType, setExportMimeType] = useState<string>('video/webm');
  const [exportError, setExportError] = useState<string | null>(null);

  const selectedClip = useMemo(() => project.clips.find((clip) => clip.id === project.selectedClipId) ?? project.clips[0], [project.clips, project.selectedClipId]);
  const selectedText = useMemo(() => project.textLayers.find((layer) => layer.id === selectedTextId) ?? project.textLayers[0], [project.textLayers, selectedTextId]);
  const activeTool = TOOLS.find((item) => item.id === tool) ?? TOOLS[0];
  const ActiveToolIcon = activeTool.icon;
  const selectedClipDuration = selectedClip ? selectedClip.end - selectedClip.start : 0;
  const totalDuration = projectDuration(project.clips);
  const audioTimelineEnd = project.audioTracks.reduce((max, track) => Math.max(max, track.start + track.duration), 0);
  const textTimelineEnd = project.textLayers.reduce((max, layer) => Math.max(max, layer.end), 0);
  const timelineLength = Math.max(totalDuration, audioTimelineEnd, textTimelineEnd, selectedClipDuration, 1);
  const selectedClipTimelineStart = clipStartInProject(project.clips, selectedClip?.id);
  const currentTimeline = selectedClip ? selectedClipTimelineStart + ((current - selectedClip.start) / Math.max(0.1, selectedClip.speed || 1)) : 0;
  const clipTimelineItems = useMemo(() => {
    let cursor = 0;
    return project.clips.map((clip, index) => {
      const duration = segmentDuration(clip);
      const item = { clip, index, start: cursor, end: cursor + duration, duration };
      cursor += duration;
      return item;
    });
  }, [project.clips]);
  const textTimelineLayers = project.textLayers.filter((layer) => !isStickerLayer(layer));
  const stickerTimelineLayers = project.textLayers.filter(isStickerLayer);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const t = video.currentTime;
      setCurrent(t);
      if (selectedClip && t >= selectedClip.end) {
        const index = project.clips.findIndex((clip) => clip.id === selectedClip.id);
        const next = project.clips[index + 1];
        if (next) {
          setProject((prev) => ({ ...prev, selectedClipId: next.id }));
        } else {
          video.pause();
          audioRef.current?.pause();
          setPlaying(false);
          video.currentTime = selectedClip.start;
        }
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
  }, [selectedClip, project.clips]);

  useEffect(() => {
    if (!selectedClip || !videoRef.current) return;
    const pending = pendingTimelineSeekRef.current;
    const targetTime = pending?.clipId === selectedClip.id ? pending.sourceTime : selectedClip.start;
    if (pending?.clipId === selectedClip.id) pendingTimelineSeekRef.current = null;
    videoRef.current.src = selectedClip.url;
    videoRef.current.currentTime = targetTime;
    videoRef.current.style.objectFit = selectedClip.fit === 'cover' ? 'cover' : 'contain';
    videoRef.current.playbackRate = selectedClip.speed || 1;
    setCurrent(targetTime);
    makeTimelineThumbs(selectedClip.url, 14).then(setThumbs).catch(() => setThumbs([]));
    if (playing) void videoRef.current.play();
  }, [selectedClip?.id]);

  useEffect(() => {
    if (!audioRef.current || !project.audioTracks[0]) return;
    audioRef.current.volume = project.audioTracks[0].volume;
  }, [project.audioTracks]);

  const importVideoFiles = async (files: FileList | File[]) => {
    setExportError(null);
    const incoming = Array.from(files).filter((file) => /video\//i.test(file.type) || /\.(mp4|mov|webm|m4v)$/i.test(file.name));
    if (!incoming.length) {
      setExportError('Upload MP4, MOV, WebM, or M4V video clips.');
      return;
    }
    const clips: OpenCutClip[] = [];
    for (const file of incoming) {
      const meta = await probeOpenCutVideo(file);
      clips.push({
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
        filterPreset: 'Clean',
        brightness: 100,
        contrast: 100,
        saturation: 100,
        blur: 0,
        opacity: 1,
        rotate: 0,
        flipX: false,
        fit: 'contain',
        fadeIn: 0.18,
        fadeOut: 0.18,
        transition: clips.length % 2 ? 'flash' : 'fade',
        transitionDuration: 0.35,
      });
    }
    setProject((prev) => ({
      ...prev,
      name: prev.name === 'Untitled Promo' && clips[0] ? `${clips[0].name} Promo` : prev.name,
      clips: [...prev.clips, ...clips],
      selectedClipId: prev.selectedClipId ?? clips[0]?.id,
    }));
    setTool('trim');
  };

  const importAudioFile = async (file: File) => {
    setExportError(null);
    if (!/audio\//i.test(file.type) && !/\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name)) {
      setExportError('Upload MP3, WAV, M4A, AAC, or OGG audio.');
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
    setTool('audio');
  };

  const updateClip = (patch: Partial<OpenCutClip>) => {
    if (!selectedClip) return;
    setProject((prev) => ({ ...prev, clips: prev.clips.map((clip) => (clip.id === selectedClip.id ? { ...clip, ...patch } : clip)) }));
  };

  const updateAudio = (id: string, patch: Partial<OpenCutAudioTrack>) => {
    setProject((prev) => ({ ...prev, audioTracks: prev.audioTracks.map((track) => (track.id === id ? { ...track, ...patch } : track)) }));
  };

  const removeAudio = (id: string) => setProject((prev) => ({ ...prev, audioTracks: prev.audioTracks.filter((track) => track.id !== id) }));

  const seekTo = (time: number) => {
    if (!selectedClip || !videoRef.current) return;
    const t = clamp(time, selectedClip.start, selectedClip.end);
    videoRef.current.currentTime = t;
    setCurrent(t);
    if (audioRef.current) audioRef.current.currentTime = clamp(currentTimeline, 0, audioRef.current.duration || currentTimeline);
  };

  const seekToTimeline = (timelineTime: number) => {
    const safeTime = clamp(timelineTime, 0, timelineLength);
    const item = clipTimelineItems.find((entry) => safeTime >= entry.start && safeTime <= entry.end) ?? clipTimelineItems[clipTimelineItems.length - 1];
    if (!item) return;
    const localTime = clamp(safeTime - item.start, 0, item.duration);
    const sourceTime = clamp(item.clip.start + localTime * Math.max(0.1, item.clip.speed || 1), item.clip.start, item.clip.end);
    pendingTimelineSeekRef.current = { clipId: item.clip.id, sourceTime };
    setProject((prev) => ({ ...prev, selectedClipId: item.clip.id }));
    requestAnimationFrame(() => {
      if (!videoRef.current) return;
      videoRef.current.currentTime = sourceTime;
      setCurrent(sourceTime);
      if (audioRef.current) audioRef.current.currentTime = safeTime;
    });
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || !selectedClip) return;
    if (video.paused) {
      if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start;
      video.playbackRate = selectedClip.speed;
      video.volume = selectedClip.volume;
      if (audioRef.current && project.audioTracks[0]) {
        audioRef.current.volume = project.audioTracks[0].volume;
        audioRef.current.currentTime = clamp(currentTimeline, 0, audioRef.current.duration || currentTimeline);
        void audioRef.current.play();
      }
      void video.play();
    } else {
      video.pause();
      audioRef.current?.pause();
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

  const createTextLayer = (patch: Partial<OpenCutTextLayer> = {}) => {
    const start = clamp(currentTimeline, 0, Math.max(0, timelineLength - 0.1));
    const end = Math.max(start + 1, Math.min(timelineLength || start + 4, start + 4));
    const layer: OpenCutTextLayer = {
      id: uid('text'),
      text: 'Tap to edit',
      start,
      end,
      x: 50,
      y: 78,
      size: 34,
      weight: 800,
      color: '#ffffff',
      background: true,
      shadow: true,
      uppercase: false,
      animation: 'pop',
      ...patch,
    };
    setProject((prev) => ({ ...prev, textLayers: [...prev.textLayers, layer] }));
    setSelectedTextId(layer.id);
    setTool(isStickerLayer(layer) ? 'stickers' : 'text');
  };

  const addCaption = () => {
    createTextLayer({ text: 'Tap to edit caption', y: 84, size: 34, weight: 900, background: true, shadow: true, animation: 'fade' });
    setTool('captions');
  };

  const addSticker = (emoji: string) => {
    createTextLayer({ text: emoji, y: 48, size: 72, weight: 900, background: false, shadow: true, animation: 'pop' });
    setTool('stickers');
  };

  const updateText = (patch: Partial<OpenCutTextLayer>) => {
    if (!selectedText) return;
    setProject((prev) => ({ ...prev, textLayers: prev.textLayers.map((layer) => (layer.id === selectedText.id ? { ...layer, ...patch } : layer)) }));
  };

  const applyTextPreset = (patch: Partial<OpenCutTextLayer>) => {
    if (selectedText && !isStickerLayer(selectedText)) updateText(patch);
    else createTextLayer(patch);
  };

  const removeText = () => {
    if (!selectedText) return;
    setProject((prev) => ({ ...prev, textLayers: prev.textLayers.filter((layer) => layer.id !== selectedText.id) }));
    setSelectedTextId(null);
  };

  const buildPromo = () => {
    const transitions: OpenCutTransitionType[] = ['fade', 'flash', 'zoom', 'glitch', 'wipe'];
    setProject((prev) => ({
      ...prev,
      clips: prev.clips.map((clip, index) => ({
        ...clip,
        filterPreset: index % 2 ? 'Glow' : 'Punch',
        brightness: index % 2 ? 110 : 104,
        contrast: index % 2 ? 98 : 124,
        saturation: index % 2 ? 118 : 130,
        transition: transitions[index % transitions.length],
        transitionDuration: 0.35,
        fadeIn: 0.18,
        fadeOut: 0.22,
        fit: 'cover',
      })),
      textLayers: prev.textLayers.length
        ? prev.textLayers
        : [
            { id: uid('text'), text: 'NEW DROP', start: 0, end: Math.max(3, projectDuration(prev.clips)), x: 50, y: 18, size: 52, weight: 900, color: '#ffffff', background: false, shadow: true, uppercase: true, animation: 'pop' },
            { id: uid('text'), text: '@treytrizzy', start: 0, end: Math.max(3, projectDuration(prev.clips)), x: 50, y: 88, size: 32, weight: 900, color: '#f5d0fe', background: true, shadow: true, uppercase: false, animation: 'glow' },
          ],
    }));
    setTool('text');
  };

  const resetVisuals = () => updateClip({ filterPreset: 'Clean', brightness: 100, contrast: 100, saturation: 100, blur: 0, opacity: 1, fadeIn: 0, fadeOut: 0 });
  const resetTransform = () => updateClip({ rotate: 0, flipX: false, fit: 'contain' });

  const saveProject = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-promo-project.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportVideo = async () => {
    if (!project.clips.length) return;
    setExporting(true);
    setExportError(null);
    setExportProgress(0);
    try {
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      const target = project.aspect === '16:9'
        ? { w: 1280, h: 720 }
        : project.aspect === '1:1'
          ? { w: 1080, h: 1080 }
          : project.aspect === 'original' && selectedClip && selectedClip.width > selectedClip.height
            ? { w: 1280, h: 720 }
            : { w: 1080, h: 1920 };
      const rendered = await exportOpenCutRender({
        clips: project.clips,
        textLayers: project.textLayers,
        audioTracks: project.audioTracks,
        width: target.w,
        height: target.h,
        fps: 30,
        onProgress: setExportProgress,
      });
      setExportUrl(rendered.url);
      setExportMimeType(rendered.mimeType);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const downloadExport = () => {
    if (!exportUrl) return;
    const extension = exportMimeType.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = exportUrl;
    a.download = `${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-promo-cut.${extension}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const onVideoInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) void importVideoFiles(event.target.files);
    event.currentTarget.value = '';
  };

  const onAudioInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importAudioFile(file);
    event.currentTarget.value = '';
  };

  const renderTimelineLane = (
    label: string,
    Icon: typeof Scissors,
    emptyLabel: string,
    children: React.ReactNode,
  ) => (
    <div className="grid grid-cols-[4.8rem_1fr] gap-2 rounded-2xl bg-black/25 p-2 ring-1 ring-white/10">
      <button onClick={() => setTool(label.toLowerCase() as Tool)} className="flex min-h-10 items-center gap-1.5 rounded-xl bg-white/[0.06] px-2 text-left text-[10px] font-black uppercase tracking-wide text-white/60 ring-1 ring-white/10">
        <Icon className="h-3.5 w-3.5" /> {label}
      </button>
      <div className="relative min-h-10 overflow-hidden rounded-xl bg-white/[0.045] ring-1 ring-white/10" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const pct = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        seekToTimeline(pct * timelineLength);
      }}>
        <div className="absolute inset-y-0 w-px bg-white/80 shadow-[0_0_12px_rgba(255,255,255,0.9)]" style={{ left: `${clamp((currentTimeline / timelineLength) * 100, 0, 100)}%` }} />
        {children || <div className="flex h-full items-center px-3 text-[10px] font-semibold text-white/25">{emptyLabel}</div>}
      </div>
    </div>
  );

  const firstAudio = project.audioTracks[0];

  return (
    <div className="min-h-dvh overflow-x-hidden bg-[#03030a] text-white pb-safe">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 opacity-90" style={{ background: 'radial-gradient(circle at 50% -10%, rgba(168, 85, 247, 0.32), transparent 34%), radial-gradient(circle at 110% 18%, rgba(37, 99, 235, 0.22), transparent 28%), linear-gradient(180deg, #03030a 0%, #080817 52%, #03030a 100%)' }} />
      {firstAudio ? <audio ref={audioRef} src={firstAudio.url} preload="auto" /> : null}

      <input ref={videoFileRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/*" multiple hidden onChange={onVideoInput} />
      <input ref={audioFileRef} type="file" accept="audio/mp3,audio/wav,audio/m4a,audio/aac,audio/ogg,audio/*" hidden onChange={onAudioInput} />

      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#050510]/85 pt-safe backdrop-blur-2xl">
        <div className="mx-auto flex h-16 max-w-[430px] items-center gap-3 px-4 px-safe">
          <a aria-label="Back to home" href="/" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/[0.08] text-white ring-1 ring-white/10 active:scale-95"><ArrowLeft className="h-5 w-5" /></a>
          <div className="min-w-0 flex-1">
            <input aria-label="Project name" value={project.name} onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))} className="w-full truncate bg-transparent text-[15px] font-black tracking-tight text-white outline-none placeholder:text-white/30" />
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold text-white/50"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.9)]" /> Promo Studio · {project.clips.length} clips · {project.audioTracks.length} audio</div>
          </div>
          <button onClick={saveProject} className="rounded-full bg-white/[0.09] px-3 py-2 text-xs font-bold text-white ring-1 ring-white/10 active:scale-95">Save</button>
          <button onClick={() => setTool('export')} className="rounded-full bg-white px-4 py-2 text-xs font-black text-slate-950 shadow-[0_10px_30px_rgba(255,255,255,0.18)] active:scale-95">Export</button>
        </div>
      </header>

      {!selectedClip ? (
        <main className="relative mx-auto flex min-h-[calc(100dvh-4rem)] max-w-[430px] flex-col px-4 px-safe pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5">
          <section className="relative overflow-hidden rounded-[38px] border border-white/10 bg-white/[0.07] p-5 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <div aria-hidden="true" className="absolute inset-0 opacity-80" style={{ background: 'linear-gradient(145deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 48%, rgba(124,58,237,0.16))' }} />
            <div className="relative">
              <div className="mb-5 flex items-center justify-between">
                <div className="inline-flex items-center gap-2 rounded-full bg-black/30 px-3 py-1.5 text-[11px] font-bold text-violet-100 ring-1 ring-white/10"><Sparkles className="h-3.5 w-3.5 text-violet-300" /> Promo video builder</div>
                <div className="rounded-full bg-emerald-400/10 px-3 py-1.5 text-[11px] font-bold text-emerald-200 ring-1 ring-emerald-300/20">Mobile ready</div>
              </div>
              <h1 className="max-w-sm text-4xl font-black leading-[0.95] tracking-tight text-white">Cut a promo that feels ready to post.</h1>
              <p className="mt-4 max-w-sm text-[15px] leading-6 text-white/60">Import a compilation of clips, add music or voiceover, stack animated text, and export a social-ready promo.</p>
              <div className="mt-5 flex flex-wrap gap-2">{QUALITY_CHIPS.map((chip) => <span key={chip} className="rounded-full bg-white/[0.08] px-3 py-1.5 text-[11px] font-bold text-white/75 ring-1 ring-white/10">{chip}</span>)}</div>
              <button onClick={() => videoFileRef.current?.click()} className="mt-7 flex min-h-14 w-full items-center justify-center gap-2 rounded-[22px] bg-white px-5 py-4 text-base font-black text-slate-950 shadow-[0_18px_50px_rgba(255,255,255,0.18)] active:scale-[0.985]"><Upload className="h-5 w-5" /> Import video clips</button>
            </div>
          </section>

          <section className="mt-4 rounded-[30px] border border-white/10 bg-black/25 p-4 backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-black tracking-tight">First-time flow</h2><span className="text-[11px] font-semibold text-white/50">3 steps</span></div>
            <div className="space-y-3">{FIRST_RUN_STEPS.map(({ icon: Icon, title, body }, index) => <div key={title} className="flex gap-3 rounded-[22px] bg-white/[0.055] p-3 ring-1 ring-white/10"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/[0.08] text-white ring-1 ring-white/10"><Icon className="h-5 w-5" /></div><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-mono text-[10px] text-violet-200">0{index + 1}</span><h3 className="text-sm font-extrabold text-white">{title}</h3></div><p className="mt-1 text-xs leading-5 text-white/50">{body}</p></div></div>)}</div>
          </section>
        </main>
      ) : (
        <main className="relative mx-auto max-w-[430px] px-3 px-safe pb-[calc(env(safe-area-inset-bottom)+6.2rem)] pt-3">
          <section className="relative overflow-hidden rounded-[34px] border border-white/10 bg-black/55 p-2 shadow-[0_30px_90px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
            <div className="mb-2 flex items-center justify-between px-2 pt-1"><div className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-1.5 text-[11px] font-bold text-white/75 ring-1 ring-white/10"><Layers className="h-3.5 w-3.5 text-violet-200" /> {selectedClip.filterPreset || 'Preview'} · {selectedClip.transition || 'none'}</div><div className="rounded-full bg-black/40 px-3 py-1.5 font-mono text-[11px] text-white/60 ring-1 ring-white/10">{formatTime(currentTimeline)}</div></div>
            <div className={`relative mx-auto max-h-[43dvh] overflow-hidden rounded-[28px] bg-black ${aspectClass(project.aspect, selectedClip)}`}>
              <video ref={videoRef} playsInline muted controls={false} style={clipStyle(selectedClip)} className="absolute inset-0 h-full w-full transition duration-200" />
              {project.textLayers.map((layer) => {
                const visible = currentTimeline >= layer.start && currentTimeline <= layer.end;
                if (!visible) return null;
                const text = layer.uppercase ? layer.text.toUpperCase() : layer.text;
                return <button key={layer.id} onClick={() => { setSelectedTextId(layer.id); setTool(isStickerLayer(layer) ? 'stickers' : 'text'); }} className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl px-3 py-1.5 text-center font-black leading-tight ring-1 ring-white/10 transition ${textPreviewClass(layer.animation)} ${layer.background ? 'bg-black/60 backdrop-blur-md' : ''} ${layer.shadow ? 'drop-shadow-[0_8px_16px_rgba(0,0,0,0.75)]' : ''}`} style={{ left: `${layer.x}%`, top: `${layer.y}%`, color: layer.color, fontSize: `${Math.max(14, layer.size / 3.2)}px` }}>{text}</button>;
              })}
              <button onClick={togglePlay} aria-label={playing ? 'Pause video' : 'Play video'} className="absolute left-1/2 top-1/2 grid h-[4.35rem] w-[4.35rem] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white shadow-[0_16px_45px_rgba(0,0,0,0.45)] ring-1 ring-white/20 backdrop-blur-xl active:scale-95">{playing ? <Pause className="h-8 w-8" /> : <Play className="ml-1 h-8 w-8" />}</button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 px-1 text-center text-[11px]"><div className="rounded-2xl bg-white/[0.055] px-2 py-2 ring-1 ring-white/10"><span className="block text-white/40">Clips</span><span className="font-mono text-white/70">{project.clips.length}</span></div><div className="rounded-2xl bg-white/[0.055] px-2 py-2 ring-1 ring-white/10"><span className="block text-white/40">Timeline</span><span className="font-mono text-white/70">{formatTime(timelineLength)}</span></div><div className="rounded-2xl bg-white/[0.055] px-2 py-2 ring-1 ring-white/10"><span className="block text-white/40">Aspect</span><span className="font-mono text-white/70">{project.aspect}</span></div></div>
          </section>

          <section className="mt-3 rounded-[28px] border border-white/10 bg-white/[0.06] p-3 shadow-[0_18px_55px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="mb-2 flex items-center justify-between text-xs text-white/60"><span>{formatTime(selectedClip.start)}</span><span className="font-black text-white">Selected clip</span><span>{formatTime(selectedClip.end)}</span></div>
            <input type="range" min={selectedClip.start} max={selectedClip.end} step={0.01} value={clamp(current, selectedClip.start, selectedClip.end)} onChange={(e) => seekTo(Number(e.target.value))} className="w-full accent-violet-500" />
            <div className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1">{(thumbs.length ? thumbs : new Array(10).fill('')).map((src, i) => <button key={i} onClick={() => seekTo(selectedClip.start + ((selectedClip.end - selectedClip.start) * i) / Math.max(1, thumbs.length - 1))} className="h-14 w-10 shrink-0 overflow-hidden rounded-xl bg-slate-900 ring-1 ring-white/10 active:scale-95">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : null}</button>)}</div>
            <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">{project.clips.map((clip, index) => <button key={clip.id} onClick={() => setProject((p) => ({ ...p, selectedClipId: clip.id }))} className={`min-w-32 rounded-2xl px-3 py-2 text-left text-xs ring-1 active:scale-95 ${clip.id === selectedClip.id ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.055] text-white/60 ring-white/10'}`}><span className="block truncate font-black">{index + 1}. {clip.name}</span><span className="font-mono text-[10px] opacity-70">{formatTime(segmentDuration(clip))} · {clip.transition || 'none'}</span></button>)}</div>
          </section>

          <section className="mt-3 rounded-[28px] border border-white/10 bg-white/[0.06] p-3 shadow-[0_18px_55px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-black">Layer timeline</h2>
                <p className="text-[11px] text-white/40">Video, audio, text, and stickers stay on separate lines.</p>
              </div>
              <div className="font-mono text-[11px] text-white/45">{formatTime(currentTimeline)} / {formatTime(timelineLength)}</div>
            </div>
            <div className="space-y-2">
              {renderTimelineLane('Video', Film, 'Import video clips', clipTimelineItems.map((item) => <button key={item.clip.id} onClick={(event) => { event.stopPropagation(); setProject((p) => ({ ...p, selectedClipId: item.clip.id })); seekToTimeline(item.start); }} className={`absolute inset-y-1 rounded-lg px-2 text-left text-[10px] font-black leading-8 ring-1 active:scale-[0.99] ${item.clip.id === selectedClip.id ? 'bg-white text-slate-950 ring-white' : 'bg-violet-400/70 text-white ring-violet-200/40'}`} style={timelinePercent(item.start, item.end, timelineLength)}>{item.index + 1}. {item.clip.name}</button>))}
              {renderTimelineLane('Audio', Volume2, 'No audio yet', project.audioTracks.map((track) => <button key={track.id} onClick={(event) => { event.stopPropagation(); setTool('audio'); seekToTimeline(track.start); }} className="absolute inset-y-1 rounded-lg bg-emerald-400/75 px-2 text-left text-[10px] font-black leading-8 text-slate-950 ring-1 ring-emerald-200/50 active:scale-[0.99]" style={timelinePercent(track.start, track.start + track.duration, timelineLength)}>{track.name}</button>))}
              {renderTimelineLane('Text', Type, 'No text layers', textTimelineLayers.map((layer) => <button key={layer.id} onClick={(event) => { event.stopPropagation(); setSelectedTextId(layer.id); setTool('text'); seekToTimeline(layer.start); }} className="absolute inset-y-1 rounded-lg bg-fuchsia-400/75 px-2 text-left text-[10px] font-black leading-8 text-slate-950 ring-1 ring-fuchsia-200/50 active:scale-[0.99]" style={timelinePercent(layer.start, layer.end, timelineLength)}>{layer.text}</button>))}
              {renderTimelineLane('Stickers', Sparkles, 'No stickers yet', stickerTimelineLayers.map((layer) => <button key={layer.id} onClick={(event) => { event.stopPropagation(); setSelectedTextId(layer.id); setTool('stickers'); seekToTimeline(layer.start); }} className="absolute inset-y-1 rounded-lg bg-amber-300/80 px-2 text-left text-[10px] font-black leading-8 text-slate-950 ring-1 ring-amber-100/50 active:scale-[0.99]" style={timelinePercent(layer.start, layer.end, timelineLength)}>{layer.text}</button>))}
            </div>
          </section>

          <section className="mt-3 min-h-44 rounded-[28px] border border-white/10 bg-white/[0.065] p-4 shadow-[0_18px_55px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><div className="grid h-9 w-9 place-items-center rounded-2xl bg-white/[0.08] ring-1 ring-white/10"><ActiveToolIcon className="h-4 w-4" /></div><div><h3 className="text-sm font-black">{activeTool.label}</h3><p className="text-[11px] text-white/40">Promo builder tool</p></div></div><button onClick={() => videoFileRef.current?.click()} className="rounded-full bg-white/[0.08] px-3 py-2 text-[11px] font-bold text-white/70 ring-1 ring-white/10 active:scale-95">Add clips</button></div>

            {tool === 'trim' && <div className="space-y-4"><button onClick={buildPromo} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 font-black text-slate-950 active:scale-[0.985]"><Sparkles className="h-5 w-5" /> Auto-style promo</button><div className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10"><label className="block text-xs font-bold text-white/60">Start · {formatTime(selectedClip.start)}</label><input className="mt-1 w-full accent-violet-500" type="range" min={0} max={selectedClip.duration} step={0.01} value={selectedClip.start} onChange={(e) => updateClip({ start: clamp(Number(e.target.value), 0, selectedClip.end - 0.1) })} /></div><div className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10"><label className="block text-xs font-bold text-white/60">End · {formatTime(selectedClip.end)}</label><input className="mt-1 w-full accent-violet-500" type="range" min={0} max={selectedClip.duration} step={0.01} value={selectedClip.end} onChange={(e) => updateClip({ end: clamp(Number(e.target.value), selectedClip.start + 0.1, selectedClip.duration) })} /></div></div>}

            {tool === 'split' && <div className="space-y-3"><button onClick={splitAtPlayhead} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 font-black text-slate-950 active:scale-[0.985]"><SplitSquareHorizontal className="h-5 w-5" /> Split at playhead</button><div className="grid grid-cols-2 gap-2"><button onClick={duplicateClip} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white/[0.09] px-4 py-3 font-bold ring-1 ring-white/10"><Copy className="h-4 w-4" /> Duplicate</button><button onClick={deleteClip} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-red-500/20 px-4 py-3 font-bold text-red-100 ring-1 ring-red-300/20"><Trash2 className="h-4 w-4" /> Delete</button></div></div>}

            {tool === 'text' && <div className="space-y-3"><div className="flex items-center justify-between"><p className="text-xs leading-5 text-white/50">Titles, hooks, lower thirds, and animated promo text.</p><button onClick={() => createTextLayer()} className="rounded-full bg-white px-3 py-2 text-xs font-black text-slate-950"><Plus className="inline h-3.5 w-3.5" /> Add</button></div><div className="grid grid-cols-2 gap-2 text-xs">{TEXT_PRESETS.map((preset) => <button key={preset.label} onClick={() => applyTextPreset(preset.patch)} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">{preset.label}</button>)}</div>{selectedText ? <><input value={selectedText.text} onChange={(e) => updateText({ text: e.target.value })} className="w-full rounded-2xl bg-black/30 px-4 py-3 text-sm font-semibold outline-none ring-1 ring-white/10" /><div className="grid grid-cols-2 gap-2 text-xs text-white/60"><label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">Start · {formatTime(selectedText.start)}<input type="range" min={0} max={timelineLength} step={0.05} value={selectedText.start} onChange={(e) => updateText({ start: clamp(Number(e.target.value), 0, selectedText.end - 0.1) })} className="w-full accent-violet-500" /></label><label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">End · {formatTime(selectedText.end)}<input type="range" min={0.1} max={timelineLength} step={0.05} value={selectedText.end} onChange={(e) => updateText({ end: clamp(Number(e.target.value), selectedText.start + 0.1, timelineLength) })} className="w-full accent-violet-500" /></label><label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">Y position<input type="range" min={10} max={90} value={selectedText.y} onChange={(e) => updateText({ y: Number(e.target.value) })} className="w-full accent-violet-500" /></label><label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">Size<input type="range" min={22} max={96} value={selectedText.size} onChange={(e) => updateText({ size: Number(e.target.value) })} className="w-full accent-violet-500" /></label></div><div className="grid grid-cols-3 gap-2 text-xs"><button onClick={() => updateText({ background: !selectedText.background })} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">BG</button><button onClick={() => updateText({ shadow: !selectedText.shadow })} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Shadow</button><button onClick={() => updateText({ uppercase: !selectedText.uppercase })} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Caps</button></div><div className="grid grid-cols-3 gap-2 text-xs">{TEXT_ANIMATIONS.map((animation) => <button key={animation} onClick={() => updateText({ animation })} className={`rounded-2xl px-3 py-3 font-bold ring-1 ${selectedText.animation === animation ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>{animation}</button>)}</div><button onClick={removeText} className="rounded-2xl bg-red-500/20 px-3 py-2 text-xs font-bold text-red-100 ring-1 ring-red-300/20">Remove text</button></> : <button onClick={() => createTextLayer()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white/[0.09] px-4 py-4 text-sm font-bold text-white/80 ring-1 ring-white/10"><Captions className="h-4 w-4" /> Add your first text layer</button>}</div>}

            {tool === 'captions' && <div className="space-y-3"><button onClick={addCaption} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 font-black text-slate-950"><Captions className="h-5 w-5" /> Add caption bar</button><div className="grid grid-cols-2 gap-2 text-xs"><button onClick={() => applyTextPreset({ y: 84, size: 32, background: true, shadow: true, animation: 'fade' })} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Bottom captions</button><button onClick={() => applyTextPreset({ y: 16, size: 34, background: false, shadow: true, uppercase: true, animation: 'typewriter' })} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Top hook</button></div><p className="text-xs leading-5 text-white/40">Caption layers appear on the Text line and export with the render.</p></div>}

            {tool === 'stickers' && <div className="space-y-3"><div className="grid grid-cols-6 gap-2 text-2xl">{STICKERS.map((emoji) => <button key={emoji} onClick={() => addSticker(emoji)} className="grid min-h-12 place-items-center rounded-2xl bg-white/[0.08] ring-1 ring-white/10 active:scale-95">{emoji}</button>)}</div>{selectedText && isStickerLayer(selectedText) ? <div className="grid grid-cols-2 gap-2 text-xs text-white/60"><label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">Start · {formatTime(selectedText.start)}<input type="range" min={0} max={timelineLength} step={0.05} value={selectedText.start} onChange={(e) => updateText({ start: clamp(Number(e.target.value), 0, selectedText.end - 0.1) })} className="w-full accent-violet-500" /></label><label className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10">End · {formatTime(selectedText.end)}<input type="range" min={0.1} max={timelineLength} step={0.05} value={selectedText.end} onChange={(e) => updateText({ end: clamp(Number(e.target.value), selectedText.start + 0.1, timelineLength) })} className="w-full accent-violet-500" /></label></div> : null}<p className="text-xs leading-5 text-white/40">Emoji stickers sit on their own Sticker line, separate from text captions.</p></div>}

            {tool === 'audio' && <div className="space-y-3"><button onClick={() => audioFileRef.current?.click()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 font-black text-slate-950"><Music2 className="h-5 w-5" /> Add audio file</button>{project.audioTracks.map((track) => <div key={track.id} className="rounded-2xl bg-black/25 p-3 ring-1 ring-white/10"><div className="mb-2 flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-black">{track.name}</p><p className="font-mono text-[10px] text-white/40">{formatTime(track.start)} → {formatTime(track.start + track.duration)}</p></div><button onClick={() => removeAudio(track.id)} className="rounded-full bg-red-500/20 px-3 py-2 text-[11px] font-bold text-red-100">Remove</button></div><div className="grid grid-cols-2 gap-2"><label className="block text-xs font-bold text-white/60">Start · {formatTime(track.start)}<input type="range" min={0} max={timelineLength} step={0.05} value={track.start} onChange={(e) => updateAudio(track.id, { start: Number(e.target.value) })} className="mt-1 w-full accent-violet-500" /></label><label className="block text-xs font-bold text-white/60">Volume · {Math.round(track.volume * 100)}%<input type="range" min={0} max={1} step={0.01} value={track.volume} onChange={(e) => updateAudio(track.id, { volume: Number(e.target.value) })} className="mt-1 w-full accent-violet-500" /></label></div></div>)}<p className="text-xs leading-5 text-white/40">Preview uses the first audio track. The new Audio line shows where every imported track starts.</p></div>}

            {tool === 'speed' && <div className="space-y-3"><div className="grid grid-cols-4 gap-2">{[0.5, 0.75, 1, 1.5, 2, 3, 4, 0.25].map((speed) => <button key={speed} onClick={() => updateClip({ speed })} className={`min-h-12 rounded-2xl px-3 py-3 text-sm font-black ring-1 active:scale-95 ${selectedClip.speed === speed ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>{speed}×</button>)}</div></div>}

            {tool === 'transitions' && <div className="space-y-3"><div className="grid grid-cols-3 gap-2 text-xs">{TRANSITIONS.map((transition) => <button key={transition} onClick={() => updateClip({ transition })} className={`min-h-12 rounded-2xl px-3 py-3 font-black ring-1 active:scale-95 ${selectedClip.transition === transition ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>{transition}</button>)}</div><label className="block rounded-2xl bg-black/25 p-3 text-xs font-bold text-white/60 ring-1 ring-white/10">Transition length · {(selectedClip.transitionDuration ?? 0.35).toFixed(2)}s<input type="range" min={0.1} max={1.25} step={0.05} value={selectedClip.transitionDuration ?? 0.35} onChange={(e) => updateClip({ transitionDuration: Number(e.target.value) })} className="w-full accent-violet-500" /></label></div>}

            {tool === 'filters' && <div className="space-y-3"><div className="grid grid-cols-4 gap-2 text-xs">{FILTER_PRESETS.map((preset) => <button key={preset.label} onClick={() => updateClip(preset.patch)} className={`min-h-14 rounded-2xl px-2 py-3 font-black ring-1 active:scale-95 ${selectedClip.filterPreset === preset.label ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>{preset.label}</button>)}</div><div className="grid grid-cols-3 gap-2 text-xs"><button onClick={() => updateClip({ fadeIn: 0.35 })} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Fade in</button><button onClick={() => updateClip({ fadeOut: 0.35 })} className="rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Fade out</button><button onClick={resetVisuals} className="rounded-2xl bg-red-500/20 px-3 py-3 font-bold text-red-100 ring-1 ring-red-300/20">Reset</button></div></div>}

            {tool === 'adjust' && <div className="space-y-3"><label className="block rounded-2xl bg-black/25 p-3 text-xs font-bold text-white/60 ring-1 ring-white/10">Brightness · {selectedClip.brightness ?? 100}%<input type="range" min={50} max={150} value={selectedClip.brightness ?? 100} onChange={(e) => updateClip({ brightness: Number(e.target.value), filterPreset: 'Custom' })} className="w-full accent-violet-500" /></label><label className="block rounded-2xl bg-black/25 p-3 text-xs font-bold text-white/60 ring-1 ring-white/10">Contrast · {selectedClip.contrast ?? 100}%<input type="range" min={50} max={170} value={selectedClip.contrast ?? 100} onChange={(e) => updateClip({ contrast: Number(e.target.value), filterPreset: 'Custom' })} className="w-full accent-violet-500" /></label><label className="block rounded-2xl bg-black/25 p-3 text-xs font-bold text-white/60 ring-1 ring-white/10">Saturation · {selectedClip.saturation ?? 100}%<input type="range" min={0} max={180} value={selectedClip.saturation ?? 100} onChange={(e) => updateClip({ saturation: Number(e.target.value), filterPreset: 'Custom' })} className="w-full accent-violet-500" /></label><div className="grid grid-cols-2 gap-2"><label className="block rounded-2xl bg-black/25 p-3 text-xs font-bold text-white/60 ring-1 ring-white/10">Blur · {selectedClip.blur ?? 0}px<input type="range" min={0} max={6} step={0.1} value={selectedClip.blur ?? 0} onChange={(e) => updateClip({ blur: Number(e.target.value), filterPreset: 'Custom' })} className="w-full accent-violet-500" /></label><label className="block rounded-2xl bg-black/25 p-3 text-xs font-bold text-white/60 ring-1 ring-white/10">Opacity · {Math.round((selectedClip.opacity ?? 1) * 100)}%<input type="range" min={0.2} max={1} step={0.01} value={selectedClip.opacity ?? 1} onChange={(e) => updateClip({ opacity: Number(e.target.value) })} className="w-full accent-violet-500" /></label></div></div>}

            {tool === 'transform' && <div className="space-y-3"><div className="grid grid-cols-2 gap-2"><button onClick={() => updateClip({ rotate: ((selectedClip.rotate ?? 0) + 90) % 360 })} className="min-h-12 rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Rotate 90°</button><button onClick={() => updateClip({ flipX: !selectedClip.flipX })} className="min-h-12 rounded-2xl bg-white/[0.08] px-3 py-3 font-bold ring-1 ring-white/10">Flip</button><button onClick={() => updateClip({ fit: 'contain' })} className={`min-h-12 rounded-2xl px-3 py-3 font-bold ring-1 ${selectedClip.fit !== 'cover' ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>Fit</button><button onClick={() => updateClip({ fit: 'cover' })} className={`min-h-12 rounded-2xl px-3 py-3 font-bold ring-1 ${selectedClip.fit === 'cover' ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>Fill</button></div><button onClick={resetTransform} className="w-full rounded-2xl bg-red-500/20 px-3 py-3 text-xs font-bold text-red-100 ring-1 ring-red-300/20">Reset transform</button></div>}

            {tool === 'canvas' && <div className="space-y-3"><div className="grid grid-cols-4 gap-2 text-xs">{ASPECTS.map((aspect) => <button key={aspect} onClick={() => setProject((p) => ({ ...p, aspect }))} className={`min-h-12 rounded-2xl px-2 py-3 font-black ring-1 ${project.aspect === aspect ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.08] text-white ring-white/10'}`}>{aspect}</button>)}</div></div>}

            {tool === 'export' && <div className="space-y-3"><div className="rounded-2xl bg-black/25 p-3 text-xs leading-5 text-white/55 ring-1 ring-white/10">Exports the full promo compilation: all clips in sequence, project-level text/captions/stickers, transitions, filters, speed, and capturable audio tracks.</div><button onClick={exportVideo} disabled={exporting} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 font-black text-slate-950 disabled:opacity-55">{exporting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />} {exporting ? `Rendering ${Math.round(exportProgress)}%` : 'Render promo video'}</button>{exportUrl && <button onClick={downloadExport} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-400 px-4 py-3 font-black text-slate-950"><Check className="h-5 w-5" /> Download export</button>}{exportError && <div className="rounded-2xl bg-red-500/15 p-3 text-xs font-bold text-red-100 ring-1 ring-red-300/20">{exportError}</div>}</div>}
          </section>

          <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-[#050510]/90 pb-safe backdrop-blur-2xl">
            <div className="no-scrollbar mx-auto flex max-w-[430px] gap-2 overflow-x-auto px-3 py-3">
              {TOOLS.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setTool(id)} className={`flex min-w-[4.75rem] flex-col items-center gap-1 rounded-2xl px-3 py-2 text-[10px] font-black ring-1 active:scale-95 ${tool === id ? 'bg-white text-slate-950 ring-white' : 'bg-white/[0.07] text-white/60 ring-white/10'}`}><Icon className="h-4 w-4" />{label}</button>)}
            </div>
          </nav>
        </main>
      )}
    </div>
  );
}
