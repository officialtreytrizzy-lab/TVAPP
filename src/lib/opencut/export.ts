import type { OpenCutAudioTrack, OpenCutClip, OpenCutTextLayer } from './types';

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
  if (Math.abs(video.currentTime - time) < 0.018) return;
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

function clipSourceDuration(clip: OpenCutClip) {
  return Math.max(0.1, clip.end - clip.start);
}

function clipOutputDuration(clip: OpenCutClip) {
  return Math.max(0.1, clipSourceDuration(clip) / Math.max(0.1, clip.speed || 1));
}

function buildTimeline(clips: OpenCutClip[]) {
  let cursor = 0;
  return clips.map((clip) => {
    const start = cursor;
    const duration = clipOutputDuration(clip);
    cursor += duration;
    return { clip, start, end: cursor, duration };
  });
}

function fadeAlpha(clip: OpenCutClip, sourceTime: number) {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  let alpha = clip.opacity ?? 1;
  if (fadeIn > 0) alpha *= Math.min(1, Math.max(0, (sourceTime - clip.start) / fadeIn));
  if (fadeOut > 0) alpha *= Math.min(1, Math.max(0, (clip.end - sourceTime) / fadeOut));
  return Math.max(0, Math.min(1, alpha));
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  clip: OpenCutClip,
  sourceTime: number,
  width: number,
  height: number,
  timelineLocal: number,
  outputDuration: number,
) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  const vw = video.videoWidth || width;
  const vh = video.videoHeight || height;
  const fit = clip.fit ?? 'contain';
  const scaleBase = fit === 'cover' ? Math.max(width / vw, height / vh) : Math.min(width / vw, height / vh);
  const transition = clip.transition ?? 'none';
  const transitionDuration = Math.min(clip.transitionDuration ?? 0.35, outputDuration / 2);
  const inProgress = transitionDuration > 0 ? Math.min(1, Math.max(0, timelineLocal / transitionDuration)) : 1;
  const outProgress = transitionDuration > 0 ? Math.min(1, Math.max(0, (outputDuration - timelineLocal) / transitionDuration)) : 1;
  const edgeProgress = Math.min(inProgress, outProgress);
  const transitionScale = transition === 'zoom' ? 1.04 - edgeProgress * 0.04 : 1;
  const drawW = vw * scaleBase * transitionScale;
  const drawH = vh * scaleBase * transitionScale;
  const rotate = ((clip.rotate ?? 0) * Math.PI) / 180;

  ctx.save();
  ctx.filter = clipFilter(clip);
  ctx.globalAlpha = fadeAlpha(clip, sourceTime);
  ctx.translate(width / 2, height / 2);
  if (rotate) ctx.rotate(rotate);
  if (clip.flipX) ctx.scale(-1, 1);
  ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  if (transition !== 'none' && transitionDuration > 0 && edgeProgress < 1) {
    const impact = 1 - edgeProgress;
    ctx.save();
    if (transition === 'flash') {
      ctx.fillStyle = `rgba(255,255,255,${impact * 0.65})`;
      ctx.fillRect(0, 0, width, height);
    }
    if (transition === 'fade') {
      ctx.fillStyle = `rgba(0,0,0,${impact * 0.75})`;
      ctx.fillRect(0, 0, width, height);
    }
    if (transition === 'wipe') {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, 0, width * impact, height);
    }
    if (transition === 'glitch') {
      ctx.fillStyle = `rgba(168,85,247,${impact * 0.2})`;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = `rgba(56,189,248,${impact * 0.18})`;
      ctx.fillRect(width * 0.08, height * 0.18, width * 0.86, height * 0.055);
      ctx.fillRect(width * 0.14, height * 0.68, width * 0.72, height * 0.04);
    }
    ctx.restore();
  }
}

function drawTextLayers(ctx: CanvasRenderingContext2D, layers: OpenCutTextLayer[], timelineTime: number, width: number, height: number) {
  for (const layer of layers) {
    if (timelineTime < layer.start || timelineTime > layer.end || !layer.text.trim()) continue;
    const duration = Math.max(0.1, layer.end - layer.start);
    const local = timelineTime - layer.start;
    const inProgress = Math.min(1, Math.max(0, local / Math.min(0.35, duration)));
    const outProgress = Math.min(1, Math.max(0, (layer.end - timelineTime) / Math.min(0.35, duration)));
    const edge = Math.min(inProgress, outProgress);
    const animation = layer.animation ?? 'none';
    const originalText = layer.uppercase ? layer.text.toUpperCase() : layer.text;
    const text = animation === 'typewriter' ? originalText.slice(0, Math.max(1, Math.ceil(originalText.length * Math.min(1, local / Math.max(0.5, duration * 0.28))))) : originalText;
    const x = (layer.x / 100) * width;
    const y = (layer.y / 100) * height;
    const size = Math.max(12, layer.size);
    const popScale = animation === 'pop' ? 0.88 + edge * 0.12 : 1;
    const slideOffset = animation === 'slide-up' ? (1 - edge) * size * 1.2 : 0;

    ctx.save();
    ctx.globalAlpha = animation === 'fade' ? edge : 1;
    ctx.translate(x, y + slideOffset);
    ctx.scale(popScale, popScale);
    ctx.font = `${layer.weight} ${size}px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(text);
    if (layer.background) {
      const padX = size * 0.55;
      const padY = size * 0.42;
      ctx.fillStyle = 'rgba(0,0,0,0.58)';
      ctx.beginPath();
      ctx.roundRect(-metrics.width / 2 - padX, -size / 2 - padY, metrics.width + padX * 2, size + padY * 2, size * 0.55);
      ctx.fill();
    }
    if (layer.shadow || animation === 'glow') {
      ctx.shadowColor = animation === 'glow' ? 'rgba(217,70,239,0.9)' : 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = animation === 'glow' ? size * 0.5 : size * 0.35;
      ctx.shadowOffsetY = animation === 'glow' ? 0 : size * 0.12;
    }
    ctx.lineWidth = Math.max(3, size * 0.12);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = layer.color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

async function loadVideo(url: string) {
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  await waitForEvent(video, 'loadedmetadata');
  return video;
}

function attachAudioTracks(stream: MediaStream, audioTracks: OpenCutAudioTrack[]) {
  const playable: HTMLAudioElement[] = [];
  for (const track of audioTracks) {
    const audio = document.createElement('audio');
    audio.src = track.url;
    audio.volume = Math.max(0, Math.min(1, track.volume));
    audio.preload = 'auto';
    const capture = (audio as HTMLAudioElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }).captureStream
      ?? (audio as HTMLAudioElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream;
    if (!capture) continue;
    const audioStream = capture.call(audio) as MediaStream;
    for (const audioTrack of audioStream.getAudioTracks()) stream.addTrack(audioTrack);
    playable.push(audio);
  }
  return playable;
}

export async function exportOpenCutRender(opts: {
  clip?: OpenCutClip;
  clips?: OpenCutClip[];
  textLayers: OpenCutTextLayer[];
  audioTracks?: OpenCutAudioTrack[];
  width: number;
  height: number;
  fps?: number;
  onProgress?: (progress: number) => void;
}): Promise<{ url: string; blob: Blob; mimeType: string }> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support in-browser video export yet. Try desktop Chrome/Safari or export the project file.');
  }

  const { clip, clips = clip ? [clip] : [], textLayers, audioTracks = [], width, height, fps = 30, onProgress } = opts;
  if (!clips.length) throw new Error('Import at least one video clip before exporting.');
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('No supported video encoder was found in this browser.');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create render canvas.');

  const timeline = buildTimeline(clips);
  const totalDuration = Math.max(0.1, timeline[timeline.length - 1]?.end ?? 0.1);
  const videoById = new Map<string, HTMLVideoElement>();
  for (const item of timeline) videoById.set(item.clip.id, await loadVideo(item.clip.url));

  const stream = canvas.captureStream(fps);
  const playableAudio = attachAudioTracks(stream, audioTracks);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: width >= 1920 ? 18_000_000 : 12_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));
  let frame = 0;
  recorder.start(250);
  for (const audio of playableAudio) {
    try {
      audio.currentTime = 0;
      await audio.play();
    } catch {
      // Browsers may block programmatic audio playback; video export still completes without audio.
    }
  }

  while (frame < totalFrames) {
    const timelineTime = frame / fps;
    const item = timeline.find((entry) => timelineTime >= entry.start && timelineTime < entry.end) ?? timeline[timeline.length - 1];
    const localOutput = Math.max(0, timelineTime - item.start);
    const sourceTime = Math.min(item.clip.end, item.clip.start + localOutput * Math.max(0.1, item.clip.speed || 1));
    const video = videoById.get(item.clip.id);
    if (!video) throw new Error(`Missing loaded video for ${item.clip.name}`);
    await seek(video, sourceTime);
    drawClip(ctx, video, item.clip, sourceTime, width, height, localOutput, item.duration);
    drawTextLayers(ctx, textLayers, timelineTime, width, height);
    onProgress?.(Math.min(99, (frame / totalFrames) * 100));
    frame += 1;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  for (const audio of playableAudio) audio.pause();

  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.stop();
  });

  const blob = new Blob(chunks, { type: mimeType.split(';')[0] || 'video/webm' });
  const url = URL.createObjectURL(blob);
  onProgress?.(100);
  return { url, blob, mimeType: blob.type };
}
