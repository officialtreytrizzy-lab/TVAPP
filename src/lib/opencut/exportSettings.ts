export type OpenCutResolutionKey = 'match' | '720p' | '1080p' | '2k' | '4k' | 'custom';
export type OpenCutAspectKey = '16:9' | '9:16' | '1:1' | '4:5';
export type OpenCutQualityKey = 'low' | 'medium' | 'high';
export type OpenCutCodecKey = 'h264' | 'hevc' | 'prores';
export type OpenCutFormatKey = 'mp4' | 'mov';
export type OpenCutAiUhdMode = 'off' | 'fast-enhance' | 'ai-uhd' | 'ai-uhd-max';
export type OpenCutOpticalFlowMode = 'off' | 'frame-blend' | 'standard' | 'high-quality' | 'ai-motion';
export type OpenCutHdrMode = 'auto' | 'sdr' | 'hlg' | 'pq';
export type OpenCutBitrateMode = 'recommended' | 'low' | 'standard' | 'high' | 'ultra' | 'custom';

export interface OpenCutExportSettings {
  resolution: OpenCutResolutionKey;
  aspect: OpenCutAspectKey;
  quality: OpenCutQualityKey;
  fps: number;
  codec: OpenCutCodecKey;
  format: OpenCutFormatKey;
  aiUhdMode: OpenCutAiUhdMode;
  opticalFlowMode: OpenCutOpticalFlowMode;
  hdrMode: OpenCutHdrMode;
  bitrateMode: OpenCutBitrateMode;
  customBitrateMbps?: number;
  customWidth?: number;
  customHeight?: number;
  audioQuality: 'standard' | 'high' | 'ultra';
}

export const OPENCUT_DEFAULT_EXPORT_SETTINGS: OpenCutExportSettings = {
  resolution: '1080p',
  aspect: '9:16',
  quality: 'high',
  fps: 30,
  codec: 'h264',
  format: 'mp4',
  aiUhdMode: 'off',
  opticalFlowMode: 'off',
  hdrMode: 'sdr',
  bitrateMode: 'recommended',
  audioQuality: 'high',
};

const SHORT_SIDE: Record<Exclude<OpenCutResolutionKey, 'match' | 'custom'>, number> = {
  '720p': 720,
  '1080p': 1080,
  '2k': 1440,
  '4k': 2160,
};

export const OPENCUT_CRF: Record<OpenCutQualityKey, number> = { low: 30, medium: 24, high: 19 };

export const OPENCUT_AUDIO_BITRATES: Record<'standard' | 'high' | 'ultra', string> = {
  standard: '128k',
  high: '192k',
  ultra: '320k',
};

export const OPENCUT_VIDEO_BITRATE: Record<Exclude<OpenCutResolutionKey, 'match' | 'custom'>, Record<30 | 60, string>> = {
  '720p': { 30: '6M', 60: '9M' },
  '1080p': { 30: '12M', 60: '18M' },
  '2k': { 30: '24M', 60: '36M' },
  '4k': { 30: '45M', 60: '68M' },
};

export function openCutDimensions(settings: OpenCutExportSettings, sourceW?: number, sourceH?: number): { w: number; h: number } {
  if (settings.resolution === 'custom') {
    const w = settings.customWidth || 1080;
    const h = settings.customHeight || 1920;
    return { w: w - (w % 2), h: h - (h % 2) };
  }

  const [aw, ah] = settings.aspect.split(':').map(Number);
  let shortSide: number;
  if (settings.resolution === 'match') {
    shortSide = Math.min(sourceW || 1080, sourceH || 1080) || 1080;
  } else {
    shortSide = SHORT_SIDE[settings.resolution];
  }

  let w: number;
  let h: number;
  if (aw >= ah) {
    h = shortSide;
    w = Math.round((h * aw) / ah);
  } else {
    w = shortSide;
    h = Math.round((w * ah) / aw);
  }
  return { w: w - (w % 2), h: h - (h % 2) };
}

export function getOpenCutEstimatedBitrate(settings: OpenCutExportSettings): number {
  if (settings.bitrateMode === 'custom' && settings.customBitrateMbps) return settings.customBitrateMbps;

  let base = 12;
  if (settings.resolution === '720p') base = settings.fps === 60 ? 9 : 6;
  else if (settings.resolution === '1080p') base = settings.fps === 60 ? 18 : 12;
  else if (settings.resolution === '2k') base = settings.fps === 60 ? 36 : 24;
  else if (settings.resolution === '4k') base = settings.fps === 60 ? 68 : 45;

  if (settings.bitrateMode === 'low') base *= 0.6;
  else if (settings.bitrateMode === 'standard') base *= 0.85;
  else if (settings.bitrateMode === 'high') base *= 1.25;
  else if (settings.bitrateMode === 'ultra') base *= 1.8;

  if (settings.codec === 'hevc') base *= 0.65;
  else if (settings.codec === 'prores') base *= 8.0;

  return Math.max(1, base);
}

export function estimateOpenCutFileSize(settings: OpenCutExportSettings, durationSeconds: number): number {
  const vBitrateBytes = (getOpenCutEstimatedBitrate(settings) * 1_000_000) / 8;
  const aBitrate = settings.audioQuality === 'ultra' ? 320_000 : settings.audioQuality === 'high' ? 192_000 : 128_000;
  return (vBitrateBytes + aBitrate / 8) * durationSeconds;
}

export const OPENCUT_RESOLUTION_LABELS: { key: OpenCutResolutionKey; label: string }[] = [
  { key: 'match', label: 'Match source' },
  { key: '720p', label: '720p HD' },
  { key: '1080p', label: '1080p Full HD' },
  { key: '2k', label: '2K QHD' },
  { key: '4k', label: '4K UHD' },
  { key: 'custom', label: 'Custom' },
];

export const OPENCUT_ASPECT_LABELS: OpenCutAspectKey[] = ['16:9', '9:16', '1:1', '4:5'];
export const OPENCUT_QUALITY_LABELS: OpenCutQualityKey[] = ['low', 'medium', 'high'];
export const OPENCUT_FPS_OPTIONS = [24, 25, 30, 50, 60];
export const OPENCUT_CODEC_OPTIONS: OpenCutCodecKey[] = ['h264', 'hevc', 'prores'];
export const OPENCUT_FORMAT_OPTIONS: OpenCutFormatKey[] = ['mp4', 'mov'];
export const OPENCUT_AI_UHD_OPTIONS: { key: OpenCutAiUhdMode; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'fast-enhance', label: 'Fast Enhance' },
  { key: 'ai-uhd', label: 'AI UHD' },
  { key: 'ai-uhd-max', label: 'AI UHD Max' },
];
export const OPENCUT_OPTICAL_FLOW_OPTIONS: { key: OpenCutOpticalFlowMode; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'frame-blend', label: 'Frame Blend' },
  { key: 'standard', label: 'Optical Flow' },
  { key: 'high-quality', label: 'Optical Flow HQ' },
  { key: 'ai-motion', label: 'AI Motion Interpolation' },
];
export const OPENCUT_HDR_OPTIONS: { key: OpenCutHdrMode; label: string }[] = [
  { key: 'sdr', label: 'SDR Rec. 709' },
  { key: 'auto', label: 'HDR Auto' },
  { key: 'hlg', label: 'HDR HLG' },
  { key: 'pq', label: 'HDR PQ' },
];
