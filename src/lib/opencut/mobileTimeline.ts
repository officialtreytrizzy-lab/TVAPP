import type { OpenCutClip, OpenCutTimelineConfig } from './types';
import { buildClipTimeline, normalizeTimelineConfig, projectDuration } from './timeline';

export interface OpenCutTimelineViewport {
  zoom: number;
  scrollSeconds: number;
  visibleSeconds: number;
}

export interface OpenCutDragBounds {
  min: number;
  max: number;
}

export function clampTimelineZoom(zoom: number) {
  return clamp(zoom, 0.5, 24);
}

export function secondsPerPixel(viewportWidthPx: number, viewport: OpenCutTimelineViewport) {
  return Math.max(0.001, viewport.visibleSeconds / Math.max(1, viewportWidthPx * clampTimelineZoom(viewport.zoom)));
}

export function pixelToTimelineTime(pixelX: number, viewportWidthPx: number, viewport: OpenCutTimelineViewport) {
  return viewport.scrollSeconds + pixelX * secondsPerPixel(viewportWidthPx, viewport);
}

export function timelineTimeToPixel(time: number, viewportWidthPx: number, viewport: OpenCutTimelineViewport) {
  return (time - viewport.scrollSeconds) / secondsPerPixel(viewportWidthPx, viewport);
}

export function pinchZoomTimeline(
  viewport: OpenCutTimelineViewport,
  startDistancePx: number,
  currentDistancePx: number,
  focalTimelineTime: number,
): OpenCutTimelineViewport {
  const ratio = currentDistancePx / Math.max(1, startDistancePx);
  const nextZoom = clampTimelineZoom(viewport.zoom * ratio);
  const nextVisible = Math.max(1, viewport.visibleSeconds / nextZoom);
  const nextScroll = Math.max(0, focalTimelineTime - nextVisible / 2);
  return { zoom: nextZoom, visibleSeconds: nextVisible, scrollSeconds: nextScroll };
}

export function timelineSnapPoints(clips: OpenCutClip[], config?: Partial<OpenCutTimelineConfig>) {
  const timeline = buildClipTimeline(clips, config);
  const points = new Set<number>([0]);
  for (const item of timeline) {
    points.add(round(item.start));
    points.add(round(item.end));
  }
  points.add(round(projectDuration(clips, config)));
  return [...points].sort((a, b) => a - b);
}

export function snapTimelineTime(time: number, clips: OpenCutClip[], config?: Partial<OpenCutTimelineConfig>) {
  const timeline = normalizeTimelineConfig(config);
  if (!timeline.snapEnabled) return time;
  const points = timelineSnapPoints(clips, timeline);
  let best = time;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(point - time);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return bestDistance <= timeline.snapThresholdSeconds ? best : time;
}

export function trimDragBounds(clip: OpenCutClip, side: 'start' | 'end'): OpenCutDragBounds {
  const minGap = 0.08;
  if (side === 'start') return { min: 0, max: Math.max(0, clip.end - minGap) };
  return { min: Math.min(clip.duration, clip.start + minGap), max: clip.duration };
}

export function movePlayheadByPixels(
  currentTime: number,
  deltaPx: number,
  viewportWidthPx: number,
  viewport: OpenCutTimelineViewport,
  projectLength: number,
) {
  return clamp(currentTime + deltaPx * secondsPerPixel(viewportWidthPx, viewport), 0, Math.max(0, projectLength));
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
