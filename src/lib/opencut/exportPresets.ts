import type { OpenCutExportQuality } from './types';

export type OpenCutExportCodec = 'auto' | 'h264' | 'hevc' | 'prores';
export type OpenCutExportContainer = 'auto' | 'mp4' | 'mov' | 'webm' | 'wav';
export type OpenCutColorPipeline = 'auto' | 'sdr-rec709' | 'display-p3' | 'hdr-hlg' | 'hdr-pq' | 'dolby-vision-source';

export interface OpenCutExportPreset {
  id: string;
  label: string;
  quality: OpenCutExportQuality;
  width: number;
  height: number;
  fps: 30 | 60;
  videoBitrate: number;
  audioBitrate: number;
  codec: OpenCutExportCodec;
  container: OpenCutExportContainer;
  colorPipeline: OpenCutColorPipeline;
  requiresNativeExporter?: boolean;
  note: string;
}

export const OPENCUT_EXPORT_PRESETS: OpenCutExportPreset[] = [
  {
    id: 'vertical-720p-30-social-draft',
    label: '720p Draft Vertical',
    quality: 'draft',
    width: 720,
    height: 1280,
    fps: 30,
    videoBitrate: 5_000_000,
    audioBitrate: 160_000,
    codec: 'auto',
    container: 'auto',
    colorPipeline: 'sdr-rec709',
    note: 'Fast preview export for rough review; not intended as final promo quality.',
  },
  {
    id: 'vertical-1080p-30-social-standard',
    label: '1080p Social Standard',
    quality: 'social-standard',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrate: 12_000_000,
    audioBitrate: 192_000,
    codec: 'h264',
    container: 'mp4',
    colorPipeline: 'sdr-rec709',
    note: 'Compatibility-first vertical export for everyday social promos.',
  },
  {
    id: 'vertical-1080p-60-social-high',
    label: '1080p 60 Social High',
    quality: 'social-high',
    width: 1080,
    height: 1920,
    fps: 60,
    videoBitrate: 24_000_000,
    audioBitrate: 256_000,
    codec: 'h264',
    container: 'mp4',
    colorPipeline: 'sdr-rec709',
    note: 'Smooth high-quality social export. Web support depends on MediaRecorder codec availability.',
  },
  {
    id: 'vertical-4k-60-creator',
    label: '4K 60 Creator',
    quality: 'archive',
    width: 2160,
    height: 3840,
    fps: 60,
    videoBitrate: 95_000_000,
    audioBitrate: 320_000,
    codec: 'hevc',
    container: 'mp4',
    colorPipeline: 'sdr-rec709',
    requiresNativeExporter: true,
    note: 'CapCut-class premium vertical export target. Requires native/cloud exporter for reliable HEVC and memory control.',
  },
  {
    id: 'landscape-4k-60-master',
    label: '4K 60 Master Landscape',
    quality: 'archive',
    width: 3840,
    height: 2160,
    fps: 60,
    videoBitrate: 120_000_000,
    audioBitrate: 320_000,
    codec: 'hevc',
    container: 'mp4',
    colorPipeline: 'display-p3',
    requiresNativeExporter: true,
    note: 'High-quality archive/master preset for landscape projects.',
  },
  {
    id: 'prores-mov-master',
    label: 'ProRes MOV Master',
    quality: 'archive',
    width: 3840,
    height: 2160,
    fps: 30,
    videoBitrate: 0,
    audioBitrate: 1_536_000,
    codec: 'prores',
    container: 'mov',
    colorPipeline: 'display-p3',
    requiresNativeExporter: true,
    note: 'Professional intermediate/master target. Native iOS/macOS or cloud export path required; browser MediaRecorder cannot guarantee ProRes.',
  },
];

export function getOpenCutExportPreset(id: string) {
  return OPENCUT_EXPORT_PRESETS.find((preset) => preset.id === id) ?? OPENCUT_EXPORT_PRESETS[1];
}

export function getDefaultOpenCutExportPreset(quality: OpenCutExportQuality = 'social-high') {
  return OPENCUT_EXPORT_PRESETS.find((preset) => preset.quality === quality && !preset.requiresNativeExporter) ?? OPENCUT_EXPORT_PRESETS[1];
}
