export type OpenCutCapabilityStatus = 'available' | 'partial' | 'planned' | 'native-required' | 'cloud-required' | 'blocked';

export type OpenCutCapabilityCategory =
  | 'iphone-native'
  | 'codecs-formats'
  | 'editing-engine'
  | 'ai-features'
  | 'export-pipeline'
  | 'mobile-ux'
  | 'app-quality';

export interface OpenCutCapability {
  id: string;
  category: OpenCutCapabilityCategory;
  label: string;
  status: OpenCutCapabilityStatus;
  requirement: string;
  currentImplementation: string;
  nextStep: string;
}

export const OPENCUT_CAPABILITIES: OpenCutCapability[] = [
  {
    id: 'ios-avfoundation',
    category: 'iphone-native',
    label: 'AVFoundation timeline/export foundation',
    status: 'native-required',
    requirement: 'Native iOS builds should use AVFoundation/AVAssetWriter/AVMutableComposition for production-grade decode, timeline composition, audio mix, and export.',
    currentImplementation: 'Current TVAPP OpenCut is a Vite web editor. Native iOS work remains a separate implementation path.',
    nextStep: 'Add a native iOS target or Capacitor/Swift plugin bridge for AVFoundation export and Photos save workflows.',
  },
  {
    id: 'ios-metal-coreimage-coreml',
    category: 'iphone-native',
    label: 'Metal, Core Image, and Core ML processing',
    status: 'native-required',
    requirement: 'Native iOS builds need Metal/Core Image for low-latency effects and Core ML for on-device AI where models are small enough.',
    currentImplementation: 'Web preview/export uses browser rendering paths. OpenCut now has a media-engine adapter that can route premium settings toward native or cloud export.',
    nextStep: 'Create a native render service interface with web fallback and iOS implementation hooks.',
  },
  {
    id: 'photos-permissions-camera-roll',
    category: 'iphone-native',
    label: 'Photos integration and camera roll permissions',
    status: 'native-required',
    requirement: 'Native app must request Photos permissions, import from camera roll, save exports, and handle limited-library permissions.',
    currentImplementation: 'Web file picker imports local files and browser download saves exported blobs.',
    nextStep: 'Add platform media-source abstraction and native Photos bridge for iOS.',
  },
  {
    id: 'h264-hevc-prores',
    category: 'codecs-formats',
    label: 'H.264, HEVC/H.265, and ProRes',
    status: 'partial',
    requirement: 'Support H.264 for compatibility, HEVC for high-quality/4K efficiency, and ProRes where native/pro workflows allow it.',
    currentImplementation: 'OpenCut now has codec vocabulary and browser capability detection for WebCodecs H.264/HEVC. ProRes remains native/cloud-required.',
    nextStep: 'Install the media dependencies and wire WebCodecs/mp4 muxing and ffmpeg fallback into exportOpenCutRender.',
  },
  {
    id: 'export-resolution-fps-bitrate',
    category: 'export-pipeline',
    label: '720p/1080p/4K, 30/60fps, bitrate, social presets',
    status: 'partial',
    requirement: 'Export must support 720p, 1080p, 4K, 30/60fps, bitrate control, and social presets.',
    currentImplementation: 'OpenCut now has export settings, export presets, estimated bitrate/file-size helpers, and media-engine support detection. The live renderer still needs WebCodecs/mp4 muxing and ffmpeg fallback wired into exportOpenCutRender.',
    nextStep: 'Install media dependencies, then route export through WebCodecs/mp4 muxing with ffmpeg fallback while preserving the current MediaRecorder fallback.',
  },
];

export function getOpenCutCapabilitiesByCategory(category: OpenCutCapabilityCategory) {
  return OPENCUT_CAPABILITIES.filter((capability) => capability.category === category);
}

export function getOpenCutCapabilityStatus(id: string): OpenCutCapabilityStatus | undefined {
  return OPENCUT_CAPABILITIES.find((capability) => capability.id === id)?.status;
}
