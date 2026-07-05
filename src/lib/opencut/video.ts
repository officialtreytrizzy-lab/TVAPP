import type { OpenCutAudioMeta, OpenCutVideoMeta } from './types';

export function probeOpenCutVideo(file: File): Promise<OpenCutVideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      resolve({
        url,
        duration: video.duration || 0,
        width: video.videoWidth || 1080,
        height: video.videoHeight || 1920,
      });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this video. Try MP4, MOV, or WebM.'));
    };
    video.src = url;
  });
}

export function probeOpenCutAudio(file: File): Promise<OpenCutAudioMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve({ url, duration: audio.duration || 0 });
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this audio file. Try MP3, WAV, M4A, or AAC.'));
    };
    audio.src = url;
  });
}

export async function makeTimelineThumbs(videoUrl: string, count = 12): Promise<string[]> {
  const video = document.createElement('video');
  video.src = videoUrl;
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Could not generate thumbnails.'));
  });

  const canvas = document.createElement('canvas');
  const width = 96;
  const height = 144;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  const thumbs: string[] = [];
  const duration = Math.max(0.1, video.duration || 1);
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, (duration * i) / Math.max(1, count - 1));
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.onseeked = done;
      video.currentTime = t;
    });
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, width, height);
    const vw = video.videoWidth || width;
    const vh = video.videoHeight || height;
    const scale = Math.max(width / vw, height / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    ctx.drawImage(video, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
    thumbs.push(canvas.toDataURL('image/jpeg', 0.72));
  }
  return thumbs;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00.000';
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
