// Pixel-mask based object tracking for the eraser pipeline.
//
// The previous tracker scored a whole bounding box around the mark. That could
// lock onto nearby background and make the mask follow the wrong item. This
// version scores only the pixels the user actually marked, keeps the search
// local, and caps the final safety margin tightly.

import type { Mask } from './inpaint';

export interface TrackResult {
  masks: Mask[];
  confidence: number[];
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

interface SamplePoint {
  x: number;
  y: number;
  gray: number;
}

function toGray(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return g;
}

function dilate(mask: Mask, w: number, h: number, r: number): Mask {
  if (r <= 0) return mask.slice();
  let cur = mask.slice();
  for (let it = 0; it < r; it++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        let on = false;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            if (cur[ny * w + nx]) { on = true; break; }
          }
        }
        if (on) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

function maskBBox(mask: Mask, w: number, h: number): BBox | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count++;
    }
  }

  if (maxX < 0 || count === 0) return null;
  return { minX, minY, maxX, maxY, count };
}

function shiftMask(mask: Mask, w: number, h: number, dx: number, dy: number): { m: Mask; outOfFrame: number } {
  const out = new Uint8Array(w * h);
  let kept = 0;
  let total = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      total++;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        out[ny * w + nx] = 1;
        kept++;
      }
    }
  }

  const outOfFrame = total > 0 ? 1 - kept / total : 1;
  return { m: out, outOfFrame };
}

function makeSamples(gray: Float32Array, mask: Mask, w: number, h: number, maxSamples = 420): SamplePoint[] {
  const points: SamplePoint[] = [];
  const bbox = maskBBox(mask, w, h);
  if (!bbox) return points;

  const total = bbox.count;
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  let seen = 0;

  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      if (seen % stride === 0) points.push({ x, y, gray: gray[i] });
      seen++;
    }
  }

  return points;
}

function maskedSAD(cur: Float32Array, w: number, h: number, samples: SamplePoint[], dx: number, dy: number): number {
  let sad = 0;
  let count = 0;
  for (const p of samples) {
    const x = p.x + dx;
    const y = p.y + dy;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    sad += Math.abs(p.gray - cur[y * w + x]);
    count++;
  }
  return count >= Math.max(8, samples.length * 0.65) ? sad / count : Infinity;
}

function localSearchRadius(bbox: BBox, w: number, h: number, predDx: number, predDy: number): number {
  const targetScale = Math.max(bbox.maxX - bbox.minX + 1, bbox.maxY - bbox.minY + 1);
  const predicted = Math.hypot(predDx, predDy);
  const frameCap = Math.max(5, Math.round(Math.min(w, h) * 0.045));
  return Math.max(3, Math.min(frameCap, Math.round(targetScale * 0.45 + predicted * 0.75 + 3)));
}

function estimateFlow(
  prev: Float32Array,
  cur: Float32Array,
  prevMask: Mask,
  w: number,
  h: number,
  bbox: BBox,
  predDx: number,
  predDy: number
) {
  const samples = makeSamples(prev, prevMask, w, h);
  if (!samples.length) return { dx: 0, dy: 0, conf: 0 };

  const searchR = localSearchRadius(bbox, w, h, predDx, predDy);
  const zeroSad = maskedSAD(cur, w, h, samples, 0, 0);
  const predX = Math.round(predDx);
  const predY = Math.round(predDy);
  let best = { dx: 0, dy: 0, sad: zeroSad };

  for (let dy = predY - searchR; dy <= predY + searchR; dy++) {
    for (let dx = predX - searchR; dx <= predX + searchR; dx++) {
      const sad = maskedSAD(cur, w, h, samples, dx, dy);
      if (sad < best.sad) best = { dx, dy, sad };
    }
  }

  const improvement = Number.isFinite(zeroSad) && zeroSad > 0 ? (zeroSad - best.sad) / zeroSad : 0;
  const jump = Math.hypot(best.dx, best.dy);

  // Prefer staying on the marked position unless the shifted match is clearly
  // better. This prevents the tracker from grabbing a similar-looking item.
  if (improvement < 0.12 || jump > searchR) {
    best = { dx: 0, dy: 0, sad: zeroSad };
  }

  const residualConf = Number.isFinite(best.sad) ? Math.max(0, Math.min(1, 1 - best.sad / 48)) : 0;
  const improveConf = Math.max(0, Math.min(1, improvement + 0.45));
  const conf = best.dx === 0 && best.dy === 0 ? residualConf * 0.85 : 0.65 * residualConf + 0.35 * improveConf;
  return { dx: best.dx, dy: best.dy, conf };
}

export function trackMask(
  frames: { data: Uint8ClampedArray; width: number; height: number }[],
  keyIndex: number,
  keyMask: Mask,
  onProgress?: (frac: number) => void
): TrackResult {
  const n = frames.length;
  const w = frames[0].width;
  const h = frames[0].height;
  const core: Mask[] = new Array(n);
  const confidence: number[] = new Array(n).fill(1);
  const motion: number[] = new Array(n).fill(0);
  core[keyIndex] = keyMask.slice();

  const grays: (Float32Array | null)[] = new Array(n).fill(null);
  const gray = (i: number) => (grays[i] ??= toGray(frames[i].data, w, h));

  let vx = 0;
  let vy = 0;
  for (let i = keyIndex + 1; i < n; i++) {
    const prevMask = core[i - 1];
    const bbox = maskBBox(prevMask, w, h);
    if (!bbox || bbox.count < 4) {
      core[i] = new Uint8Array(w * h);
      confidence[i] = 0;
      continue;
    }

    const { dx, dy, conf } = estimateFlow(gray(i - 1), gray(i), prevMask, w, h, bbox, vx, vy);
    const { m, outOfFrame } = shiftMask(prevMask, w, h, dx, dy);
    core[i] = outOfFrame > 0.9 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
    motion[i] = Math.hypot(dx, dy);
    vx = Math.round(0.5 * dx + 0.5 * vx);
    vy = Math.round(0.5 * dy + 0.5 * vy);
    onProgress?.((i - keyIndex) / Math.max(1, n - 1));
  }

  vx = 0;
  vy = 0;
  for (let i = keyIndex - 1; i >= 0; i--) {
    const nextMask = core[i + 1];
    const bbox = maskBBox(nextMask, w, h);
    if (!bbox || bbox.count < 4) {
      core[i] = new Uint8Array(w * h);
      confidence[i] = 0;
      continue;
    }

    const { dx, dy, conf } = estimateFlow(gray(i + 1), gray(i), nextMask, w, h, bbox, vx, vy);
    const { m, outOfFrame } = shiftMask(nextMask, w, h, dx, dy);
    core[i] = outOfFrame > 0.9 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
    motion[i] = Math.hypot(dx, dy);
    vx = Math.round(0.5 * dx + 0.5 * vx);
    vy = Math.round(0.5 * dy + 0.5 * vy);
  }

  const masks: Mask[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = core[i];
    const bbox = c ? maskBBox(c, w, h) : null;
    if (!c || !bbox) {
      masks[i] = new Uint8Array(w * h);
      continue;
    }

    const targetScale = Math.max(bbox.maxX - bbox.minX + 1, bbox.maxY - bbox.minY + 1);
    const baseMargin = targetScale <= 12 ? 1 : 2;
    const motionMargin = motion[i] > 3 ? 1 : 0;
    const uncertaintyMargin = confidence[i] < 0.45 ? 1 : 0;
    const margin = Math.min(3, baseMargin + motionMargin + uncertaintyMargin);
    masks[i] = dilate(c, w, h, margin);
  }

  return { masks, confidence };
}

/**
 * Temporal smoothing: fill only tiny one-frame holes. Do not expand the region,
 * because that creates the visible blur/smear the user reported.
 */
export function smoothMasks(masks: Mask[], w: number, h: number): Mask[] {
  const n = masks.length;
  const out: Mask[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const m = masks[i].slice();
    const prev = masks[i - 1];
    const next = masks[i + 1];
    if (prev && next) {
      let bridged = 0;
      const maxBridge = Math.round(w * h * 0.003);
      for (let p = 0; p < w * h; p++) {
        if (!m[p] && prev[p] && next[p] && bridged < maxBridge) {
          m[p] = 1;
          bridged++;
        }
      }
    }
    out[i] = m;
  }

  return out;
}
