import type { OpenCutAudioTrack, OpenCutClip, OpenCutProject, OpenCutTextLayer } from './types';
import { clipOutputDuration, normalizeTimelineConfig, projectDuration } from './timeline';

export type OpenCutOptimizationSeverity = 'info' | 'warning' | 'critical';

export interface OpenCutOptimizationIssue {
  id: string;
  severity: OpenCutOptimizationSeverity;
  title: string;
  detail: string;
  fixHint: string;
}

export interface OpenCutProjectOptimizationReport {
  duration: number;
  clipCount: number;
  audioTrackCount: number;
  textLayerCount: number;
  estimatedPreviewLoad: 'light' | 'medium' | 'heavy';
  issues: OpenCutOptimizationIssue[];
}

export interface OpenCutNormalizeProjectOptions {
  maxClipDuration?: number;
  defaultTransitionDuration?: number;
  defaultFadeSeconds?: number;
  defaultAudioVolume?: number;
}

export function normalizeOpenCutClip(clip: OpenCutClip, options: OpenCutNormalizeProjectOptions = {}): OpenCutClip {
  const duration = Math.max(0.1, clip.duration || clip.end || 0.1);
  const start = clamp(Number.isFinite(clip.start) ? clip.start : 0, 0, Math.max(0, duration - 0.05));
  const maxEnd = options.maxClipDuration ? Math.min(duration, start + options.maxClipDuration) : duration;
  const end = clamp(Number.isFinite(clip.end) ? clip.end : maxEnd, start + 0.05, duration);
  const transitionDuration = clamp(
    Number.isFinite(clip.transitionDuration ?? NaN) ? clip.transitionDuration ?? 0 : options.defaultTransitionDuration ?? 0.35,
    0,
    Math.min(1.25, (end - start) / 2),
  );

  return {
    ...clip,
    duration,
    start,
    end,
    speed: clamp(clip.speed || 1, 0.1, 8),
    volume: clamp(clip.volume ?? 1, 0, 1),
    brightness: clamp(clip.brightness ?? 100, 0, 200),
    contrast: clamp(clip.contrast ?? 100, 0, 200),
    saturation: clamp(clip.saturation ?? 100, 0, 250),
    blur: clamp(clip.blur ?? 0, 0, 24),
    opacity: clamp(clip.opacity ?? 1, 0, 1),
    rotate: clamp(clip.rotate ?? 0, -360, 360),
    fit: clip.fit ?? 'contain',
    fadeIn: clamp(clip.fadeIn ?? options.defaultFadeSeconds ?? 0, 0, (end - start) / 2),
    fadeOut: clamp(clip.fadeOut ?? options.defaultFadeSeconds ?? 0, 0, (end - start) / 2),
    transition: clip.transition ?? 'none',
    transitionDuration,
  };
}

export function normalizeOpenCutAudioTrack(track: OpenCutAudioTrack, options: OpenCutNormalizeProjectOptions = {}): OpenCutAudioTrack {
  const duration = Math.max(0.1, track.duration || 0.1);
  return {
    ...track,
    duration,
    start: Math.max(0, track.start || 0),
    volume: clamp(track.volume ?? options.defaultAudioVolume ?? 0.85, 0, 1),
    fadeIn: clamp(track.fadeIn ?? 0, 0, duration / 2),
    fadeOut: clamp(track.fadeOut ?? 0, 0, duration / 2),
  };
}

export function normalizeOpenCutTextLayer(layer: OpenCutTextLayer, projectLength: number): OpenCutTextLayer {
  const start = clamp(layer.start || 0, 0, Math.max(0, projectLength));
  const end = clamp(layer.end || Math.min(projectLength, start + 3), start + 0.25, Math.max(start + 0.25, projectLength || start + 3));
  return {
    ...layer,
    text: layer.text || 'Text',
    start,
    end,
    x: clamp(layer.x ?? 50, 0, 100),
    y: clamp(layer.y ?? 50, 0, 100),
    size: clamp(layer.size || 34, 10, 160),
    weight: clamp(layer.weight || 800, 100, 1000),
    color: layer.color || '#ffffff',
    background: Boolean(layer.background),
  };
}

export function normalizeOpenCutProject(project: OpenCutProject, options: OpenCutNormalizeProjectOptions = {}): OpenCutProject {
  const timeline = normalizeTimelineConfig(project.timeline);
  const clips = project.clips.map((clip) => normalizeOpenCutClip(clip, {
    defaultTransitionDuration: timeline.defaultTransitionDuration,
    defaultAudioVolume: timeline.audioDefaultVolume,
    ...options,
  }));
  const length = projectDuration(clips, timeline);
  return {
    ...project,
    timeline,
    clips,
    audioTracks: project.audioTracks.map((track) => normalizeOpenCutAudioTrack(track, { defaultAudioVolume: timeline.audioDefaultVolume, ...options })),
    textLayers: project.textLayers.map((layer) => normalizeOpenCutTextLayer(layer, length)),
    selectedClipId: project.selectedClipId && clips.some((clip) => clip.id === project.selectedClipId) ? project.selectedClipId : clips[0]?.id,
  };
}

export function analyzeOpenCutProject(project: OpenCutProject): OpenCutProjectOptimizationReport {
  const timeline = normalizeTimelineConfig(project.timeline);
  const duration = projectDuration(project.clips, timeline);
  const issues: OpenCutOptimizationIssue[] = [];
  const heavyClips = project.clips.filter((clip) => clip.width >= 3000 || clip.height >= 3000);
  const longClips = project.clips.filter((clip) => clipOutputDuration(clip, timeline) > 45);
  const highEffectClips = project.clips.filter((clip) => (clip.blur ?? 0) > 4 || (clip.saturation ?? 100) > 160 || (clip.contrast ?? 100) > 160);

  if (project.clips.length > 30) {
    issues.push({
      id: 'many-clips',
      severity: 'warning',
      title: 'Large clip stack',
      detail: 'More than 30 clips can make mobile preview and export slower.',
      fixHint: 'Use proxy preview, collapse short B-roll sequences, or export in sections.',
    });
  }

  if (heavyClips.length) {
    issues.push({
      id: 'heavy-source-media',
      severity: 'warning',
      title: 'High-resolution source media',
      detail: `${heavyClips.length} clip(s) are 3K/4K-class source files.`,
      fixHint: 'Generate mobile preview proxies while preserving original media for final export.',
    });
  }

  if (longClips.length) {
    issues.push({
      id: 'long-untrimmed-clips',
      severity: 'info',
      title: 'Long untrimmed clips',
      detail: `${longClips.length} clip(s) run longer than 45 seconds after speed adjustment.`,
      fixHint: 'Trim to the most useful section before stacking transitions and effects.',
    });
  }

  if (project.audioTracks.length > 4) {
    issues.push({
      id: 'many-audio-tracks',
      severity: 'warning',
      title: 'Many audio layers',
      detail: 'Multiple audio layers increase sync and export complexity on mobile browsers.',
      fixHint: 'Group voice/music/fx tracks into buses before final export when possible.',
    });
  }

  if (highEffectClips.length) {
    issues.push({
      id: 'heavy-effects',
      severity: 'info',
      title: 'Heavy visual effects',
      detail: `${highEffectClips.length} clip(s) use intense blur/saturation/contrast settings.`,
      fixHint: 'Use proxy preview for editing, then render final quality at export.',
    });
  }

  if (duration > 180) {
    issues.push({
      id: 'long-mobile-project',
      severity: 'warning',
      title: 'Long mobile project',
      detail: 'Projects over three minutes are more likely to hit mobile memory, thermal, and browser background limits.',
      fixHint: 'Use native/cloud export for long-form edits or split into chapters.',
    });
  }

  const loadScore = project.clips.length + heavyClips.length * 3 + project.audioTracks.length + project.textLayers.length * 0.5 + duration / 30;
  const estimatedPreviewLoad = loadScore > 45 ? 'heavy' : loadScore > 18 ? 'medium' : 'light';

  return {
    duration,
    clipCount: project.clips.length,
    audioTrackCount: project.audioTracks.length,
    textLayerCount: project.textLayers.length,
    estimatedPreviewLoad,
    issues,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
