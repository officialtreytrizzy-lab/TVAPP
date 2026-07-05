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
    currentImplementation: 'Current TVAPP editor is a Vite web editor using HTMLVideoElement, Canvas, MediaStream, and MediaRecorder.',
    nextStep: 'Add a native iOS target or Capacitor/Swift plugin bridge for AVFoundation export and Photos save workflows.',
  },
  {
    id: 'ios-metal-coreimage-coreml',
    category: 'iphone-native',
    label: 'Metal, Core Image, and Core ML processing',
    status: 'native-required',
    requirement: 'Native iOS builds need Metal/Core Image for low-latency effects and Core ML for on-device AI where models are small enough.',
    currentImplementation: 'Web preview/export uses CSS filters and Canvas 2D; no native GPU/ML bridge exists in this repo.',
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
    id: 'ios-background-thermal-memory',
    category: 'iphone-native',
    label: 'Background export, memory pressure, and thermal limits',
    status: 'native-required',
    requirement: 'Native export must respect iOS background execution limits, memory warnings, and thermal throttling.',
    currentImplementation: 'Browser export runs in the foreground and can be interrupted by tab suspension or memory pressure.',
    nextStep: 'Add export state checkpoints plus native background task handling in the iOS target.',
  },
  {
    id: 'h264-hevc-prores',
    category: 'codecs-formats',
    label: 'H.264, HEVC/H.265, and ProRes',
    status: 'partial',
    requirement: 'Support H.264 for compatibility, HEVC for high-quality/4K efficiency, and ProRes where native/pro workflows allow it.',
    currentImplementation: 'Browser MediaRecorder selects supported MP4/WebM MIME types opportunistically; exact H.264/HEVC/ProRes control is not guaranteed in web browsers.',
    nextStep: 'Use export presets in web and native encoder settings in AVAssetWriter/VideoToolbox for deterministic codec control.',
  },
  {
    id: 'aac-wav-mov-mp4-alpha',
    category: 'codecs-formats',
    label: 'AAC, WAV, MOV, MP4, and alpha video',
    status: 'partial',
    requirement: 'AAC/MP4 for social, WAV for audio masters, MOV/ProRes or HEVC alpha for professional overlay exports.',
    currentImplementation: 'Current web export returns MP4/WebM depending on MediaRecorder support and imports common audio/video through browser decoders.',
    nextStep: 'Add explicit export target types and native/cloud export paths for MOV, WAV, and alpha-capable masters.',
  },
  {
    id: 'hdr-sdr-rec709-displayp3-dolbyvision',
    category: 'codecs-formats',
    label: 'HDR, SDR, Rec.709, Display P3, and Dolby Vision handling',
    status: 'planned',
    requirement: 'Color pipeline must distinguish SDR Rec.709, Display P3, HDR HLG/PQ, and Dolby Vision compatibility/tone-map issues.',
    currentImplementation: 'Canvas/browser pipeline is SDR-oriented and does not preserve HDR metadata or Dolby Vision metadata.',
    nextStep: 'Add color-management metadata to project/export settings and route HDR/Dolby Vision to native/cloud exporters.',
  },
  {
    id: 'timeline-trim-split-layer',
    category: 'editing-engine',
    label: 'Timeline, trimming, splitting, layering',
    status: 'available',
    requirement: 'Editor must support non-destructive clips, trims, splits, layered overlays, captions, and text.',
    currentImplementation: 'OpenCut project model stores clips, text layers, audio tracks, selected clip, and timeline config; mobile studio supports trim/split/text/stickers/audio.',
    nextStep: 'Move timeline controls into a dedicated track UI with drag handles and multi-layer lanes.',
  },
  {
    id: 'transitions-keyframes-speed',
    category: 'editing-engine',
    label: 'Transitions, keyframes, speed ramps, reverse, freeze frame',
    status: 'partial',
    requirement: 'CapCut-class editing needs transitions, keyframes, speed ramps, reverse, freeze frame, masks, captions, and overlays.',
    currentImplementation: 'Current pass adds basic transitions, speed multiplier, captions/text/stickers as text layers, filters, and transforms; keyframes, reverse, freeze frame, masks, and custom speed ramps still need real engines.',
    nextStep: 'Add clip keyframe schema, speed-curve schema, reverse/freeze commands, and mask layer model.',
  },
  {
    id: 'captions-overlays-masks',
    category: 'editing-engine',
    label: 'Captions, overlays, and masks',
    status: 'partial',
    requirement: 'Text/captions/overlays should be timeline layers with export parity; masks should clip or reveal visual layers.',
    currentImplementation: 'Text/captions/stickers are project-level text layers rendered in preview/export; masks are not yet modeled.',
    nextStep: 'Promote text layers into explicit track items and add mask types: linear, radial, rectangle, blur mask, and subject mask.',
  },
  {
    id: 'ai-captions-vocal-noise',
    category: 'ai-features',
    label: 'Auto captions, vocal isolation, and noise cleanup',
    status: 'planned',
    requirement: 'AI system should generate captions, align user lyrics, isolate vocals, and clean noise.',
    currentImplementation: 'No AI media pipeline is connected to the OpenCut promo editor in this repo path yet.',
    nextStep: 'Add AI job model and provider adapters for transcription, lyric sync, source separation, and denoise.',
  },
  {
    id: 'ai-visual-tools',
    category: 'ai-features',
    label: 'Background removal, object tracking, smart crop, style filters, retouch, AI B-roll',
    status: 'planned',
    requirement: 'AI-first editor should support subject/background segmentation, object/face tracking, smart crop, style filters, face/body retouch, beat sync, and AI B-roll generation.',
    currentImplementation: 'Current editor has manual crop/aspect, filters, transforms, and promo auto-style but no ML segmentation/tracking/generation.',
    nextStep: 'Create AI feature contracts and queue UI before wiring local/cloud providers.',
  },
  {
    id: 'export-resolution-fps-bitrate',
    category: 'export-pipeline',
    label: '720p/1080p/4K, 30/60fps, bitrate, social presets',
    status: 'partial',
    requirement: 'Export must support 720p, 1080p, 4K, 30/60fps, bitrate control, and social presets.',
    currentImplementation: 'Current export chooses 720p/1080p dimensions by aspect and uses MediaRecorder with fixed bitrate; timeline config now stores fps/export-quality intent.',
    nextStep: 'Expose export preset picker and use preset bitrate/resolution/fps in exportOpenCutRender.',
  },
  {
    id: 'export-progress-cancel-recovery',
    category: 'export-pipeline',
    label: 'Watermark-free export, progress, cancel/resume, failed export recovery',
    status: 'partial',
    requirement: 'Exports should be watermark-free, show progress states, support cancel/resume where possible, and recover from failures cleanly.',
    currentImplementation: 'Current export is watermark-free and reports progress; cancellation/resume and checkpoint recovery are not implemented.',
    nextStep: 'Add AbortController export cancellation, retry fallback settings, and checkpointed native/cloud export recovery.',
  },
  {
    id: 'mobile-touch-performance',
    category: 'mobile-ux',
    label: 'Touch-first editing, pinch/zoom, drag handles, snapping, low-lag playback',
    status: 'partial',
    requirement: 'Mobile editor needs touch-first interactions, pinch/zoom timeline, drag trim handles, snap points, undo/redo, proxy rendering, and low-lag preview.',
    currentImplementation: 'Current mobile studio uses bottom tool rail, range controls, clip chips, text controls, and basic snapping config; pinch/zoom, drag handles, undo/redo, and proxies are not complete.',
    nextStep: 'Build a dedicated mobile timeline component using shared timeline helpers and add undo command stack.',
  },
  {
    id: 'offline-autosave-cache-recovery',
    category: 'app-quality',
    label: 'Offline-first editing, autosave, cache, non-destructive edits, crash recovery',
    status: 'partial',
    requirement: 'App should preserve projects offline, autosave edits, cache media/proxies, keep edits non-destructive, and recover after crashes.',
    currentImplementation: 'Project model is non-destructive and can be manually saved as JSON; autosave/cache/crash recovery are not implemented in this path yet.',
    nextStep: 'Add IndexedDB project/media cache, autosave snapshots, and crash-recovery restore prompt.',
  },
  {
    id: 'upload-share-workflows',
    category: 'app-quality',
    label: 'Upload and share workflows',
    status: 'planned',
    requirement: 'Finished promos should be shareable to device files/photos and uploadable to Trey TV/Tradio publishing flows.',
    currentImplementation: 'Current browser export downloads a local blob.',
    nextStep: 'Add share targets, upload queue, cloud asset persistence, and publishing metadata handoff.',
  },
];

export function getOpenCutCapabilitiesByCategory(category: OpenCutCapabilityCategory) {
  return OPENCUT_CAPABILITIES.filter((capability) => capability.category === category);
}

export function getOpenCutCapabilityStatus(id: string): OpenCutCapabilityStatus | undefined {
  return OPENCUT_CAPABILITIES.find((capability) => capability.id === id)?.status;
}
