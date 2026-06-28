// Optical-flow (block-matching) mask propagation across frames.
//
// The marked object MOVES through the clip, so a static mask only covers it on
// the keyframe. This tracker follows the object so it is removed from EVERY
// frame. The important guardrails here are:
//   1. Search radius is based on the target's size, not the whole frame, so a
//      tiny dot cannot jump to a random similar patch on the opposite side.
//   2. Low-confidence ambiguous matches prefer no-motion over wild jumps.
//   3. Safety dilation is capped relative to the tracked object, so a small
//      marker never becomes a huge circle.

import type { Mask } from './inpaint';

export interface TrackResult {
  masks: Mask[]; // per-frame OUTPUT mask (with safety margin), same length as frames
  confidence: number[]; // 0..1 per frame
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
  cx: number;
  cy: number;
}

function toGray(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return g;
}

/** Round-ish 8-neighbour dilation by `r` passes. */
function dilate(mask: Mask, w: number, h: number, r: number): Mask {
  if (r <= 0) return mask.slice();
  let cur = mask.slice();
  for (let it = 0; it < r; it++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) { next[i] = 1; continue; }
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
  let sx = 0;
  let sy = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        sx += x;
        sy += y;
        count++;
      }
    }
  }

  if (maxX < 0 || count === 0) return null;
  return { minX, minY, maxX, maxY, count, cx: sx / count, cy: sy / count };
}

function expandBBox(b: BBox, w: number, h: number, pad: number): BBox {
  return {
    ...b,
    minX: Math.max(0, b.minX - pad),
    minY: Math.max(0, b.minY - pad),
    maxX: Math.min(w - 1, b.maxX + pad),
    maxY: Math.min(h - 1, b.maxY + pad),
  };
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

/** Mean absolute difference of the template region (from `prev`) against `cur` shifted by (dx,dy). */
function regionSAD(
  prev: Float32Array,
  cur: Float32Array,
  w: number,
  h: number,
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  step: number,
  dx: number,
  dy: number
): number {
  let sad = 0;
  let c = 0;

  for (let y = ry0; y <= ry1; y += step) {
    const cy = y + dy;
    if (cy < 0 || cy >= h) continue;
    for (let x = rx0; x <= rx1; x += step) {
      const cx = x + dx;
      if (cx < 0 || cx >= w) continue;
      sad += Math.abs(prev[y * w + x] - cur[cy * w + cx]);
      c++;
    }
  }

  // require enough coverage to trust a match (avoid edge-of-frame degenerate fits)
  return c >= 12 ? sad / c : Infinity;
}

function searchRadiusForBBox(bbox: BBox, w: number, h: number, predDx: number, predDy: number): number {
  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  const objectScale = Math.max(bw, bh);
  const predicted = Math.hypot(predDx, predDy);
  const maxSearch = Math.max(8, Math.round(Math.min(w, h) * 0.08));
  return Math.max(4, Math.min(maxSearch, Math.round(objectScale * 0.75 + predicted * 1.5 + 6)));
}

/**
 * Estimate integer translation (dx,dy) of the masked region between two gray
 * frames, searching around a predicted displacement. Coarse pass localizes big
 * motion, fine pass refines to the pixel. Returns displacement + confidence.
 */
function estimateFlow(
  prev: Float32Array,
  cur: Float32Array,
  w: number,
  h: number,
  bbox: BBox,
  searchR: number,
  predDx: number,
  predDy: number
) {
  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  const pad = Math.max(2, Math.min(14, Math.round(Math.max(bw, bh) * 0.22)));
  const patch = expandBBox(bbox, w, h, pad);
  const rx0 = patch.minX;
  const ry0 = patch.minY;
  const rx1 = patch.maxX;
  const ry1 = patch.maxY;
  const step = Math.max(1, Math.floor(Math.max(rx1 - rx0 + 1, ry1 - ry0 + 1) / 28));

  const zeroSad = regionSAD(prev, cur, w, h, rx0, ry0, rx1, ry1, step, 0, 0);

  // coarse pass around the predicted displacement
  const coarse = Math.max(1, Math.round(searchR / 5));
  let best = { dx: 0, dy: 0, sad: zeroSad };

  for (let dy = predDy - searchR; dy <= predDy + searchR; dy += coarse) {
    for (let dx = predDx - searchR; dx <= predDx + searchR; dx += coarse) {
      const sad = regionSAD(prev, cur, w, h, rx0, ry0, rx1, ry1, step, dx, dy);
      if (sad < best.sad) best = { dx, dy, sad };
    }
  }

  // fine pass: ±coarse around the coarse winner, single-pixel steps
  const fr = coarse + 1;
  const c0x = best.dx;
  const c0y = best.dy;
  for (let dy = c0y - fr; dy <= c0y + fr; dy++) {
    for (let dx = c0x - fr; dx <= c0x + fr; dx++) {
      const sad = regionSAD(prev, cur, w, h, rx0, ry0, rx1, ry1, step, dx, dy);
      if (sad < best.sad) best = { dx, dy, sad };
    }
  }

  const improvement = Number.isFinite(zeroSad) && zeroSad > 0 ? (zeroSad - best.sad) / zeroSad : 0;
  const jump = Math.hypot(best.dx, best.dy);

  // If the shifted match is barely better than no-motion, do not let a tiny
  // or low-texture target jump across the screen.
  if (improvement < 0.08 && jump > Math.max(3, searchR * 0.35)) {
    best = { dx: 0, dy: 0, sad: zeroSad };
  }

  const residualConf = Math.max(0, Math.min(1, 1 - best.sad / 55));
  const improveConf = Number.isFinite(zeroSad) && zeroSad > 0
    ? Math.max(0, Math.min(1, improvement + 0.5))
    : 0.5;
  const conf = Math.max(0, Math.min(1, 0.7 * residualConf + 0.3 * improveConf));

  return { dx: best.dx, dy: best.dy, conf };
}

/**
 * Propagate `keyMask` (defined on frame `keyIndex`) across all frames so the
 * marked object is tracked and removed throughout the clip.
 */
export function trackMask(
  frames: { data: Uint8ClampedArray; width: number; height: number }[],
  keyIndex: number,
  keyMask: Mask,
  onProgress?: (frac: number) => void
): TrackResult {
  const n = frames.length;
  const w = frames[0].width;
  const h = frames[0].height;

  // `core` = the propagated mask WITHOUT safety margin. We track on this so
  // dilation never feeds back and inflates the mask over time.
  const core: Mask[] = new Array(n);
  const confidence: number[] = new Array(n).fill(1);
  const motion: number[] = new Array(n).fill(0); // px displacement magnitude per frame
  core[keyIndex] = keyMask.slice();

  const grays: (Float32Array | null)[] = new Array(n).fill(null);
  const gray = (i: number) => (grays[i] ??= toGray(frames[i].data, w, h));

  // forward pass with velocity prediction
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

    const searchR = searchRadiusForBBox(bbox, w, h, vx, vy);
    const { dx, dy, conf } = estimateFlow(gray(i - 1), gray(i), w, h, bbox, searchR, vx, vy);
    const { m, outOfFrame } = shiftMask(prevMask, w, h, dx, dy);
    core[i] = outOfFrame > 0.9 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
    motion[i] = Math.hypot(dx, dy);

    // smooth velocity estimate for next prediction
    vx = Math.round(0.6 * dx + 0.4 * vx);
    vy = Math.round(0.6 * dy + 0.4 * vy);
    onProgress?.((i - keyIndex) / Math.max(1, n - 1));
  }

  // backward pass (reset velocity)
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

    const searchR = searchRadiusForBBox(bbox, w, h, vx, vy);
    const { dx, dy, conf } = estimateFlow(gray(i + 1), gray(i), w, h, bbox, searchR, vx, vy);
    const { m, outOfFrame } = shiftMask(nextMask, w, h, dx, dy);
    core[i] = outOfFrame > 0.9 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
    motion[i] = Math.hypot(dx, dy);
    vx = Math.round(0.6 * dx + 0.4 * vx);
    vy = Math.round(0.6 * dy + 0.4 * vy);
  }

  // Build OUTPUT masks: dilate each core mask by a capped local safety margin.
  const masks: Mask[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = core[i];
    const bbox = c ? maskBBox(c, w, h) : null;
    if (!c || !bbox) {
      masks[i] = new Uint8Array(w * h);
      continue;
    }

    const bw = bbox.maxX - bbox.minX + 1;
    const bh = bbox.maxY - bbox.minY + 1;
    const objectScale = Math.max(bw, bh);
    const baseMargin = Math.max(2, Math.min(10, Math.round(objectScale * 0.08)));
    const motionMargin = Math.min(Math.round(objectScale * 0.35), Math.round(motion[i] * 0.35));
    const uncertaintyMargin = Math.round((1 - confidence[i]) * baseMargin);
    const frameCap = Math.max(4, Math.round(Math.min(w, h) * 0.045));
    const objectCap = Math.max(3, Math.round(objectScale * 0.55));
    const margin = Math.min(frameCap, objectCap, baseMargin + motionMargin + uncertaintyMargin);

    masks[i] = dilate(c, w, h, margin);
  }

  return { masks, confidence };
}

/**
 * Temporal smoothing: fill single-frame holes and bridge the mask across frames
 * where the object briefly drops out, so removal doesn't flicker.
 */
export function smoothMasks(masks: Mask[], w: number, h: number): Mask[] {
  const n = masks.length;
  const out: Mask[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const m = masks[i].slice();
    const prev = masks[i - 1];
    const next = masks[i + 1];
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
