import { useRef, useCallback, useEffect } from "react";
import type { ClientMessage, S_Draw, SerializedStroke } from "../types/protocol";
import type { FillMode, ToolMode } from "../components/Toolbar";

type Point = { x: number; y: number };

/** Raw shape data emitted by the shape/arrow tool on mouseup (before commit). */
export interface DrawnShape {
  shape: "rect" | "ellipse" | "arrow" | "line";
  filled: boolean;
  /**
   * Raw pixel points in canvas-element space. Semantics:
   * - rect/ellipse: bounding box corners (order doesn't matter; consumers take min/max)
   * - arrow/line:   p0 = start, p1 = end (direction matters for arrow; irrelevant for line)
   */
  points: [Point, Point];
  /** Normalized (0..1) counterparts of the points above — used for send / persistence. */
  normalizedPoints: [Point, Point];
  color: string;
  lineWidth: number;
}

interface UseCanvasOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  color: string;
  lineWidth: number;
  tool: ToolMode;
  fillMode: FillMode;
  send: (msg: ClientMessage) => void;
  /** Mouseup after dragging a shape/arrow — hook does NOT commit; upstream handles it. */
  onShapeDrawn?: (shape: DrawnShape) => void;
  /** Fired when a local pen stroke finishes (commit path without editing-overlay). */
  onLocalPenEnd?: () => void;
  /**
   * Mouseup after drawing a selection rectangle. The hook has already extracted
   * the patch from the offscreen and whitened the src region; the callback
   * receives both the src rect (normalized) and the patch bitmap so upstream
   * can open the selection overlay.
   */
  onSelectionDrawn?: (
    srcNorm: { x: number; y: number; w: number; h: number },
    patch: HTMLCanvasElement,
  ) => void;
}

// Logical reference canvas width (paired conceptually with a 4:3 height of
// 600). lineWidth and fontSize values in the protocol are authored against
// this width — they're scaled by canvas.width / REF_WIDTH so a `lineWidth=4`
// stroke looks the same regardless of where the canvas is rendered.
const REF_WIDTH = 800;
const MIN_SCALE = 0.5;
// 上限提到 2.0：OFFSCREEN_WIDTH=1600 时 offscreen 渲染的天然倍率就是 2×，
// 旧值 1.5 会把 offscreen 的 lineWidth 钳成 0.75 倍，commit 后视觉上线突然变细。
// visible canvas 通常 533~1067px（4:3，533 是 CSS min），仍不触上限。
const MAX_SCALE = 2.0;

// Physical offscreen canvas dimensions (4:3). Larger than REF for finer
// anti-aliasing on curves: pen strokes are rendered at 2× linear resolution,
// then downsampled when blitted onto the visible canvas (which is typically
// smaller than OFFSCREEN_WIDTH). This dramatically reduces stair-step
// aliasing on curved fills/strokes vs. rendering directly at REF_*.
// Aspect ratio MUST match RATIO_W:RATIO_H in Canvas.tsx and REF_WIDTH:REF_HEIGHT.
const OFFSCREEN_WIDTH = 1600;
const OFFSCREEN_HEIGHT = 1200;

export function scaleLineWidth(baseWidth: number, canvasWidth: number): number {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, canvasWidth / REF_WIDTH));
  return baseWidth * scale;
}

/**
 * Geometry for a tapered arrow:
 *   tail (0-width point) → body base (bodyHalf × 2) → head base (headHalf × 2) → head tip
 * Shared by drawArrow and the SVG overlay preview so both renderings stay in sync.
 */
export function computeArrowGeometry(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  scaledLineWidth: number,
): {
  ux: number;
  uy: number;
  perpX: number;
  perpY: number;
  baseX: number;
  baseY: number;
  bodyHalf: number;
  headHalf: number;
} | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    return null;
  }
  const ux = dx / dist;
  const uy = dy / dist;
  const perpX = -uy;
  const perpY = ux;
  const lw = scaledLineWidth;
  const bodyHalf = lw;
  const headHalf = lw * 2;
  // Clamp head length so it never overruns the arrow itself on short drags.
  const headLen = Math.min(Math.max(lw * 4, 16), dist * 0.6);
  const baseX = x1 - ux * headLen;
  const baseY = y1 - uy * headLen;
  return { ux, uy, perpX, perpY, baseX, baseY, bodyHalf, headHalf };
}

/** Draw a tapered arrow (tail tip → widening body → arrow head) as a filled polygon. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  scaledLineWidth: number,
): void {
  const g = computeArrowGeometry(x0, y0, x1, y1, scaledLineWidth);
  if (!g) {
    return;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(g.baseX + g.perpX * g.bodyHalf, g.baseY + g.perpY * g.bodyHalf);
  ctx.lineTo(g.baseX + g.perpX * g.headHalf, g.baseY + g.perpY * g.headHalf);
  ctx.lineTo(x1, y1);
  ctx.lineTo(g.baseX - g.perpX * g.headHalf, g.baseY - g.perpY * g.headHalf);
  ctx.lineTo(g.baseX - g.perpX * g.bodyHalf, g.baseY - g.perpY * g.bodyHalf);
  ctx.closePath();
  ctx.fill();
}

/** Draw a straight stroke line (no arrow head) in pixel coords. */
function drawLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  scaledLineWidth: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.hypot(dx, dy) < 1) {
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = scaledLineWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Parse "#rrggbb" / "#rgb" / "#rrggbbaa" / "#rgba" to [r,g,b,a]. */
function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

/**
 * Scanline flood fill in-place on a RGBA pixel buffer. Replaces all pixels
 * connected to (sx, sy) whose color is within per-channel `tolerance` of the
 * seed color with (fr,fg,fb,255). O(N) worst case.
 *
 * Already-filled pixels naturally fail the `matches` test (they've been
 * rewritten to fill color, which is only equal to the target if we bailed
 * early at the caller), so no explicit visited set needed.
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
): void {
  const idx0 = (sy * w + sx) * 4;
  const tr = data[idx0];
  const tg = data[idx0 + 1];
  const tb = data[idx0 + 2];
  // Seed already matches fill → nothing to do (also prevents infinite loop).
  if (tr === fr && tg === fg && tb === fb) {
    return;
  }
  const tol = tolerance;
  const matches = (idx: number): boolean => {
    const dr = data[idx] - tr;
    const dg = data[idx + 1] - tg;
    const db = data[idx + 2] - tb;
    return dr >= -tol && dr <= tol && dg >= -tol && dg <= tol && db >= -tol && db <= tol;
  };
  const paint = (idx: number): void => {
    data[idx] = fr;
    data[idx + 1] = fg;
    data[idx + 2] = fb;
    data[idx + 3] = 255;
  };
  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    let lx = x;
    while (lx >= 0 && matches((y * w + lx) * 4)) {
      lx--;
    }
    lx++;
    let rx = x;
    while (rx < w && matches((y * w + rx) * 4)) {
      rx++;
    }
    rx--;
    let aboveMatch = false;
    let belowMatch = false;
    for (let i = lx; i <= rx; i++) {
      paint((y * w + i) * 4);
      if (y > 0) {
        const up = ((y - 1) * w + i) * 4;
        const m = matches(up);
        if (m && !aboveMatch) {
          stack.push(i, y - 1);
          aboveMatch = true;
        } else if (!m) {
          aboveMatch = false;
        }
      }
      if (y < h - 1) {
        const down = ((y + 1) * w + i) * 4;
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
}

/**
 * Anti-alias the boundary of a freshly-filled region. For each unfilled pixel
 * adjacent to a filled pixel, alpha-blend the fill color in based on how close
 * the pixel is to the original target (background) color. This eliminates the
 * 1–2 px "halo" gap that scanlineFill leaves between fill and anti-aliased
 * pen strokes.
 *
 * Deterministic: depends only on RGBA inputs + integer arithmetic, so both
 * peers produce identical pixels without transmitting bitmaps.
 */
function antiAliasFillEdges(
  data: Uint8ClampedArray,
  w: number,
  h: number,
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
  const snap = new Uint8ClampedArray(data);
  const rowStride = w * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (snap[idx] === fr && snap[idx + 1] === fg && snap[idx + 2] === fb) {
        continue;
      }
      let hasFilledNeighbor = false;
      if (y > 0) {
        const up = idx - rowStride;
        if (snap[up] === fr && snap[up + 1] === fg && snap[up + 2] === fb) {
          hasFilledNeighbor = true;
        }
      }
      if (!hasFilledNeighbor && y < h - 1) {
        const down = idx + rowStride;
        if (snap[down] === fr && snap[down + 1] === fg && snap[down + 2] === fb) {
          hasFilledNeighbor = true;
        }
      }
      if (!hasFilledNeighbor && x > 0) {
        const left = idx - 4;
        if (snap[left] === fr && snap[left + 1] === fg && snap[left + 2] === fb) {
          hasFilledNeighbor = true;
        }
      }
      if (!hasFilledNeighbor && x < w - 1) {
        const right = idx + 4;
        if (snap[right] === fr && snap[right + 1] === fg && snap[right + 2] === fb) {
          hasFilledNeighbor = true;
        }
      }
      if (!hasFilledNeighbor) {
        continue;
      }
      const drv = snap[idx] - tr;
      const dgv = snap[idx + 1] - tg;
      const dbv = snap[idx + 2] - tb;
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
      data[idx] = snap[idx] * inv + fr * alpha;
      data[idx + 1] = snap[idx + 1] * inv + fg * alpha;
      data[idx + 2] = snap[idx + 2] * inv + fb * alpha;
    }
  }
}

/** Flood-fill an offscreen-sized context at the given (pixel) seed point. */
function drawFillOnContext(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  sx: number,
  sy: number,
  fillColor: string,
  tolerance: number,
): void {
  if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) {
    return;
  }
  const [fr, fg, fb] = hexToRgba(fillColor);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const seedIdx = (sy * canvas.width + sx) * 4;
  const tr = img.data[seedIdx];
  const tg = img.data[seedIdx + 1];
  const tb = img.data[seedIdx + 2];
  if (tr === fr && tg === fg && tb === fb) {
    return;
  }
  scanlineFill(img.data, canvas.width, canvas.height, sx, sy, fr, fg, fb, tolerance);
  antiAliasFillEdges(img.data, canvas.width, canvas.height, tr, tg, tb, fr, fg, fb);
  ctx.putImageData(img, 0, 0);
}

/**
 * Apply a selection-move in three steps directly on the given canvas/ctx:
 *   1. copy src rect pixels to a temp canvas
 *   2. fill white over src rect
 *   3. draw temp canvas onto dst rect
 *
 * All coordinates are normalized 0..1; they're scaled to the canvas's pixel size.
 * Works even when src and dst overlap (temp canvas holds the original pixels).
 */
function performSelectionOnContext(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  srcNorm: { x: number; y: number; w: number; h: number },
  dstNorm: { x: number; y: number },
): void {
  const srcPxX = Math.round(srcNorm.x * canvas.width);
  const srcPxY = Math.round(srcNorm.y * canvas.height);
  const srcPxW = Math.round(srcNorm.w * canvas.width);
  const srcPxH = Math.round(srcNorm.h * canvas.height);
  const dstPxX = Math.round(dstNorm.x * canvas.width);
  const dstPxY = Math.round(dstNorm.y * canvas.height);
  if (srcPxW < 1 || srcPxH < 1) {
    return;
  }
  const patch = document.createElement("canvas");
  patch.width = srcPxW;
  patch.height = srcPxH;
  const pctx = patch.getContext("2d");
  if (!pctx) {
    return;
  }
  pctx.drawImage(canvas, srcPxX, srcPxY, srcPxW, srcPxH, 0, 0, srcPxW, srcPxH);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(srcPxX, srcPxY, srcPxW, srcPxH);
  ctx.drawImage(patch, 0, 0, srcPxW, srcPxH, dstPxX, dstPxY, srcPxW, srcPxH);
}

/** Render a single stroke onto an arbitrary context (visible canvas or offscreen). */
function renderStrokeToCtx(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  stroke: SerializedStroke,
): void {
  // Bucket-fill stroke: seed point (normalized) + color + tolerance
  if (stroke.fill && stroke.points.length > 0) {
    const sx = Math.floor(stroke.points[0].x * canvas.width);
    const sy = Math.floor(stroke.points[0].y * canvas.height);
    drawFillOnContext(ctx, canvas, sx, sy, stroke.color, stroke.fill.tolerance);
    return;
  }

  // Selection-move stroke: bitmap cut & paste on the current canvas.
  if (stroke.selection) {
    const sel = stroke.selection;
    performSelectionOnContext(
      ctx,
      canvas,
      { x: sel.srcX, y: sel.srcY, w: sel.w, h: sel.h },
      { x: sel.dstX, y: sel.dstY },
    );
    return;
  }

  // Shape strokes: rect / ellipse / arrow / line
  if (
    stroke.shape === "rect" ||
    stroke.shape === "ellipse" ||
    stroke.shape === "arrow" ||
    stroke.shape === "line"
  ) {
    if (stroke.points.length < 2) {
      return;
    }
    const [p0, p1] = stroke.points;
    const lw = scaleLineWidth(stroke.lineWidth, canvas.width);

    if (stroke.shape === "arrow") {
      drawArrow(
        ctx,
        p0.x * canvas.width,
        p0.y * canvas.height,
        p1.x * canvas.width,
        p1.y * canvas.height,
        stroke.color,
        lw,
      );
      return;
    }

    if (stroke.shape === "line") {
      drawLine(
        ctx,
        p0.x * canvas.width,
        p0.y * canvas.height,
        p1.x * canvas.width,
        p1.y * canvas.height,
        stroke.color,
        lw,
      );
      return;
    }

    // rect/ellipse — bbox corners, order doesn't matter
    const x = Math.min(p0.x, p1.x) * canvas.width;
    const y = Math.min(p0.y, p1.y) * canvas.height;
    const w = Math.abs(p1.x - p0.x) * canvas.width;
    const h = Math.abs(p1.y - p0.y) * canvas.height;
    if (w === 0 || h === 0) {
      return;
    }
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (stroke.shape === "rect") {
      if (stroke.filled) {
        ctx.fillRect(x, y, w, h);
      } else {
        ctx.strokeRect(x, y, w, h);
      }
    } else {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (stroke.filled) {
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }
    return;
  }

  // Text stroke
  if (stroke.text) {
    if (stroke.points.length === 0) {
      return;
    }
    const fontSize = (stroke.fontSize || 24) * (canvas.width / REF_WIDTH);
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = stroke.color;
    ctx.textBaseline = "top";
    const px = stroke.points[0].x * canvas.width;
    const py = stroke.points[0].y * canvas.height;
    const lineHeight = fontSize * 1.2;
    const lines = stroke.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], px, py + i * lineHeight);
    }
    return;
  }

  // Freehand pen stroke
  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = scaleLineWidth(stroke.lineWidth, canvas.width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < stroke.points.length; i++) {
    const px = stroke.points[i].x * canvas.width;
    const py = stroke.points[i].y * canvas.height;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}

/** Draw a live preview of an in-progress shape/arrow/line onto the visible context. */
function drawShapePreview(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  start: Point,
  end: Point,
  color: string,
  lineWidth: number,
  shape: "rect" | "ellipse" | "arrow" | "line",
  filled: boolean,
): void {
  const lw = scaleLineWidth(lineWidth, canvas.width);

  if (shape === "arrow") {
    drawArrow(
      ctx,
      start.x * canvas.width,
      start.y * canvas.height,
      end.x * canvas.width,
      end.y * canvas.height,
      color,
      lw,
    );
    return;
  }

  if (shape === "line") {
    drawLine(
      ctx,
      start.x * canvas.width,
      start.y * canvas.height,
      end.x * canvas.width,
      end.y * canvas.height,
      color,
      lw,
    );
    return;
  }

  const x = Math.min(start.x, end.x) * canvas.width;
  const y = Math.min(start.y, end.y) * canvas.height;
  const w = Math.abs(end.x - start.x) * canvas.width;
  const h = Math.abs(end.y - start.y) * canvas.height;
  if (w === 0 || h === 0) {
    return;
  }
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (shape === "rect") {
    if (filled) {
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.strokeRect(x, y, w, h);
    }
  } else {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (filled) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
}

export function useCanvas({
  canvasRef,
  isDrawer,
  color,
  lineWidth,
  tool,
  fillMode,
  send,
  onShapeDrawn,
  onLocalPenEnd,
  onSelectionDrawn,
}: UseCanvasOptions) {
  const isDrawingRef = useRef(false);
  const strokesRef = useRef<SerializedStroke[]>([]);
  const currentStrokeRef = useRef<{
    points: Point[];
    color: string;
    lineWidth: number;
  } | null>(null);
  const pendingPointsRef = useRef<Point[]>([]);
  const rafIdRef = useRef<number | null>(null);

  // Offscreen canvas — single source of truth for committed strokes.
  // Initialized with an opaque white background so the bucket tool has
  // real pixels to read (transparent pixels would make every fill degenerate).
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  if (offscreenRef.current === null && typeof document !== "undefined") {
    const off = document.createElement("canvas");
    off.width = OFFSCREEN_WIDTH;
    off.height = OFFSCREEN_HEIGHT;
    const offCtx = off.getContext("2d");
    if (offCtx) {
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(0, 0, OFFSCREEN_WIDTH, OFFSCREEN_HEIGHT);
    }
    offscreenRef.current = off;
  }

  const commitToOffscreen = useCallback((stroke: SerializedStroke) => {
    const offs = offscreenRef.current;
    if (!offs) {
      return;
    }
    const offCtx = offs.getContext("2d");
    if (!offCtx) {
      return;
    }
    renderStrokeToCtx(offCtx, offs, stroke);
  }, []);

  const syncVisibleFromOffscreen = useCallback(() => {
    const canvas = canvasRef.current;
    const offs = offscreenRef.current;
    if (!canvas || !offs) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offs, 0, 0, canvas.width, canvas.height);
  }, [canvasRef]);

  const rebuildOffscreen = useCallback((strokes: SerializedStroke[]) => {
    const offs = offscreenRef.current;
    if (!offs) {
      return;
    }
    const offCtx = offs.getContext("2d");
    if (!offCtx) {
      return;
    }
    offCtx.fillStyle = "#ffffff";
    offCtx.fillRect(0, 0, offs.width, offs.height);
    for (const stroke of strokes) {
      renderStrokeToCtx(offCtx, offs, stroke);
    }
  }, []);

  /**
   * Drawer-side: open a selection. Extracts a patch from the offscreen src rect,
   * whitens src on the offscreen, mirrors to visible, and returns the patch
   * canvas (upstream holds it in React state for the overlay preview). Nothing
   * is pushed to strokes yet — that happens at commit time.
   */
  const beginSelection = useCallback(
    (srcNorm: { x: number; y: number; w: number; h: number }): HTMLCanvasElement | null => {
      const offs = offscreenRef.current;
      if (!offs) {
        return null;
      }
      const offCtx = offs.getContext("2d");
      if (!offCtx) {
        return null;
      }
      const srcPxX = Math.round(srcNorm.x * offs.width);
      const srcPxY = Math.round(srcNorm.y * offs.height);
      const srcPxW = Math.round(srcNorm.w * offs.width);
      const srcPxH = Math.round(srcNorm.h * offs.height);
      if (srcPxW < 1 || srcPxH < 1) {
        return null;
      }
      const patch = document.createElement("canvas");
      patch.width = srcPxW;
      patch.height = srcPxH;
      const pctx = patch.getContext("2d");
      if (!pctx) {
        return null;
      }
      pctx.drawImage(offs, srcPxX, srcPxY, srcPxW, srcPxH, 0, 0, srcPxW, srcPxH);
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(srcPxX, srcPxY, srcPxW, srcPxH);
      syncVisibleFromOffscreen();
      return patch;
    },
    [syncVisibleFromOffscreen],
  );

  /**
   * Drawer-side: commit a selection in progress. Offscreen already has src
   * whitened (from beginSelection), so we just paste the patch at dst.
   */
  const commitLocalSelection = useCallback(
    (
      patch: HTMLCanvasElement,
      srcNorm: { x: number; y: number; w: number; h: number },
      dstNorm: { x: number; y: number },
    ) => {
      const offs = offscreenRef.current;
      if (!offs) {
        return;
      }
      const offCtx = offs.getContext("2d");
      if (!offCtx) {
        return;
      }
      const srcPxW = Math.round(srcNorm.w * offs.width);
      const srcPxH = Math.round(srcNorm.h * offs.height);
      const dstPxX = Math.round(dstNorm.x * offs.width);
      const dstPxY = Math.round(dstNorm.y * offs.height);
      offCtx.drawImage(patch, 0, 0, patch.width, patch.height, dstPxX, dstPxY, srcPxW, srcPxH);
      syncVisibleFromOffscreen();
      const stroke: SerializedStroke = {
        points: [],
        color: "",
        lineWidth: 0,
        selection: {
          srcX: srcNorm.x,
          srcY: srcNorm.y,
          w: srcNorm.w,
          h: srcNorm.h,
          dstX: dstNorm.x,
          dstY: dstNorm.y,
        },
      };
      strokesRef.current.push(stroke);
    },
    [syncVisibleFromOffscreen],
  );

  /**
   * Drawer-side: abort an in-progress selection. Restores the offscreen by
   * rebuilding from the committed strokes (which don't include the pending
   * selection). Called when the user switches away or clears without commit.
   */
  const cancelLocalSelection = useCallback(() => {
    rebuildOffscreen(strokesRef.current);
    syncVisibleFromOffscreen();
  }, [rebuildOffscreen, syncVisibleFromOffscreen]);

  /**
   * Apply a selection-move stroke from a remote S_Selection message. Runs the
   * full three-step cut-and-paste on the offscreen, mirrors to visible, and
   * records the stroke.
   */
  const addSelection = useCallback(
    (
      srcNorm: { x: number; y: number; w: number; h: number },
      dstNorm: { x: number; y: number },
    ) => {
      const offs = offscreenRef.current;
      if (!offs) {
        return;
      }
      const offCtx = offs.getContext("2d");
      if (!offCtx) {
        return;
      }
      performSelectionOnContext(offCtx, offs, srcNorm, dstNorm);
      syncVisibleFromOffscreen();
      const stroke: SerializedStroke = {
        points: [],
        color: "",
        lineWidth: 0,
        selection: {
          srcX: srcNorm.x,
          srcY: srcNorm.y,
          w: srcNorm.w,
          h: srcNorm.h,
          dstX: dstNorm.x,
          dstY: dstNorm.y,
        },
      };
      strokesRef.current.push(stroke);
    },
    [syncVisibleFromOffscreen],
  );

  /**
   * Apply a bucket-fill stroke (from local tool click OR a remote S_Fill message).
   * Runs flood fill on the offscreen, mirrors to the visible canvas, and records
   * the stroke so replay / undo are correct. Does NOT send a wire message — the
   * caller is responsible for that when appropriate.
   */
  const addFill = useCallback(
    (normX: number, normY: number, fillColor: string, tolerance: number) => {
      const offs = offscreenRef.current;
      if (!offs) {
        return;
      }
      const offCtx = offs.getContext("2d");
      if (!offCtx) {
        return;
      }
      const sx = Math.floor(normX * offs.width);
      const sy = Math.floor(normY * offs.height);
      drawFillOnContext(offCtx, offs, sx, sy, fillColor, tolerance);
      syncVisibleFromOffscreen();
      const stroke: SerializedStroke = {
        points: [{ x: normX, y: normY }],
        color: fillColor,
        lineWidth: 0,
        fill: { tolerance },
      };
      strokesRef.current.push(stroke);
    },
    [syncVisibleFromOffscreen],
  );

  // Canvas pointer events — routed by tool
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    if (!isDrawer) {
      return;
    }
    if (tool === "text") {
      // Text tool uses a DOM overlay (handled in Canvas.tsx), not canvas events.
      return;
    }

    const normalize = (e: MouseEvent): Point => ({
      x: e.offsetX / canvas.width,
      y: e.offsetY / canvas.height,
    });

    // ========== Pen tool ==========
    if (tool === "pen") {
      // 关键：在 visible canvas 上重绘当前 in-progress stroke。
      // 配合 syncVisibleFromOffscreen 使用，每帧 visible = offscreen + 单次绘制的当前 stroke。
      // 旧实现是 ctx.beginPath() once + 每次 mousemove 调 ctx.lineTo + ctx.stroke()，
      // 这会让累积路径反复 stroke，alpha < 1 时透明度叠加成不透明 → 修复。
      const drawInProgressStroke = () => {
        const stroke = currentStrokeRef.current;
        if (!stroke || stroke.points.length === 0) {
          return;
        }
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = scaleLineWidth(stroke.lineWidth, canvas.width);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < stroke.points.length; i++) {
          const px = stroke.points[i].x * canvas.width;
          const py = stroke.points[i].y * canvas.height;
          if (i === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      };

      const flushPendingMove = () => {
        rafIdRef.current = null;
        const points = pendingPointsRef.current;
        if (points.length === 0) {
          return;
        }
        pendingPointsRef.current = [];
        const last = points[points.length - 1];
        send({
          type: "draw",
          action: "move",
          x: last.x,
          y: last.y,
          color,
          lineWidth,
          points,
        });
        // 视觉重绘：每 RAF 帧一次（最高 60Hz），避免 mousemove 高频触发的浪费
        syncVisibleFromOffscreen();
        drawInProgressStroke();
      };

      const scheduleFlush = () => {
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flushPendingMove);
        }
      };

      const onMouseDown = (e: MouseEvent) => {
        isDrawingRef.current = true;
        const { x, y } = normalize(e);
        currentStrokeRef.current = { points: [{ x, y }], color, lineWidth };
        send({ type: "draw", action: "start", x, y, color, lineWidth });
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!isDrawingRef.current) {
          return;
        }
        const { x, y } = normalize(e);
        currentStrokeRef.current?.points.push({ x, y });
        pendingPointsRef.current.push({ x, y });
        scheduleFlush();
      };

      const onMouseUp = (e: MouseEvent) => {
        if (!isDrawingRef.current) {
          return;
        }
        isDrawingRef.current = false;
        const { x, y } = normalize(e);
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push({ x, y });
          const finalized = currentStrokeRef.current as SerializedStroke;
          strokesRef.current.push(finalized);
          commitToOffscreen(finalized);
          syncVisibleFromOffscreen();
          currentStrokeRef.current = null;
        }
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        flushPendingMove();
        send({ type: "draw", action: "end", x, y, color, lineWidth });
        onLocalPenEnd?.();
      };

      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseup", onMouseUp);
      canvas.addEventListener("mouseleave", onMouseUp);

      return () => {
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("mouseup", onMouseUp);
        canvas.removeEventListener("mouseleave", onMouseUp);
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        pendingPointsRef.current = [];
      };
    }

    // ========== Bucket (flood fill) tool ==========
    // One click = one fill. No drag, no editing overlay.
    if (tool === "bucket") {
      const FILL_TOLERANCE = 32;
      const onClick = (e: MouseEvent) => {
        const normX = e.offsetX / canvas.width;
        const normY = e.offsetY / canvas.height;
        addFill(normX, normY, color, FILL_TOLERANCE);
        send({ type: "fill", x: normX, y: normY, color, tolerance: FILL_TOLERANCE });
        onLocalPenEnd?.();
      };
      canvas.addEventListener("click", onClick);
      return () => canvas.removeEventListener("click", onClick);
    }

    // ========== Selection (marquee) tool ==========
    // mousedown + drag → dashed rectangle preview. mouseup (with non-trivial
    // size) emits srcNorm upstream; upstream opens the selection overlay.
    if (tool === "selection") {
      const MIN_SIZE_PX = 20;
      let startPx: Point | null = null;
      const onDown = (e: MouseEvent) => {
        startPx = { x: e.offsetX, y: e.offsetY };
      };
      const onMove = (e: MouseEvent) => {
        if (!startPx) {
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const offs = offscreenRef.current;
        if (offs) {
          ctx.drawImage(offs, 0, 0, canvas.width, canvas.height);
        }
        ctx.strokeStyle = "#818cf8";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(startPx.x, startPx.y, e.offsetX - startPx.x, e.offsetY - startPx.y);
        ctx.setLineDash([]);
      };
      const onUp = (e: MouseEvent) => {
        if (!startPx) {
          return;
        }
        const start = startPx;
        startPx = null;
        const bx = Math.min(start.x, e.offsetX);
        const by = Math.min(start.y, e.offsetY);
        const bw = Math.abs(e.offsetX - start.x);
        const bh = Math.abs(e.offsetY - start.y);
        if (bw < MIN_SIZE_PX || bh < MIN_SIZE_PX) {
          // Clear any preview stroke off the visible canvas and abort.
          syncVisibleFromOffscreen();
          return;
        }
        const srcNorm = {
          x: bx / canvas.width,
          y: by / canvas.height,
          w: bw / canvas.width,
          h: bh / canvas.height,
        };
        // beginSelection extracts the patch, whitens src on the offscreen, and
        // syncs visible — no need to explicitly clear the preview stroke.
        const patch = beginSelection(srcNorm);
        if (patch) {
          onSelectionDrawn?.(srcNorm, patch);
        }
      };
      const onLeave = () => {
        if (!startPx) {
          return;
        }
        startPx = null;
        syncVisibleFromOffscreen();
      };
      canvas.addEventListener("mousedown", onDown);
      canvas.addEventListener("mousemove", onMove);
      canvas.addEventListener("mouseup", onUp);
      canvas.addEventListener("mouseleave", onLeave);
      return () => {
        canvas.removeEventListener("mousedown", onDown);
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mouseup", onUp);
        canvas.removeEventListener("mouseleave", onLeave);
      };
    }

    // ========== Shape / arrow tools ==========
    // mousedown: record start
    // mousemove: repaint visible (clear + blit offscreen + preview), never writes to offscreen
    // mouseup: emit DrawnShape — upstream holds it in editingShape state
    const filled = fillMode === "fill";
    const shapeKind: "rect" | "ellipse" | "arrow" | "line" = tool;
    let shapeStart: Point | null = null;

    const onShapeDown = (e: MouseEvent) => {
      shapeStart = normalize(e);
    };

    // 把鼠标坐标钳到画布范围内：mouseleave 时 offsetX/Y 会超出边界，
    // 否则形状会画到 canvas 之外（normalized > 1 或 < 0）。
    const clampToCanvas = (e: MouseEvent): Point => ({
      x: Math.max(0, Math.min(canvas.width, e.offsetX)) / canvas.width,
      y: Math.max(0, Math.min(canvas.height, e.offsetY)) / canvas.height,
    });

    const onShapeMove = (e: MouseEvent) => {
      if (!shapeStart) {
        return;
      }
      const current = clampToCanvas(e);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const offs = offscreenRef.current;
      if (offs) {
        ctx.drawImage(offs, 0, 0, canvas.width, canvas.height);
      }
      drawShapePreview(ctx, canvas, shapeStart, current, color, lineWidth, shapeKind, filled);
    };

    // mouseup 与 mouseleave 都走这里——参考 pen 的做法：鼠标离开边界 =
    // 在边界处提交形状（坐标已被 clampToCanvas 钳到画布内），而不是清空预览。
    const onShapeUp = (e: MouseEvent) => {
      if (!shapeStart) {
        return;
      }
      const start = shapeStart;
      const end = clampToCanvas(e);
      shapeStart = null;
      // Wipe the preview — editing overlay replaces it.
      syncVisibleFromOffscreen();
      // Reject tiny drags (treat as a missclick)
      const totalDist = Math.hypot(end.x - start.x, end.y - start.y);
      if (totalDist < 0.005) {
        return;
      }
      onShapeDrawn?.({
        shape: shapeKind,
        filled,
        normalizedPoints: [
          { x: start.x, y: start.y },
          { x: end.x, y: end.y },
        ],
        points: [
          { x: start.x * canvas.width, y: start.y * canvas.height },
          { x: end.x * canvas.width, y: end.y * canvas.height },
        ],
        color,
        lineWidth,
      });
    };

    canvas.addEventListener("mousedown", onShapeDown);
    canvas.addEventListener("mousemove", onShapeMove);
    canvas.addEventListener("mouseup", onShapeUp);
    canvas.addEventListener("mouseleave", onShapeUp);

    return () => {
      canvas.removeEventListener("mousedown", onShapeDown);
      canvas.removeEventListener("mousemove", onShapeMove);
      canvas.removeEventListener("mouseup", onShapeUp);
      canvas.removeEventListener("mouseleave", onShapeUp);
      if (shapeStart !== null) {
        syncVisibleFromOffscreen();
      }
    };
  }, [
    canvasRef,
    isDrawer,
    color,
    lineWidth,
    tool,
    fillMode,
    send,
    commitToOffscreen,
    syncVisibleFromOffscreen,
    onShapeDrawn,
    onLocalPenEnd,
    onSelectionDrawn,
    addFill,
    beginSelection,
  ]);

  // Replay a remote draw event (pen). 与本地 pen 同样的 alpha 修复：
  // 不再增量 stroke 累积路径，而是每帧 sync offscreen + 单次重绘当前 in-progress stroke。
  const replayDraw = useCallback(
    (msg: S_Draw) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const drawInProgressStroke = () => {
        const stroke = currentStrokeRef.current;
        if (!stroke || stroke.points.length === 0) {
          return;
        }
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = scaleLineWidth(stroke.lineWidth, canvas.width);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < stroke.points.length; i++) {
          const px = stroke.points[i].x * canvas.width;
          const py = stroke.points[i].y * canvas.height;
          if (i === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      };

      if (msg.action === "start") {
        currentStrokeRef.current = {
          points: [{ x: msg.x, y: msg.y }],
          color: msg.color,
          lineWidth: msg.lineWidth,
        };
      } else if (msg.action === "move") {
        const points = msg.points ?? [{ x: msg.x, y: msg.y }];
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push(...points);
        }
        syncVisibleFromOffscreen();
        drawInProgressStroke();
      } else if (msg.action === "end") {
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push({ x: msg.x, y: msg.y });
          const finalized = currentStrokeRef.current as SerializedStroke;
          strokesRef.current.push(finalized);
          commitToOffscreen(finalized);
          syncVisibleFromOffscreen();
          currentStrokeRef.current = null;
        }
      }
    },
    [canvasRef, commitToOffscreen, syncVisibleFromOffscreen],
  );

  const replayAll = useCallback(
    (strokes: SerializedStroke[]) => {
      strokesRef.current = strokes;
      rebuildOffscreen(strokes);
      syncVisibleFromOffscreen();
    },
    [rebuildOffscreen, syncVisibleFromOffscreen],
  );

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    const offs = offscreenRef.current;
    if (offs) {
      const offCtx = offs.getContext("2d");
      if (offCtx) {
        offCtx.fillStyle = "#ffffff";
        offCtx.fillRect(0, 0, offs.width, offs.height);
      }
    }
    strokesRef.current = [];
  }, [canvasRef]);

  // Add a text stroke from remote (commit to offscreen + mirror to visible)
  const addTextStroke = useCallback(
    (text: string, x: number, y: number, textColor: string, fontSize: number) => {
      const stroke: SerializedStroke = {
        points: [{ x, y }],
        color: textColor,
        lineWidth: 0,
        text,
        fontSize,
      };
      commitToOffscreen(stroke);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          renderStrokeToCtx(ctx, canvas, stroke);
        }
      }
      strokesRef.current.push(stroke);
    },
    [canvasRef, commitToOffscreen],
  );

  /** Add a shape/arrow/line stroke (from local commit OR remote). Accepts normalized points. */
  const addShape = useCallback(
    (
      p0: Point,
      p1: Point,
      shapeColor: string,
      shapeLineWidth: number,
      shape: "rect" | "ellipse" | "arrow" | "line",
      filled: boolean,
    ) => {
      const stroke: SerializedStroke = {
        points: [p0, p1],
        color: shapeColor,
        lineWidth: shapeLineWidth,
        shape,
        filled,
      };
      commitToOffscreen(stroke);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          renderStrokeToCtx(ctx, canvas, stroke);
        }
      }
      strokesRef.current.push(stroke);
    },
    [canvasRef, commitToOffscreen],
  );

  return {
    replayDraw,
    replayAll,
    clearCanvas,
    addTextStroke,
    addShape,
    addFill,
    addSelection,
    beginSelection,
    commitLocalSelection,
    cancelLocalSelection,
    syncVisibleFromOffscreen,
    strokesRef,
  };
}
