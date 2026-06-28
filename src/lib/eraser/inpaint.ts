// Local content-aware inpainting for the browser eraser.
// Keep fills tight. The mask already defines the user's selected target, so this
// module should not enlarge the mask or smear a large blur into nearby pixels.

export type Mask = Uint8Array; // length w*h, 1 = remove/inpaint, 0 = keep

function dilate(mask: Mask, w: number, h: number, r: number): Mask {
  if (r <= 0) return mask.slice();
  let cur = mask.slice();
  for (let it = 0; it < r; it++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
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

/** Nearest-valid-neighbour fill via multi-pass sweep. */
function initFill(data: Uint8ClampedArray, mask: Mask, w: number, h: number) {
  const srcX = new Int32Array(w * h).fill(-1);
  const srcY = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) {
      srcX[i] = i % w;
      srcY[i] = (i / w) | 0;
    }
  }

  const passes = [
    { sx: 0, ex: w, dx: 1, sy: 0, ey: h, dy: 1 },
    { sx: w - 1, ex: -1, dx: -1, sy: h - 1, ey: -1, dy: -1 },
    { sx: w - 1, ex: -1, dx: -1, sy: 0, ey: h, dy: 1 },
    { sx: 0, ex: w, dx: 1, sy: h - 1, ey: -1, dy: -1 },
  ];
  const dist = (ax: number, ay: number, bx: number, by: number) =>
    (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

  for (const P of passes) {
    for (let y = P.sy; y !== P.ey; y += P.dy) {
      for (let x = P.sx; x !== P.ex; x += P.dx) {
        const i = y * w + x;
        if (srcX[i] >= 0) continue;
        const neigh = [i - P.dx, i - P.dy * w, i - P.dx - P.dy * w];
        let bestI = -1;
        let bestD = Infinity;
        for (const ni of neigh) {
          if (ni < 0 || ni >= w * h) continue;
          if (srcX[ni] < 0) continue;
          const d = dist(x, y, srcX[ni], srcY[ni]);
          if (d < bestD) {
            bestD = d;
            bestI = ni;
          }
        }
        if (bestI >= 0) {
          srcX[i] = srcX[bestI];
          srcY[i] = srcY[bestI];
        }
      }
    }
  }

  for (let i = 0; i < w * h; i++) {
    if (mask[i] && srcX[i] >= 0) {
      const si = (srcY[i] * w + srcX[i]) * 4;
      const di = i * 4;
      data[di] = data[si];
      data[di + 1] = data[si + 1];
      data[di + 2] = data[si + 2];
      data[di + 3] = 255;
    }
  }
}

/**
 * Inpaint masked region in-place on `imageData`.
 * @param iterations diffusion iterations; lower values keep texture sharper
 * @param feather boundary feather; keep low to avoid visible blur halos
 * @param grow optional mask growth; default 0 to preserve the user's exact area
 */
export function inpaint(
  imageData: ImageData,
  mask: Mask,
  opts: { iterations?: number; feather?: number; grow?: number } = {}
): ImageData {
  const { width: w, height: h } = imageData;
  const iterations = opts.iterations ?? 18;
  const feather = opts.feather ?? 1;
  const grow = opts.grow ?? 0;
  const data = imageData.data;
  const work = grow > 0 ? dilate(mask, w, h, grow) : mask.slice();

  initFill(data, work, w, h);

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
        const l = i - 1;
        const r = i + 1;
        const u = i - w;
        const d = i + w;
        for (const c of ch) {
          const center = buf[i * 3 + c];
          const vl = buf[l * 3 + c];
          const vr = buf[r * 3 + c];
          const vu = buf[u * 3 + c];
          const vd = buf[d * 3 + c];
          const wl = 1 / (1 + Math.abs(vl - center) * 0.08);
          const wr = 1 / (1 + Math.abs(vr - center) * 0.08);
          const wu = 1 / (1 + Math.abs(vu - center) * 0.08);
          const wd = 1 / (1 + Math.abs(vd - center) * 0.08);
          const sum = wl + wr + wu + wd;
          next[i * 3 + c] = (vl * wl + vr * wr + vu * wu + vd * wd) / sum;
        }
      }
    }
    buf.set(next);
  }

  const featherMask = feather > 0 ? buildFeather(work, w, h, feather) : null;
  for (let i = 0; i < w * h; i++) {
    if (!work[i]) continue;
    const di = i * 4;
    const a = featherMask ? featherMask[i] : 1;
    data[di] = data[di] * (1 - a) + buf[i * 3] * a;
    data[di + 1] = data[di + 1] * (1 - a) + buf[i * 3 + 1] * a;
    data[di + 2] = data[di + 2] * (1 - a) + buf[i * 3 + 2] * a;
    data[di + 3] = 255;
  }

  return imageData;
}

/** Soft alpha that ramps from 0 at the hole boundary to 1 in the interior. */
function buildFeather(mask: Mask, w: number, h: number, r: number): Float32Array {
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
        if (boundary) alpha[i] = Math.min(alpha[i], k / (r + 1));
        else next[i] = 1;
      }
    }
    cur = next;
  }

  return alpha;
}
