// Optical-flow (block-matching) mask propagation across frames.
// The spec permits optical flow as a documented real fallback tracker. For each
// consecutive frame pair we estimate the translation of the masked region by SAD
// block matching on a grayscale buffer, then shift the mask. A per-frame
// confidence is produced so low-confidence ranges can be flagged for refinement,
// and the mask is dropped if the target leaves the frame.

import type { Mask } from './inpaint';

export interface TrackResult {
  masks: Mask[]; // per-frame mask (same length as frames)
  confidence: number[]; // 0..1 per frame
}

function toGray(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return g;
}

function maskBBox(mask: Mask, w: number, h: number) {
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        count++;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, count, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function shiftMask(mask: Mask, w: number, h: number, dx: number, dy: number): { m: Mask; outOfFrame: number } {
  const out = new Uint8Array(w * h);
  let kept = 0, total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      total++;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) { out[ny * w + nx] = 1; kept++; }
    }
  }
  const outOfFrame = total > 0 ? 1 - kept / total : 1;
  return { m: out, outOfFrame };
}

/**
 * Estimate integer translation (dx,dy) of a region between two gray frames via SAD.
 * Returns best displacement and a confidence in 0..1.
 */
function estimateFlow(
  prev: Float32Array, cur: Float32Array, w: number, h: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  searchR: number
) {
  const x0 = Math.max(searchR, bbox.minX - 4);
  const y0 = Math.max(searchR, bbox.minY - 4);
  const x1 = Math.min(w - 1 - searchR, bbox.maxX + 4);
  const y1 = Math.min(h - 1 - searchR, bbox.maxY + 4);
  if (x1 <= x0 || y1 <= y0) return { dx: 0, dy: 0, conf: 0 };
  const step = Math.max(1, Math.floor((x1 - x0) / 24));
  let best = { dx: 0, dy: 0, sad: Infinity };
  let zeroSad = 0, n = 0;
  for (let dy = -searchR; dy <= searchR; dy++) {
    for (let dx = -searchR; dx <= searchR; dx++) {
      let sad = 0, c = 0;
      for (let y = y0; y <= y1; y += step) {
        for (let x = x0; x <= x1; x += step) {
          const a = prev[y * w + x];
          const b = cur[(y + dy) * w + (x + dx)];
          sad += Math.abs(a - b); c++;
        }
      }
      sad /= Math.max(1, c);
      if (dx === 0 && dy === 0) zeroSad = sad;
      if (sad < best.sad) best = { dx, dy, sad };
      n++;
    }
  }
  // confidence: how much better best is vs the average; and absolute residual
  const conf = Math.max(0, Math.min(1, 1 - best.sad / 60));
  return { dx: best.dx, dy: best.dy, conf };
}

/**
 * Propagate `keyMask` (defined on frame `keyIndex`) across all frames.
 * frames: array of ImageData (or {data,width,height}).
 */
export function trackMask(
  frames: { data: Uint8ClampedArray; width: number; height: number }[],
  keyIndex: number,
  keyMask: Mask,
  onProgress?: (frac: number) => void
): TrackResult {
  const n = frames.length;
  const w = frames[0].width, h = frames[0].height;
  const masks: Mask[] = new Array(n);
  const confidence: number[] = new Array(n).fill(1);
  masks[keyIndex] = keyMask.slice();

  const grays: (Float32Array | null)[] = new Array(n).fill(null);
  const gray = (i: number) => (grays[i] ??= toGray(frames[i].data, w, h));
  const searchR = Math.max(6, Math.round(Math.min(w, h) * 0.04));

  // forward
  for (let i = keyIndex + 1; i < n; i++) {
    const prevMask = masks[i - 1];
    const bbox = maskBBox(prevMask, w, h);
    if (!bbox || bbox.count < 4) { masks[i] = new Uint8Array(w * h); confidence[i] = 0; continue; }
    const { dx, dy, conf } = estimateFlow(gray(i - 1), gray(i), w, h, bbox, searchR);
    const { m, outOfFrame } = shiftMask(prevMask, w, h, dx, dy);
    masks[i] = outOfFrame > 0.85 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
    onProgress?.((i - keyIndex) / n);
  }
  // backward
  for (let i = keyIndex - 1; i >= 0; i--) {
    const nextMask = masks[i + 1];
    const bbox = maskBBox(nextMask, w, h);
    if (!bbox || bbox.count < 4) { masks[i] = new Uint8Array(w * h); confidence[i] = 0; continue; }
    const { dx, dy, conf } = estimateFlow(gray(i + 1), gray(i), w, h, bbox, searchR);
    const { m, outOfFrame } = shiftMask(nextMask, w, h, dx, dy);
    masks[i] = outOfFrame > 0.85 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
  }
  return { masks, confidence };
}

/** Temporal smoothing of masks: a frame's mask = union with neighbours' eroded masks. */
export function smoothMasks(masks: Mask[], w: number, h: number): Mask[] {
  const n = masks.length;
  const out: Mask[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = masks[i].slice();
    const prev = masks[i - 1], next = masks[i + 1];
    if (prev && next) {
      for (let p = 0; p < w * h; p++) {
        // fill temporal holes: if both neighbours masked, mask this too
        if (!m[p] && prev[p] && next[p]) m[p] = 1;
      }
    }
    out[i] = m;
  }
  return out;
}
