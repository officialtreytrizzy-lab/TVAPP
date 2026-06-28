import type { OpenCutClip, OpenCutTextLayer } from './types';

function pickMimeType(): string {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || '';
}

function waitForEvent(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true });
  });
}

async function seek(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.02) return;
  const p = waitForEvent(video, 'seeked');
  video.currentTime = time;
  await p;
}

function clipFilter(clip: OpenCutClip) {
  const brightness = clip.brightness ?? 100;
  const contrast = clip.contrast ?? 100;
  const saturation = clip.saturation ?? 100;
  const blur = clip.blur ?? 0;
  return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) blur(${blur}px)`;
}

function fadeAlpha(clip: OpenCutClip, time: number) {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  let alpha = clip.opacity ?? 1;
  if (fadeIn > 0) alpha *= Math.min(1, Math.max(0, (time - clip.start) / fadeIn));
  if (fadeOut > 0) alpha *= Math.min(1, Math.max(0, (clip.end - time) / fadeOut));
  return Math.max(0, Math.min(1, alpha));
}

function drawClip(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, clip: OpenCutClip, time: number, width: number, height: number) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  const vw = video.videoWidth || width;
  const vh = video.videoHeight || height;
  const fit = clip.fit ?? 'contain';
  const scale = fit === 'cover' ? Math.max(width / vw, height / vh) : Math.min(width / vw, height / vh);
  const drawW = vw * scale;
  const drawH = vh * scale;
  const rotate = ((clip.rotate ?? 0) * Math.PI) / 180;

  ctx.save();
  ctx.filter = clipFilter(clip);
  ctx.globalAlpha = fadeAlpha(clip, time);
  ctx.translate(width / 2, height / 2);
  if (rotate) ctx.rotate(rotate);
  if (clip.flipX) ctx.scale(-1, 1);
  ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
}

function drawTextLayers(ctx: CanvasRenderingContext2D, layers: OpenCutTextLayer[], time: number, width: number, height: number) {
  for (const layer of layers) {
    if (time < layer.start || time > layer.end || !layer.text.trim()) continue;
    const text = layer.uppercase ? layer.text.toUpperCase() : layer.text;
    const x = (layer.x / 100) * width;
    const y = (layer.y / 100) * height;
    const size = Math.max(12, layer.size);
    ctx.save();
    ctx.font = `${layer.weight} ${size}px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(text);
    if (layer.background) {
      const padX = size * 0.55;
      const padY = size * 0.42;
      ctx.fillStyle = 'rgba(0,0,0,0.58)';
      ctx.beginPath();
      ctx.roundRect(x - metrics.width / 2 - padX, y - size / 2 - padY, metrics.width + padX * 2, size + padY * 2, size * 0.55);
      ctx.fill();
    }
    if (layer.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = size * 0.35;
      ctx.shadowOffsetY = size * 0.12;
    }
    ctx.lineWidth = Math.max(3, size * 0.12);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = layer.color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

export async function exportOpenCutRender(opts: {
  clip: OpenCutClip;
  textLayers: OpenCutTextLayer[];
  width: number;
  height: number;
  fps?: number;
  onProgress?: (progress: number) => void;
}): Promise<{ url: string; blob: Blob; mimeType: string }> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support in-browser video export yet. Try desktop Chrome/Safari or export the project file.');
  }

  const { clip, textLayers, width, height, fps = 30, onProgress } = opts;
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('No supported video encoder was found in this browser.');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create render canvas.');

  const video = document.createElement('video');
  video.src = clip.url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  await waitForEvent(video, 'loadedmetadata');

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  await seek(video, clip.start);
  const duration = Math.max(0.1, clip.end - clip.start);
  const outputDuration = Math.max(0.1, duration / Math.max(0.1, clip.speed || 1));
  const totalFrames = Math.max(1, Math.ceil(outputDuration * fps));
  let frame = 0;
  recorder.start(250);

  while (frame < totalFrames) {
    const sourceTime = Math.min(clip.end, clip.start + (frame / fps) * Math.max(0.1, clip.speed || 1));
    await seek(video, sourceTime);
    drawClip(ctx, video, clip, sourceTime, width, height);
    drawTextLayers(ctx, textLayers, sourceTime, width, height);
    onProgress?.(Math.min(99, (frame / totalFrames) * 100));
    frame += 1;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.stop();
  });

  const blob = new Blob(chunks, { type: mimeType.split(';')[0] || 'video/webm' });
  const url = URL.createObjectURL(blob);
  onProgress?.(100);
  return { url, blob, mimeType: blob.type };
}
