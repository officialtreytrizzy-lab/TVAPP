import type { OpenCutCodecKey, OpenCutExportSettings } from './exportSettings';
import { getOpenCutEstimatedBitrate, openCutDimensions } from './exportSettings';

export interface OpenCutMediaEngineSupport {
  mediaRecorder: boolean;
  canvasCaptureStream: boolean;
  webCodecsVideoEncoder: boolean;
  webCodecsH264: boolean;
  webCodecsHevc: boolean;
  ffmpegWasmPackageExpected: boolean;
  mp4MuxerPackageExpected: boolean;
  preferredPath: 'webcodecs-muxer' | 'mediarecorder' | 'native-required';
  warnings: string[];
}

type BrowserVideoEncoderConfig = {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
};

type BrowserVideoEncoderSupport = {
  supported?: boolean;
  config?: BrowserVideoEncoderConfig;
};

type BrowserVideoEncoderConstructor = {
  isConfigSupported?: (config: BrowserVideoEncoderConfig) => Promise<BrowserVideoEncoderSupport>;
};

function getVideoEncoder(): BrowserVideoEncoderConstructor | undefined {
  return (globalThis as typeof globalThis & { VideoEncoder?: BrowserVideoEncoderConstructor }).VideoEncoder;
}

export function isOpenCutNativeRequired(settings: OpenCutExportSettings): boolean {
  return settings.codec === 'prores'
    || settings.format === 'mov'
    || settings.resolution === '4k'
    || settings.fps > 30
    || settings.hdrMode === 'hlg'
    || settings.hdrMode === 'pq'
    || settings.aiUhdMode === 'ai-uhd-max'
    || settings.opticalFlowMode === 'ai-motion';
}

function codecCandidates(codec: OpenCutCodecKey): string[] {
  if (codec === 'hevc') return ['hvc1.1.6.L153.B0', 'hvc1.1.6.L123.B0', 'hvc1.1.6.L120.B0', 'hvc1.1.6.L93.B0'];
  if (codec === 'h264') return ['avc1.640034', 'avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0028'];
  return [];
}

async function supportsCodec(settings: OpenCutExportSettings, codec: OpenCutCodecKey): Promise<boolean> {
  const encoder = getVideoEncoder();
  if (!encoder?.isConfigSupported) return false;
  const dims = openCutDimensions(settings);
  const width = dims.w - (dims.w % 2);
  const height = dims.h - (dims.h % 2);
  for (const codecString of codecCandidates(codec)) {
    try {
      const support = await encoder.isConfigSupported({
        codec: codecString,
        width,
        height,
        bitrate: Math.max(1, getOpenCutEstimatedBitrate(settings)) * 1_000_000,
        framerate: settings.fps,
      });
      if (support.supported) return true;
    } catch {
      // Try the next browser codec string.
    }
  }
  return false;
}

export async function detectOpenCutMediaEngineSupport(settings: OpenCutExportSettings): Promise<OpenCutMediaEngineSupport> {
  const warnings: string[] = [];
  const mediaRecorder = typeof MediaRecorder !== 'undefined';
  const canvasCaptureStream = typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  const webCodecsVideoEncoder = !!getVideoEncoder();
  const webCodecsH264 = await supportsCodec(settings, 'h264');
  const webCodecsHevc = await supportsCodec(settings, 'hevc');
  const nativeRequired = isOpenCutNativeRequired(settings);

  if (!mediaRecorder) warnings.push('MediaRecorder is not available in this browser.');
  if (!canvasCaptureStream) warnings.push('Canvas captureStream is not available in this browser.');
  if (!webCodecsVideoEncoder) warnings.push('WebCodecs VideoEncoder is not available in this browser.');
  if (nativeRequired) warnings.push('The selected settings are premium/native-grade and may require a native or cloud exporter.');

  let preferredPath: OpenCutMediaEngineSupport['preferredPath'] = 'mediarecorder';
  if (nativeRequired && !webCodecsVideoEncoder) preferredPath = 'native-required';
  else if ((settings.codec === 'h264' && webCodecsH264) || (settings.codec === 'hevc' && webCodecsHevc)) preferredPath = 'webcodecs-muxer';
  else if (!mediaRecorder || !canvasCaptureStream) preferredPath = 'native-required';

  return {
    mediaRecorder,
    canvasCaptureStream,
    webCodecsVideoEncoder,
    webCodecsH264,
    webCodecsHevc,
    ffmpegWasmPackageExpected: true,
    mp4MuxerPackageExpected: true,
    preferredPath,
    warnings,
  };
}
