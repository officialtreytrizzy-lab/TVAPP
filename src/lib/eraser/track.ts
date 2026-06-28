// Optical-flow (block-matching) mask propagation across frames.
//
// The marked object MOVES through the clip, so a static mask only covers it on
// the keyframe. This tracker follows the object so it is removed from EVERY
// frame. Improvements vs. a naive per-frame translate:
//   1. Velocity-predicted, COARSE-TO-FINE block matching — captures large/fast
//      motion accurately without an expensive full search every pixel.
//   2. A drift-resistant "core" mask is what we propagate (we never feed a
//      grown/dilated mask back into tracking, so error can't snowball).
//   3. An ADAPTIVE SAFETY MARGIN dilates the *output* mask based on how fast the
//      object is moving + tracking uncertainty, so the object's edges never poke
//      out and reappear.
//
// A per-frame confidence is produced so low-confidence ranges can be flagged for
// refinement, and the mask is dropped only if the target truly leaves the frame.

import type { Mask } from './inpaint';

export interface TrackResult {
  masks: Mask[]; // per-frame OUTPUT mask (with safety margin), same length as frames
  confidence: number[]; // 0..1 per frame
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
  let cur = mask;
  for (let it = 0; it < r; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) { next[i] = 1; continue; }
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            if (cur[ny * w + nx]) { on = 1; break; }
          }
        }
        if (on) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
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

/** Mean absolute difference of the template region (from `prev`) against `cur` shifted by (dx,dy). */
function regionSAD(
  prev: Float32Array, cur: Float32Array, w: number, h: number,
  rx0: number, ry0: number, rx1: number, ry1: number, step: number,
  dx: number, dy: number
): number {
  let sad = 0, c = 0;
  for (let y = ry0; y <= ry1; y += step) {
    const cy = y + dy; if (cy < 0 || cy >= h) continue;
    for (let x = rx0; x <= rx1; x += step) {
      const cx = x + dx; if (cx < 0 || cx >= w) continue;
      sad += Math.abs(prev[y * w + x] - cur[cy * w + cx]); c++;
    }
  }
  // require enough coverage to trust a match (avoid edge-of-frame degenerate fits)
  return c >= 12 ? sad / c : Infinity;
}

/**
 * Estimate integer translation (dx,dy) of the masked region between two gray
 * frames, searching around a predicted displacement. Coarse pass localizes big
 * motion, fine pass refines to the pixel. Returns displacement + confidence.
 */
function estimateFlow(
  prev: Float32Array, cur: Float32Array, w: number, h: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  searchR: number, predDx: number, predDy: number
) {
  const rx0 = bbox.minX, ry0 = bbox.minY, rx1 = bbox.maxX, ry1 = bbox.maxY;
  const bw = rx1 - rx0 + 1, bh = ry1 - ry0 + 1;
  const step = Math.max(1, Math.floor(Math.max(bw, bh) / 24));

  const zeroSad = regionSAD(prev, cur, w, h, rx0, ry0, rx1, ry1, step, 0, 0);

  // coarse pass around the predicted displacement
  const coarse = Math.max(2, Math.round(searchR / 5));
  let best = { dx: 0, dy: 0, sad: Infinity };
  for (let dy = predDy - searchR; dy <= predDy + searchR; dy += coarse) {
    for (let dx = predDx - searchR; dx <= predDx + searchR; dx += coarse) {
      const sad = regionSAD(prev, cur, w, h, rx0, ry0, rx1, ry1, step, dx, dy);
      if (sad < best.sad) best = { dx, dy, sad };
    }
  }
  // also test the no-motion candidate (objects that pause)
  if (zeroSad < best.sad) best = { dx: 0, dy: 0, sad: zeroSad };

  // fine pass: ±coarse around the coarse winner, single-pixel steps
  const fr = coarse + 1;
  const c0x = best.dx, c0y = best.dy;
  for (let dy = c0y - fr; dy <= c0y + fr; dy++) {
    for (let dx = c0x - fr; dx <= c0x + fr; dx++) {
      const sad = regionSAD(prev, cur, w, h, rx0, ry0, rx1, ry1, step, dx, dy);
      if (sad < best.sad) best = { dx, dy, sad };
    }
  }

  // confidence: low residual => high confidence; also reward that the match is
  // clearly better than staying still (real, trackable motion).
  const residualConf = Math.max(0, Math.min(1, 1 - best.sad / 55));
  const improveConf = zeroSad > 0 ? Math.max(0, Math.min(1, (zeroSad - best.sad) / zeroSad + 0.5)) : 0.5;
  const conf = Math.max(0, Math.min(1, 0.65 * residualConf + 0.35 * improveConf));
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
  const w = frames[0].width, h = frames[0].height;

  // `core` = the propagated mask WITHOUT safety margin. We track on this so
  // dilation never feeds back and inflates the mask over time.
  const core: Mask[] = new Array(n);
  const confidence: number[] = new Array(n).fill(1);
  const motion: number[] = new Array(n).fill(0); // px displacement magnitude per frame
  core[keyIndex] = keyMask.slice();

  const grays: (Float32Array | null)[] = new Array(n).fill(null);
  const gray = (i: number) => (grays[i] ??= toGray(frames[i].data, w, h));
  // generous search range so fast-moving objects are still found each frame
  const searchR = Math.max(10, Math.round(Math.min(w, h) * 0.07));

  // forward pass with velocity prediction
  let vx = 0, vy = 0;
  for (let i = keyIndex + 1; i < n; i++) {
    const prevMask = core[i - 1];
    const bbox = maskBBox(prevMask, w, h);
    if (!bbox || bbox.count < 4) { core[i] = new Uint8Array(w * h); confidence[i] = 0; continue; }
    const { dx, dy, conf } = estimateFlow(gray(i - 1), gray(i), w, h, bbox, searchR, vx, vy);
    const { m, outOfFrame } = shiftMask(prevMask, w, h, dx, dy);
    core[i] = outOfFrame > 0.9 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
    motion[i] = Math.hypot(dx, dy);
    // smooth velocity estimate for next prediction
    vx = Math.round(0.6 * dx + 0.4 * vx);
    vy = Math.round(0.6 * dy + 0.4 * vy);
    onProgress?.((i - keyIndex) / n);
  }

  // backward pass (reset velocity)
  vx = 0; vy = 0;
  for (let i = keyIndex - 1; i >= 0; i--) {
    const nextMask = core[i + 1];
    const bbox = maskBBox(nextMask, w, h);
    if (!bbox || bbox.count < 4) { core[i] = new Uint8Array(w * h); confidence[i] = 0; continue; }
    const { dx, dy, conf } = estimateFlow(gray(i + 1), gray(i), w, h, bbox, searchR, vx, vy);
    const { m, outOfFrame } = shiftMask(nextMask, w, h, dx, dy);
    core[i] = outOfFrame > 0.9 ? new Uint8Array(w * h) : m;
    confidence[i] = Math.max(0, conf * (1 - outOfFrame));
    motion[i] = Math.hypot(dx, dy);
    vx = Math.round(0.6 * dx + 0.4 * vx);
    vy = Math.round(0.6 * dy + 0.4 * vy);
  }

  // Build OUTPUT masks: dilate each core mask by an adaptive safety margin so
  // the moving object stays fully covered even when tracking is a few px off.
  const baseMargin = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const masks: Mask[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = core[i];
    if (!c || !c.some((v) => v === 1)) { masks[i] = c ?? new Uint8Array(w * h); continue; }
    // more motion or lower confidence => bigger safety margin
    const motionMargin = Math.round(motion[i] * 0.5);
    const uncertaintyMargin = Math.round((1 - confidence[i]) * baseMargin * 2);
    const margin = Math.min(
      Math.round(Math.min(w, h) * 0.12), // hard cap so we never erase half the frame
      baseMargin + motionMargin + uncertaintyMargin
    );
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
