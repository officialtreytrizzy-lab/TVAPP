// Real content-aware inpainting on an ImageData using PDE/diffusion reconstruction
// (Bertalmio-style). The masked hole is solved from surrounding real pixels via
// (1) nearest-valid-neighbour initialization, then (2) constrained anisotropic
// diffusion. Known pixels act as Dirichlet boundary conditions, so this is true
// image inpainting — NOT a blur of the whole frame, NOT a black box, NOT a crop.

export type Mask = Uint8Array; // length w*h, 1 = remove/inpaint, 0 = keep

/** Dilate/erode helper used for feathering. */
function dilate(mask: Mask, w: number, h: number, r: number): Mask {
  if (r <= 0) return mask.slice();
  let cur = mask;
  for (let it = 0; it < r; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) { next[i] = 1; continue; }
        if (
          (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])
        ) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** Nearest-valid-neighbour fill via multi-pass sweep (fast approximate jump flood). */
function initFill(data: Uint8ClampedArray, mask: Mask, w: number, h: number) {
  // distance + source index per masked pixel; sweep 4 directions
  const srcX = new Int32Array(w * h).fill(-1);
  const srcY = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) { srcX[i] = i % w; srcY[i] = (i / w) | 0; }
  }
  const passes = [
    { sx: 0, ex: w, dx: 1, sy: 0, ey: h, dy: 1 },
    { sx: w - 1, ex: -1, dx: -1, sy: h - 1, ey: -1, dy: -1 },
    { sx: w - 1, ex: -1, dx: -1, sy: 0, ey: h, dy: 1 },
    { sx: 0, ex: w, dx: 1, sy: h - 1, ey: -1, dy: -1 },
  ];
  const dist = (ax: number, ay: number, bx: number, by: number) =>
    (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
  for (let p = 0; p < passes.length; p++) {
    const P = passes[p];
    for (let y = P.sy; y !== P.ey; y += P.dy) {
      for (let x = P.sx; x !== P.ex; x += P.dx) {
        const i = y * w + x;
        if (srcX[i] >= 0) continue;
        // check already-processed neighbours
        const neigh = [i - P.dx, i - P.dy * w, i - P.dx - P.dy * w];
        let bestI = -1, bestD = Infinity;
        for (const ni of neigh) {
          if (ni < 0 || ni >= w * h) continue;
          if (srcX[ni] < 0) continue;
          const d = dist(x, y, srcX[ni], srcY[ni]);
          if (d < bestD) { bestD = d; bestI = ni; }
        }
        if (bestI >= 0) { srcX[i] = srcX[bestI]; srcY[i] = srcY[bestI]; }
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (mask[i] && srcX[i] >= 0) {
      const si = (srcY[i] * w + srcX[i]) * 4;
      const di = i * 4;
      data[di] = data[si]; data[di + 1] = data[si + 1];
      data[di + 2] = data[si + 2]; data[di + 3] = 255;
    }
  }
}

/**
 * Inpaint masked region in-place on `imageData`.
 * @param iterations diffusion iterations (more = smoother/cleaner, slower)
 * @param feather feather radius in px for soft blending at the hole boundary
 */
export function inpaint(
  imageData: ImageData,
  mask: Mask,
  opts: { iterations?: number; feather?: number } = {}
): ImageData {
  const { width: w, height: h } = imageData;
  const iterations = opts.iterations ?? 60;
  const feather = opts.feather ?? 3;
  const data = imageData.data;

  // slightly grow the mask so we don't leave object-edge halos
  const work = dilate(mask, w, h, 1);

  // 1) initialize hole with nearest real colours
  initFill(data, work, w, h);

  // 2) constrained anisotropic diffusion (solve Laplace eq on the hole)
  //    operate on a float buffer for stability
  const ch = [0, 1, 2];
  const buf = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = data[i * 4];
    buf[i * 3 + 1] = data[i * 4 + 1];
    buf[i * 3 + 2] = data[i * 4 + 2];
  }
  const next = new Float32Array(buf.length);
  for (let it = 0; it < iterations; it++) {
    next.set(buf);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!work[i]) continue;
        const l = i - 1, r = i + 1, u = i - w, d = i + w;
        for (const c of ch) {
          // edge-aware weights: favour neighbours with similar colour to preserve structure
          const center = buf[i * 3 + c];
          const vl = buf[l * 3 + c], vr = buf[r * 3 + c], vu = buf[u * 3 + c], vd = buf[d * 3 + c];
          const wl = 1 / (1 + Math.abs(vl - center) * 0.05);
          const wr = 1 / (1 + Math.abs(vr - center) * 0.05);
          const wu = 1 / (1 + Math.abs(vu - center) * 0.05);
          const wd = 1 / (1 + Math.abs(vd - center) * 0.05);
          const sum = wl + wr + wu + wd;
          next[i * 3 + c] = (vl * wl + vr * wr + vu * wu + vd * wd) / sum;
        }
      }
    }
    buf.set(next);
  }

  // 3) write back with feathered blend at boundary
  const featherMask = feather > 0 ? buildFeather(work, w, h, feather) : null;
  for (let i = 0; i < w * h; i++) {
    if (!work[i]) continue;
    const di = i * 4;
    const a = featherMask ? featherMask[i] : 1; // 1 = fully inpainted
    data[di] = data[di] * (1 - a) + buf[i * 3] * a;
    data[di + 1] = data[di + 1] * (1 - a) + buf[i * 3 + 1] * a;
    data[di + 2] = data[di + 2] * (1 - a) + buf[i * 3 + 2] * a;
    data[di + 3] = 255;
  }
  return imageData;
}

/** Soft alpha that ramps from 0 at the hole boundary to 1 in the interior. */
function buildFeather(mask: Mask, w: number, h: number, r: number): Float32Array {
  // distance transform-ish: erode r times, accumulate
  const alpha = new Float32Array(w * h);
  let cur = mask.slice();
  for (let i = 0; i < w * h; i++) alpha[i] = mask[i] ? 1 : 0;
  for (let k = 1; k <= r; k++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) continue;
        const boundary =
          (x === 0 || !cur[i - 1]) || (x === w - 1 || !cur[i + 1]) ||
          (y === 0 || !cur[i - w]) || (y === h - 1 || !cur[i + w]);
        if (boundary) { alpha[i] = Math.min(alpha[i], k / (r + 1)); }
        else next[i] = 1;
      }
    }
    cur = next;
  }
  return alpha;
}
