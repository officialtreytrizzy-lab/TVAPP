export type OpenCutTransitionType = 'none' | 'fade' | 'flash' | 'wipe' | 'zoom' | 'glitch';

export type OpenCutTextAnimation = 'none' | 'pop' | 'fade' | 'slide-up' | 'glow' | 'typewriter';

export interface OpenCutClip {
  id: string;
  name: string;
  url: string;
  duration: number;
  width: number;
  height: number;
  start: number;
  end: number;
  speed: number;
  volume: number;
  filterPreset?: string;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  blur?: number;
  opacity?: number;
  rotate?: number;
  flipX?: boolean;
  fit?: 'contain' | 'cover';
  fadeIn?: number;
  fadeOut?: number;
  transition?: OpenCutTransitionType;
  transitionDuration?: number;
}

export interface OpenCutAudioTrack {
  id: string;
  name: string;
  url: string;
  duration: number;
  volume: number;
  start: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface OpenCutTextLayer {
  id: string;
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  size: number;
  weight: number;
  color: string;
  background: boolean;
  shadow?: boolean;
  uppercase?: boolean;
  animation?: OpenCutTextAnimation;
}

export interface OpenCutProject {
  id: string;
  name: string;
  aspect: '9:16' | '1:1' | '16:9' | 'original';
  clips: OpenCutClip[];
  textLayers: OpenCutTextLayer[];
  audioTracks: OpenCutAudioTrack[];
  selectedClipId?: string;
}

export interface OpenCutVideoMeta {
  url: string;
  duration: number;
  width: number;
  height: number;
}

export interface OpenCutAudioMeta {
  url: string;
  duration: number;
}
