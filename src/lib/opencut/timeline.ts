import type { OpenCutClip, OpenCutTimelineConfig } from './types';

export const DEFAULT_TIMELINE_CONFIG: OpenCutTimelineConfig = {
  fps: 30,
  timebase: 1000,
  snapEnabled: true,
  snapThresholdSeconds: 0.08,
  defaultClipDuration: 3,
  defaultTransitionDuration: 0.35,
  maxTransitionDuration: 1.25,
  minClipDuration: 0.1,
  textDefaultDuration: 3,
  audioDefaultVolume: 0.85,
  exportQuality: 'social-high',
};

export function normalizeTimelineConfig(config?: Partial<OpenCutTimelineConfig>): OpenCutTimelineConfig {
  const merged = { ...DEFAULT_TIMELINE_CONFIG, ...(config ?? {}) };
  return {
    ...merged,
    fps: clamp(merged.fps, 24, 60),
    timebase: Math.max(100, merged.timebase),
    snapThresholdSeconds: clamp(merged.snapThresholdSeconds, 0, 0.5),
    defaultClipDuration: Math.max(0.1, merged.defaultClipDuration),
    defaultTransitionDuration: clamp(merged.defaultTransitionDuration, 0, merged.maxTransitionDuration),
    maxTransitionDuration: Math.max(0.1, merged.maxTransitionDuration),
    minClipDuration: Math.max(0.05, merged.minClipDuration),
    textDefaultDuration: Math.max(0.5, merged.textDefaultDuration),
    audioDefaultVolume: clamp(merged.audioDefaultVolume, 0, 1),
  };
}

export function clipSourceDuration(clip: OpenCutClip, config?: Partial<OpenCutTimelineConfig>) {
  const timeline = normalizeTimelineConfig(config);
  return Math.max(timeline.minClipDuration, clip.end - clip.start);
}

export function clipOutputDuration(clip: OpenCutClip, config?: Partial<OpenCutTimelineConfig>) {
  return Math.max(normalizeTimelineConfig(config).minClipDuration, clipSourceDuration(clip, config) / Math.max(0.1, clip.speed || 1));
}

export function projectDuration(clips: OpenCutClip[], config?: Partial<OpenCutTimelineConfig>) {
  return clips.reduce((sum, clip) => sum + clipOutputDuration(clip, config), 0);
}

export function clipStartInProject(clips: OpenCutClip[], clipId?: string, config?: Partial<OpenCutTimelineConfig>) {
  let time = 0;
  for (const clip of clips) {
    if (clip.id === clipId) return time;
    time += clipOutputDuration(clip, config);
  }
  return 0;
}

export function buildClipTimeline(clips: OpenCutClip[], config?: Partial<OpenCutTimelineConfig>) {
  let cursor = 0;
  return clips.map((clip, index) => {
    const start = cursor;
    const duration = clipOutputDuration(clip, config);
    const end = start + duration;
    cursor = end;
    return { id: clip.id, index, clip, start, end, duration };
  });
}

export function timelineTimeToSourceTime(clip: OpenCutClip, localTimelineTime: number) {
  return Math.min(clip.end, clip.start + Math.max(0, localTimelineTime) * Math.max(0.1, clip.speed || 1));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
