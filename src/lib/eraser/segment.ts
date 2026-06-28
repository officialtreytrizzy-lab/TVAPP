import type { Mask } from './inpaint';

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
  cx: number;
  cy: number;
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
      const i = y * w + x;
      if (!mask[i]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sx += x;
      sy += y;
      count++;
    }
  }

  if (maxX < 0 || count === 0) return null;
  return { minX, minY, maxX, maxY, count, cx: sx / count, cy: sy / count };
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

function erode(mask: Mask, w: number, h: number, radius: number): Mask {
  if (radius <= 0) return mask.slice();
  let cur = mask.slice();
  for (let r = 0; r < radius; r++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) continue;
        let keep = true;
        for (let dy = -1; dy <= 1 && keep; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) { keep = false; break; }
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w || !cur[ny * w + nx]) { keep = false; break; }
          }
        }
        if (!keep) next[i] = 0;
      }
    }
    cur = next;
  }
  return cur;
}

function closeMask(mask: Mask, w: number, h: number, radius: number): Mask {
  return erode(dilate(mask, w, h, radius), w, h, radius);
}

function colorDistSq(data: Uint8ClampedArray, i: number, r: number, g: number, b: number): number {
  const o = i * 4;
  const dr = data[o] - r;
  const dg = data[o + 1] - g;
  const db = data[o + 2] - b;
  return dr * dr + dg * dg + db * db;
}

export function countMaskPixels(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/**
 * Convert the user's scribble/dot into a practical object mask on the chosen
 * keyframe. The old pipeline tracked only the raw scribble, so a tiny dot could
 * drift to the wrong side of the frame and then get over-dilated. This grows the
 * scribble into the connected local region it was placed on before tracking.
 */
export function expandScribbleToObjectMask(frame: ImageData, scribbleMask: Mask): Mask {
  const { data, width: w, height: h } = frame;
  const bbox = maskBBox(scribbleMask, w, h);
  if (!bbox) return scribbleMask.slice();

  const seedCount = Math.max(1, bbox.count);
  let mr = 0;
  let mg = 0;
  let mb = 0;

  for (let i = 0; i < scribbleMask.length; i++) {
    if (!scribbleMask[i]) continue;
    const o = i * 4;
    mr += data[o];
    mg += data[o + 1];
    mb += data[o + 2];
  }

  mr /= seedCount;
  mg /= seedCount;
  mb /= seedCount;

  let variance = 0;
  for (let i = 0; i < scribbleMask.length; i++) {
    if (!scribbleMask[i]) continue;
    variance += colorDistSq(data, i, mr, mg, mb);
  }
  variance /= seedCount;

  const seedW = bbox.maxX - bbox.minX + 1;
  const seedH = bbox.maxY - bbox.minY + 1;
  const seedScale = Math.max(seedW, seedH);
  const roiPad = Math.max(18, Math.round(seedScale * 2.8), Math.round(Math.min(w, h) * 0.035));
  const roiMinX = Math.max(0, bbox.minX - roiPad);
  const roiMinY = Math.max(0, bbox.minY - roiPad);
  const roiMaxX = Math.min(w - 1, bbox.maxX + roiPad);
  const roiMaxY = Math.min(h - 1, bbox.maxY + roiPad);
  const maxArea = Math.max(seedCount * 16, Math.round(w * h * 0.08));
  const tolerance = Math.max(26, Math.min(78, Math.sqrt(variance) * 1.8 + 24));
  const toleranceSq = tolerance * tolerance;

  const out = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];

  for (let i = 0; i < scribbleMask.length; i++) {
    if (!scribbleMask[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < roiMinX || x > roiMaxX || y < roiMinY || y > roiMaxY) continue;
    visited[i] = 1;
    out[i] = 1;
    queue.push(i);
  }

  let head = 0;
  while (head < queue.length && queue.length < maxArea) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    const neigh = [i - 1, i + 1, i - w, i + w];
    for (const ni of neigh) {
      if (ni < 0 || ni >= out.length || visited[ni]) continue;
      const nx = ni % w;
      const ny = (ni / w) | 0;
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      if (nx < roiMinX || nx > roiMaxX || ny < roiMinY || ny > roiMaxY) continue;
      visited[ni] = 1;
      if (colorDistSq(data, ni, mr, mg, mb) <= toleranceSq) {
        out[ni] = 1;
        queue.push(ni);
      }
    }
  }

  const grownCount = countMaskPixels(out);
  const fallbackRadius = Math.max(2, Math.min(8, Math.round(seedScale * 0.35)));

  // If color growth found almost nothing, keep the user mark accurate and add a
  // modest local cushion instead of a giant global tracking margin.
  if (grownCount < seedCount * 1.8) {
    return dilate(scribbleMask, w, h, fallbackRadius);
  }

  return closeMask(dilate(out, w, h, 2), w, h, 1);
}
