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
}

export interface OpenCutProject {
  id: string;
  name: string;
  aspect: '9:16' | '1:1' | '16:9' | 'original';
  clips: OpenCutClip[];
  textLayers: OpenCutTextLayer[];
  selectedClipId?: string;
}

export interface OpenCutVideoMeta {
  url: string;
  duration: number;
  width: number;
  height: number;
}
