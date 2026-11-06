// 油漆桶的纯算法部分：只操作 RGBA 缓冲区，不碰 canvas，可以直接单测。
// 两端用同样的输入跑出完全相同的像素，所以协议里不用传位图。

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FilledRegion {
  /** 每像素一字节，1 = 这次填充涂到了 */
  visited: Uint8Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Scanline flood fill in-place on a RGBA pixel buffer. Replaces all pixels
 * connected to (sx, sy) whose color is within per-channel `tolerance` of the
 * seed color with (fr,fg,fb,255). O(N) worst case.
 */
function scanlineFill(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  fr: number,
  fg: number,
  fb: number,
  tolerance: number,
): FilledRegion {
  const idx0 = (sy * w + sx) * 4;
  const tr = data[idx0];
  const tg = data[idx0 + 1];
  const tb = data[idx0 + 2];
  const tol = tolerance;
  // visited 位图：每像素一字节。paint 时 mark，matches 优先检查。
  // 关键：fill 色可能与 target 色在容差内但不相等（吸管吸到画布反走样像素的
  // 经典场景），此时 paint 后的像素 RGB 仍落在容差里。如果没有 visited，
  // 已染色像素会被反复 push 进 stack → 死循环 → Array.push 抛
  // "Invalid array length" → 浏览器卡死。visited 让每个像素最多处理一次，
  // 既根除死循环，又不影响相近颜色的正常填充。
  const visited = new Uint8Array(w * h);
  const matches = (px: number): boolean => {
    if (visited[px]) {
      return false;
    }
    const idx = px * 4;
    const dr = data[idx] - tr;
    const dg = data[idx + 1] - tg;
    const db = data[idx + 2] - tb;
    return dr >= -tol && dr <= tol && dg >= -tol && dg <= tol && db >= -tol && db <= tol;
  };
  const paint = (px: number): void => {
    visited[px] = 1;
    const idx = px * 4;
    data[idx] = fr;
    data[idx + 1] = fg;
    data[idx + 2] = fb;
    data[idx + 3] = 255;
  };
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    let lx = x;
    while (lx >= 0 && matches(y * w + lx)) {
      lx--;
    }
    lx++;
    let rx = x;
    while (rx < w && matches(y * w + rx)) {
      rx++;
    }
    rx--;
    // 这个位置入栈之后可能已经被别的扫描线涂过了
    if (lx > rx) {
      continue;
    }
    minX = Math.min(minX, lx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    let aboveMatch = false;
    let belowMatch = false;
    for (let i = lx; i <= rx; i++) {
      paint(y * w + i);
      if (y > 0) {
        const up = (y - 1) * w + i;
        const m = matches(up);
        if (m && !aboveMatch) {
          stack.push(i, y - 1);
          aboveMatch = true;
        } else if (!m) {
          aboveMatch = false;
        }
      }
      if (y < h - 1) {
        const down = (y + 1) * w + i;
        const m = matches(down);
        if (m && !belowMatch) {
          stack.push(i, y + 1);
          belowMatch = true;
        } else if (!m) {
          belowMatch = false;
        }
      }
    }
  }
  return { visited, minX, minY, maxX, maxY };
}

/**
 * Anti-alias the boundary of a freshly-filled region. For each unfilled pixel
 * adjacent to a filled pixel, alpha-blend the fill color in based on how close
 * the pixel is to the original target (background) color. This eliminates the
 * 1–2 px "halo" gap that scanlineFill leaves between fill and anti-aliased
 * pen strokes.
 *
 * 只看这次填充涂到的像素（visited），不按颜色判断：画布上别处的同色块不是这次填的，
 * 按颜色判断的话它们的外圈会被改写，每填一次就外扩一圈。范围也因此只有填充区域外扩 1px。
 *
 * Deterministic: depends only on RGBA inputs + integer arithmetic, so both
 * peers produce identical pixels without transmitting bitmaps.
 */
function antiAliasFillEdges(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visited: Uint8Array,
  tr: number,
  tg: number,
  tb: number,
  fr: number,
  fg: number,
  fb: number,
): void {
  // Pixels within this max-channel-distance of background get partial fill.
  // Beyond it (deep into stroke), no blending. Tuned to cover typical canvas
  // anti-aliasing halo without bleeding into stroke cores.
  const FALLOFF = 96;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = y * w + x;
      if (visited[px]) {
        continue;
      }
      const hasFilledNeighbor =
        (y > 0 && visited[px - w] === 1) ||
        (y < h - 1 && visited[px + w] === 1) ||
        (x > 0 && visited[px - 1] === 1) ||
        (x < w - 1 && visited[px + 1] === 1);
      if (!hasFilledNeighbor) {
        continue;
      }
      const idx = px * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const drv = r - tr;
      const dgv = g - tg;
      const dbv = b - tb;
      const adr = drv >= 0 ? drv : -drv;
      const adg = dgv >= 0 ? dgv : -dgv;
      const adb = dbv >= 0 ? dbv : -dbv;
      const dist = adr > adg ? (adr > adb ? adr : adb) : adg > adb ? adg : adb;
      let alpha = 1 - dist / FALLOFF;
      if (alpha <= 0) {
        continue;
      }
      if (alpha > 1) {
        alpha = 1;
      }
      const inv = 1 - alpha;
      data[idx] = r * inv + fr * alpha;
      data[idx + 1] = g * inv + fg * alpha;
      data[idx + 2] = b * inv + fb * alpha;
    }
  }
}

/**
 * 在 RGBA 缓冲区上做一次油漆桶：从 (sx, sy) 开始填充，再处理边缘。
 * 什么都没改时返回 null（比如种子已经是填充色），否则返回需要写回画布的矩形。
 */
export function floodFill(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  fr: number,
  fg: number,
  fb: number,
  tolerance: number,
): DirtyRect | null {
  const seed = (sy * w + sx) * 4;
  const tr = data[seed];
  const tg = data[seed + 1];
  const tb = data[seed + 2];
  if (tr === fr && tg === fg && tb === fb) {
    return null;
  }
  const region = scanlineFill(data, w, h, sx, sy, fr, fg, fb, tolerance);
  if (region.maxX < region.minX) {
    return null;
  }
  // 边缘处理的范围：填充区域外扩 1px
  const x0 = Math.max(region.minX - 1, 0);
  const y0 = Math.max(region.minY - 1, 0);
  const x1 = Math.min(region.maxX + 1, w - 1);
  const y1 = Math.min(region.maxY + 1, h - 1);
  antiAliasFillEdges(data, w, h, x0, y0, x1, y1, region.visited, tr, tg, tb, fr, fg, fb);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
