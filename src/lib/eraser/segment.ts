import type { Mask } from './inpaint';

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

function maskBBox(mask: Mask, w: number, h: number): BBox | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
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

function dilate(mask: Mask, w: number, h: number, radius: number): Mask {
  if (radius <= 0) return mask.slice();
  let cur = mask.slice();
  for (let r = 0; r < radius; r++) {
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
            if (cur[ny * w + nx]) {
              on = true;
              break;
            }
          }
        }
        if (on) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

export function countMaskPixels(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/**
 * Keep the user-selected target precise. Earlier code tried to auto-grow the
 * scribble by color, but that made the mask cover too much and could select the
 * wrong nearby object/background. For object removal, the user's mark is the
 * strongest signal, so this only adds a tiny edge cushion for clean inpainting.
 */
export function expandScribbleToObjectMask(frame: ImageData, scribbleMask: Mask): Mask {
  const { width: w, height: h } = frame;
  const bbox = maskBBox(scribbleMask, w, h);
  if (!bbox) return scribbleMask.slice();

  const targetW = bbox.maxX - bbox.minX + 1;
  const targetH = bbox.maxY - bbox.minY + 1;
  const targetScale = Math.max(targetW, targetH);

  // A tiny pinpoint should stay tiny. Larger brush strokes get at most a small
  // cushion, not color flood-fill expansion.
  const cushion = targetScale <= 10 ? 1 : targetScale <= 32 ? 2 : 3;
  return dilate(scribbleMask, w, h, cushion);
}
