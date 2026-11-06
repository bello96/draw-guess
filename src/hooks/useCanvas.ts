import { useRef, useCallback, useEffect } from "react";
import type {
  BrushType,
  ClientMessage,
  GamePhase,
  S_Draw,
  SerializedStroke,
  TextColorRange,
} from "../types/protocol";
import { MAX_STROKE_PATH, MAX_STROKE_POINTS } from "../types/protocol";
import type { FillMode, ToolMode } from "../components/Toolbar";
import { lineSegments } from "../utils/textColor";
import {
  HAND_FONT_FAMILY,
  kickHandFontLoad,
  loadHandFonts,
  loadHandFontStylesheet,
} from "../utils/handFont";
import { floodFill } from "../utils/floodFill";
import { isIncrementalBrush, renderBrushSegments, renderBrushStroke } from "../utils/brushes";
import { StrokeReplay, type ReplaySurface } from "../utils/strokeReplay";

type Point = { x: number; y: number };

/** Raw shape data emitted by the shape/arrow tool on mouseup (before commit). */
export interface DrawnShape {
  shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
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
  /** Pen 笔型（仅对 pen 工具生效；其他工具忽略）。默认 "pen"。 */
  brushType: BrushType;
  send: (msg: ClientMessage) => void;
  /** Mouseup after dragging a shape/arrow — hook does NOT commit; upstream handles it. */
  onShapeDrawn?: (shape: DrawnShape) => void;
  /** Fired when a local pen stroke finishes (commit path without editing-overlay). */
  onLocalPenEnd?: () => void;
  /** Current game phase — used to lock canvas input when not in drawing phase. */
  phase: GamePhase;
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
  /**
   * Selection tool, single click: all pickable strokes under the cursor,
   * topmost first (empty array = clicked blank space). Upstream owns the
   * picked state and the click-again-to-cycle-down behavior.
   */
  onStrokePicked?: (hitIndices: number[]) => void;
  /** Selection tool, idle hover: topmost pickable stroke under cursor (null = none). */
  onStrokeHovered?: (index: number | null) => void;
}

// Logical reference canvas width (paired conceptually with a 5:3 height of
// 480). lineWidth and fontSize values in the protocol are authored against
// this width — they're scaled by canvas.width / REF_WIDTH so a `lineWidth=4`
// stroke looks the same regardless of where the canvas is rendered.
const REF_WIDTH = 800;
const MIN_SCALE = 0.5;
// 上限提到 2.0：OFFSCREEN_WIDTH=1600 时 offscreen 渲染的天然倍率就是 2×，
// 旧值 1.5 会把 offscreen 的 lineWidth 钳成 0.75 倍，commit 后视觉上线突然变细。
// visible canvas 通常 667~1067px（5:3，667 是 CSS min），仍不触上限。
const MAX_SCALE = 2.0;

// Physical offscreen canvas dimensions (5:3). Larger than REF for finer
// anti-aliasing on curves: pen strokes are rendered at 2× linear resolution,
// then downsampled when blitted onto the visible canvas (which is typically
// smaller than OFFSCREEN_WIDTH). This dramatically reduces stair-step
// aliasing on curved fills/strokes vs. rendering directly at REF_*.
// Aspect ratio MUST match RATIO_W:RATIO_H in Canvas.tsx and REF_WIDTH:REF_HEIGHT.
const OFFSCREEN_WIDTH = 1600;
const OFFSCREEN_HEIGHT = 960;

// 重放每一片最多占用主线程多久。超过就让出去，下一片接着画。
const REPLAY_SLICE_MS = 12;

// 让出主线程。不用定时器：后台标签页的定时器会被限流到每秒一次，重放要很久才能追上。
function yieldToMain(fn: () => void): void {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => {
    port1.close();
    fn();
  };
  port2.postMessage(null);
}

function createOffscreenCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = OFFSCREEN_WIDTH;
  canvas.height = OFFSCREEN_HEIGHT;
  return canvas;
}

// 整张覆盖，和当前画布内容、合成状态都无关，恢复出来的像素和快照完全相同。
function copyCanvasInto(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement): void {
  ctx.save();
  ctx.globalCompositeOperation = "copy";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

function offscreenSurface(
  offs: HTMLCanvasElement,
  offCtx: CanvasRenderingContext2D,
): ReplaySurface<HTMLCanvasElement> {
  return {
    snapshot(reuse) {
      const snapshot = reuse ?? createOffscreenCanvas();
      const ctx = snapshot.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        copyCanvasInto(ctx, offs);
      }
      return snapshot;
    },
    restore(snapshot) {
      if (snapshot) {
        copyCanvasInto(offCtx, snapshot);
        return;
      }
      offCtx.save();
      offCtx.globalCompositeOperation = "source-over";
      offCtx.globalAlpha = 1;
      offCtx.filter = "none";
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(0, 0, offs.width, offs.height);
      offCtx.restore();
    },
    discard(snapshot) {
      // 释放像素存储，不用等 GC
      snapshot.width = 0;
      snapshot.height = 0;
    },
  };
}

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

/**
 * Build the canvas path of an isoceles triangle (point-up) inscribed in
 * (x, y, w, h). Caller chooses fill vs stroke. Closed path.
 */
function pathTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/**
 * Five-pointed star inscribed in (x, y, w, h). 五角星 5 个外角顶点的实际范围：
 *   y: [-1, +0.809]  （最低两个外角的 sin(54°) ≈ 0.809，不是 1）
 *   x: [-0.951, +0.951]（cos(18°) ≈ 0.951）
 * 旧实现 rxO=w/2, ryO=h/2 让外圆覆盖 bbox，但 5 个顶点不一定碰到圆边 → bbox
 * 底部和侧边出现可见留白。修正：把 rxO / ryO 缩到正好让顶点贴 bbox 边。
 */
const STAR_INNER_RATIO = 0.381966; // sin(18°)/sin(54°)
const STAR_TOP_TO_BOTTOM = 1 + Math.sin((54 * Math.PI) / 180); // ≈ 1.809
const STAR_LEFT_TO_RIGHT = 2 * Math.cos((18 * Math.PI) / 180); // ≈ 1.902
function pathStar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const cx = x + w / 2;
  const ryO = h / STAR_TOP_TO_BOTTOM;
  const cy = y + ryO; // 让顶角 (-90°) 落在 y=0
  const rxO = w / STAR_LEFT_TO_RIGHT;
  const rxI = rxO * STAR_INNER_RATIO;
  const ryI = ryO * STAR_INNER_RATIO;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const isOuter = i % 2 === 0;
    const rx = isOuter ? rxO : rxI;
    const ry = isOuter ? ryO : ryI;
    const px = cx + rx * Math.cos(a);
    const py = cy + ry * Math.sin(a);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
}

/**
 * Heart inscribed in (x, y, w, h). 6 cubic beziers, 起点 = 底部尖端，顺时针绕。
 * 几何参数参考 Material Icons / Twemoji ❤️ 经典圆润心形。
 *
 * 关键关键点：
 * - 凹槽 notch 在 (cx, 0.114h) —— 故意做得很浅，让顶部凹槽视觉柔和
 * - 左/右瓣顶尖在 (0.275w, 0) / (0.725w, 0) —— 收拢到中心一些，
 *   两瓣不会在顶部展成水平长条
 * - 段 2/3/4/5 的相邻切线都通过控制点保持 C1 平滑，瓣顶是圆弧顶点而非平台
 * - 底部 (cx, h) 两侧控制点 (0.17w/0.83w, 0.673h)，斜向 45°，尖端不针状
 */
function pathHeart(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const cx = x + w / 2;
  ctx.beginPath();
  ctx.moveTo(cx, y + h);
  // 1. bottom → leftWidest (0, 0.30h)
  ctx.bezierCurveTo(x + w * 0.17, y + h * 0.673, x, y + h * 0.506, x, y + h * 0.3);
  // 2. leftWidest → leftPeak (0.275w, 0)
  ctx.bezierCurveTo(x, y + h * 0.132, x + w * 0.121, y, x + w * 0.275, y);
  // 3. leftPeak → notch (cx, 0.114h)
  ctx.bezierCurveTo(x + w * 0.362, y, x + w * 0.446, y + h * 0.044, cx, y + h * 0.114);
  // 4. notch → rightPeak (0.725w, 0)
  ctx.bezierCurveTo(x + w * 0.554, y + h * 0.044, x + w * 0.638, y, x + w * 0.725, y);
  // 5. rightPeak → rightWidest (w, 0.30h)
  ctx.bezierCurveTo(x + w * 0.879, y, x + w, y + h * 0.132, x + w, y + h * 0.3);
  // 6. rightWidest → bottom
  ctx.bezierCurveTo(x + w, y + h * 0.506, x + w * 0.83, y + h * 0.673, cx, y + h);
  ctx.closePath();
}

/**
 * SVG `d=` strings for the same three shapes, normalized to (0, 0, w, h).
 * Consumed by the editing-overlay SVG preview in Canvas.tsx so the on-canvas
 * render and the overlay preview stay pixel-identical (modulo aliasing).
 */
export function svgPathTriangle(w: number, h: number): string {
  return `M ${w / 2} 0 L 0 ${h} L ${w} ${h} Z`;
}

export function svgPathStar(w: number, h: number): string {
  const cx = w / 2;
  const ryO = h / STAR_TOP_TO_BOTTOM;
  const cy = ryO;
  const rxO = w / STAR_LEFT_TO_RIGHT;
  const rxI = rxO * STAR_INNER_RATIO;
  const ryI = ryO * STAR_INNER_RATIO;
  const parts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const isOuter = i % 2 === 0;
    const rx = isOuter ? rxO : rxI;
    const ry = isOuter ? ryO : ryI;
    const px = (cx + rx * Math.cos(a)).toFixed(2);
    const py = (cy + ry * Math.sin(a)).toFixed(2);
    parts.push((i === 0 ? "M" : "L") + " " + px + " " + py);
  }
  parts.push("Z");
  return parts.join(" ");
}

export function svgPathHeart(w: number, h: number): string {
  const cx = w / 2;
  return [
    `M ${cx} ${h}`,
    `C ${w * 0.17} ${h * 0.673}, 0 ${h * 0.506}, 0 ${h * 0.3}`,
    `C 0 ${h * 0.132}, ${w * 0.121} 0, ${w * 0.275} 0`,
    `C ${w * 0.362} 0, ${w * 0.446} ${h * 0.044}, ${cx} ${h * 0.114}`,
    `C ${w * 0.554} ${h * 0.044}, ${w * 0.638} 0, ${w * 0.725} 0`,
    `C ${w * 0.879} 0, ${w} ${h * 0.132}, ${w} ${h * 0.3}`,
    `C ${w} ${h * 0.506}, ${w * 0.83} ${h * 0.673}, ${cx} ${h}`,
    "Z",
  ].join(" ");
}

// ---------- Pick (select-to-delete) helpers ----------

// Shared scratch 2D context for text measurement and Path2D containment tests.
let scratchCtx: CanvasRenderingContext2D | null = null;
function getScratchCtx(): CanvasRenderingContext2D | null {
  if (scratchCtx === null && typeof document !== "undefined") {
    scratchCtx = document.createElement("canvas").getContext("2d");
  }
  return scratchCtx;
}

/**
 * Pixel-space bounding box of a committed stroke on the given canvas.
 * Returns null for stroke kinds that aren't pickable (pen / fill / selection).
 */
export function getStrokeBBoxPx(
  stroke: SerializedStroke,
  canvas: HTMLCanvasElement,
): { x: number; y: number; w: number; h: number } | null {
  if (stroke.fill || stroke.selection) {
    return null;
  }
  if (stroke.shape) {
    if (stroke.points.length < 2) {
      return null;
    }
    const [p0, p1] = stroke.points;
    return {
      x: Math.min(p0.x, p1.x) * canvas.width,
      y: Math.min(p0.y, p1.y) * canvas.height,
      w: Math.abs(p1.x - p0.x) * canvas.width,
      h: Math.abs(p1.y - p0.y) * canvas.height,
    };
  }
  if (stroke.text) {
    if (stroke.points.length === 0) {
      return null;
    }
    const ctx = getScratchCtx();
    if (!ctx) {
      return null;
    }
    // 与 renderStrokeToCtx 的文字渲染同一套字号/行高公式，bbox 才会贴合实绘。
    const fontSize = (stroke.fontSize || 24) * (canvas.width / REF_WIDTH);
    ctx.font = `${fontSize}px ${HAND_FONT_FAMILY}`;
    const lines = stroke.text.split("\n");
    let maxW = 0;
    for (const line of lines) {
      maxW = Math.max(maxW, ctx.measureText(line || " ").width);
    }
    return {
      x: stroke.points[0].x * canvas.width,
      y: stroke.points[0].y * canvas.height,
      w: maxW,
      h: lines.length * fontSize * 1.2,
    };
  }
  // Freehand pen strokes are not pickable.
  return null;
}

function distToSegmentPx(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(px - x0, py - y0);
  }
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// bbox 命中余量：让文本等 bbox 类元素更容易被点中。
const PICK_BBOX_PAD = 6;

/** Build a closed-shape Path2D in local (0,0,w,h) space. Shared by precise
 *  hit-testing and the fill-cascade containment test — 与 canvas 渲染几何
 *  严格同源（svgPath* 字符串）。 */
function buildClosedShapePath(
  shape: "rect" | "ellipse" | "triangle" | "star" | "heart",
  w: number,
  h: number,
): Path2D {
  const path = new Path2D();
  if (shape === "rect") {
    path.rect(0, 0, w, h);
  } else if (shape === "ellipse") {
    path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (shape === "triangle") {
    path.addPath(new Path2D(svgPathTriangle(w, h)));
  } else if (shape === "star") {
    path.addPath(new Path2D(svgPathStar(w, h)));
  } else {
    path.addPath(new Path2D(svgPathHeart(w, h)));
  }
  return path;
}

/**
 * Precise top-down hit test. Returns ALL pickable strokes under (px, py),
 * topmost first — upstream uses the full list for click-again-to-cycle-down.
 *
 * 命中规则（层级覆盖的关键）：
 * - 线框闭合形状只在描边带附近命中，空心内部**穿透**到下层
 * - 填充形状全身命中（视觉不透明，所见即所选）
 * - line/arrow 按点到线段距离；text 按实测 bbox
 * - pen / 油漆桶 / 框选结果不可选（栅格或种子语义）
 */
function findStrokesAtPoint(
  strokes: SerializedStroke[],
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
): number[] {
  const ctx = getScratchCtx();
  const hits: number[] = [];
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (s.fill || s.selection) {
      continue;
    }
    if (s.shape === "line" || s.shape === "arrow") {
      if (s.points.length < 2) {
        continue;
      }
      const [p0, p1] = s.points;
      const threshold = Math.max(8, scaleLineWidth(s.lineWidth, canvas.width) / 2 + 6);
      const d = distToSegmentPx(
        px,
        py,
        p0.x * canvas.width,
        p0.y * canvas.height,
        p1.x * canvas.width,
        p1.y * canvas.height,
      );
      if (d <= threshold) {
        hits.push(i);
      }
      continue;
    }
    if (s.shape) {
      if (s.points.length < 2 || !ctx) {
        continue;
      }
      const [p0, p1] = s.points;
      const x = Math.min(p0.x, p1.x) * canvas.width;
      const y = Math.min(p0.y, p1.y) * canvas.height;
      const w = Math.abs(p1.x - p0.x) * canvas.width;
      const h = Math.abs(p1.y - p0.y) * canvas.height;
      if (w === 0 || h === 0) {
        continue;
      }
      const path = buildClosedShapePath(s.shape, w, h);
      const lx = px - x;
      const ly = py - y;
      if (s.filled) {
        if (ctx.isPointInPath(path, lx, ly)) {
          hits.push(i);
        }
      } else {
        // 描边带 = 实际线宽 + 两侧各 ~6px 余量，细线框也好点中
        const lw = scaleLineWidth(s.lineWidth, canvas.width);
        ctx.lineWidth = Math.max(16, lw + 12);
        if (ctx.isPointInStroke(path, lx, ly)) {
          hits.push(i);
        }
      }
      continue;
    }
    if (s.text) {
      const box = getStrokeBBoxPx(s, canvas);
      if (
        box &&
        px >= box.x - PICK_BBOX_PAD &&
        px <= box.x + box.w + PICK_BBOX_PAD &&
        py >= box.y - PICK_BBOX_PAD &&
        py <= box.y + box.h + PICK_BBOX_PAD
      ) {
        hits.push(i);
      }
    }
  }
  return hits;
}

// 有"内部"概念的闭合形状 —— 只有它们可能圈住油漆桶种子。
const CLOSED_SHAPES = new Set<string>(["rect", "ellipse", "triangle", "star", "heart"]);

/**
 * 删除级联：找出种子点落在指定闭合形状内部、且时序在它之后的油漆桶笔画。
 * 不连带删除的话，重建重放时种子落在白底上会把整张画布灌成填充色。
 * 包含性判定与坐标空间无关（仿射不变），统一在 1000×1000 虚拟空间测试。
 */
export function findDependentFillIndices(
  strokes: SerializedStroke[],
  shapeIndex: number,
): number[] {
  const shape = strokes[shapeIndex];
  if (!shape?.shape || !CLOSED_SHAPES.has(shape.shape) || shape.points.length < 2) {
    return [];
  }
  const ctx = getScratchCtx();
  if (!ctx) {
    return [];
  }
  const SPACE = 1000;
  const [p0, p1] = shape.points;
  const x = Math.min(p0.x, p1.x) * SPACE;
  const y = Math.min(p0.y, p1.y) * SPACE;
  const w = Math.abs(p1.x - p0.x) * SPACE;
  const h = Math.abs(p1.y - p0.y) * SPACE;
  if (w === 0 || h === 0) {
    return [];
  }
  // 路径建在 (0,0,w,h) 本地空间，测试点平移 (-x, -y)。
  const path = buildClosedShapePath(
    shape.shape as "rect" | "ellipse" | "triangle" | "star" | "heart",
    w,
    h,
  );
  const result: number[] = [];
  for (let j = shapeIndex + 1; j < strokes.length; j++) {
    const f = strokes[j];
    if (!f.fill || f.points.length === 0) {
      continue;
    }
    const sx = f.points[0].x * SPACE - x;
    const sy = f.points[0].y * SPACE - y;
    if (ctx.isPointInPath(path, sx, sy)) {
      result.push(j);
    }
  }
  return result;
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
  const dirty = floodFill(img.data, canvas.width, canvas.height, sx, sy, fr, fg, fb, tolerance);
  if (dirty) {
    ctx.putImageData(img, 0, 0, dirty.x, dirty.y, dirty.w, dirty.h);
  }
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
  const pctx = patch.getContext("2d", { willReadFrequently: true });
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

  // Shape strokes: rect / ellipse / arrow / line / triangle / star / heart
  if (
    stroke.shape === "rect" ||
    stroke.shape === "ellipse" ||
    stroke.shape === "arrow" ||
    stroke.shape === "line" ||
    stroke.shape === "triangle" ||
    stroke.shape === "star" ||
    stroke.shape === "heart"
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

    // rect/ellipse/triangle/star/heart — bbox corners, order doesn't matter
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
      ctx.beginPath();
      ctx.rect(x, y, w, h);
    } else if (stroke.shape === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (stroke.shape === "triangle") {
      pathTriangle(ctx, x, y, w, h);
    } else if (stroke.shape === "star") {
      pathStar(ctx, x, y, w, h);
    } else if (stroke.shape === "heart") {
      pathHeart(ctx, x, y, w, h);
    }
    if (stroke.filled) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
    return;
  }

  // Text stroke
  if (stroke.text) {
    if (stroke.points.length === 0) {
      return;
    }
    const fontSize = (stroke.fontSize || 24) * (canvas.width / REF_WIDTH);
    kickHandFontLoad(stroke.text);
    ctx.font = `${fontSize}px ${HAND_FONT_FAMILY}`;
    ctx.fillStyle = stroke.color;
    // 每行占 1.2em 的"行槽"，stroke.points[0] 是槽位区域的左上角。字形用
    // textBaseline="middle" 画在槽位垂直中心：CJK 无下伸笔画时上下留白对称
    // （旧 textBaseline="top" 把 descent + 行距全堆到槽底，框内文字偏上）。
    // CSS 行盒的 half-leading 也是把字形内容盒居中，textarea 预览（Canvas.tsx，
    // marginTop 0 + line-height 1.2）与这里天然对齐，改一边必须同步另一边。
    ctx.textBaseline = "middle";
    const px = stroke.points[0].x * canvas.width;
    const py = stroke.points[0].y * canvas.height;
    const lineHeight = fontSize * 1.2;
    const lines = stroke.text.split("\n");
    const ranges = stroke.colorRanges;
    let lineStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineY = py + (i + 0.5) * lineHeight;
      if (ranges && ranges.length > 0) {
        // 局部上色：按颜色区间切段逐段绘制，x 按各段 advance 宽度累加。
        // 分段 fillText 会丢段间 kerning，但 CJK 无 kerning、误差可忽略。
        let segX = px;
        for (const seg of lineSegments(lines[i], lineStart, ranges)) {
          if (seg.text) {
            ctx.fillStyle = seg.color ?? stroke.color;
            ctx.fillText(seg.text, segX, lineY);
            segX += ctx.measureText(seg.text).width;
          }
        }
      } else {
        ctx.fillText(lines[i], px, lineY);
      }
      lineStart += lines[i].length + 1; // +1 算上行尾 \n
    }
    return;
  }

  // Freehand pen stroke — 派发到具体笔型渲染器（缺 brushType 视作普通 pen）
  const pxPoints: Point[] = stroke.points.map((p) => ({
    x: p.x * canvas.width,
    y: p.y * canvas.height,
  }));
  renderBrushStroke(
    ctx,
    pxPoints,
    stroke.color,
    scaleLineWidth(stroke.lineWidth, canvas.width),
    stroke.brushType,
  );
}

/**
 * 存量数据里可能有畸形笔画（服务端校验上线前写入的）。一笔画不出来，
 * 不能影响其余笔画，也不能打断 roomState 后面的处理。
 */
function renderStrokeSafely(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  stroke: SerializedStroke,
): void {
  try {
    renderStrokeToCtx(ctx, canvas, stroke);
  } catch (err) {
    console.warn("跳过无法渲染的笔画", err);
  }
}

/** Draw a live preview of an in-progress shape/arrow/line onto the visible context. */
function drawShapePreview(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  start: Point,
  end: Point,
  color: string,
  lineWidth: number,
  shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart",
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
    ctx.beginPath();
    ctx.rect(x, y, w, h);
  } else if (shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (shape === "triangle") {
    pathTriangle(ctx, x, y, w, h);
  } else if (shape === "star") {
    pathStar(ctx, x, y, w, h);
  } else if (shape === "heart") {
    pathHeart(ctx, x, y, w, h);
  }
  if (filled) {
    ctx.fill();
  } else {
    ctx.stroke();
  }
}

export function useCanvas({
  canvasRef,
  isDrawer,
  color,
  lineWidth,
  tool,
  fillMode,
  brushType,
  send,
  onShapeDrawn,
  onLocalPenEnd,
  onSelectionDrawn,
  onStrokePicked,
  onStrokeHovered,
  phase,
}: UseCanvasOptions) {
  const isDrawingRef = useRef(false);
  const strokesRef = useRef<SerializedStroke[]>([]);
  const currentStrokeRef = useRef<{
    points: Point[];
    // 累计路径长度（归一化坐标），分段用
    path: number;
    color: string;
    lineWidth: number;
    brushType: BrushType;
  } | null>(null);
  const pendingPointsRef = useRef<Point[]>([]);
  const rafIdRef = useRef<number | null>(null);
  // 框选悬空标记：beginSelection 已把 src 区域涂白、patch 还浮在 overlay 上。
  // 此窗口内不能重放（会把 src 原像素恢复出来，commit 后变重影）。
  const hasPendingSelectionRef = useRef(false);

  // Offscreen canvas — single source of truth for committed strokes.
  // Initialized with an opaque white background so the bucket tool has
  // real pixels to read (transparent pixels would make every fill degenerate).
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  // 离屏上画到了哪一笔，以及撤销时用的检查点。strokesRef 是目标，replay.sync 负责追上它。
  const replayRef = useRef<StrokeReplay<SerializedStroke, HTMLCanvasElement> | null>(null);
  if (offscreenRef.current === null && typeof document !== "undefined") {
    const off = createOffscreenCanvas();
    // willReadFrequently: true → 关闭 GPU 加速，让 getImageData 走 CPU 直读。
    // 油漆桶 / 反走样每次填充都要 readback 整张离屏，标记后浏览器不再重复
    // 警告，且 readback 性能更稳定。
    const offCtx = off.getContext("2d", { willReadFrequently: true });
    if (offCtx) {
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(0, 0, OFFSCREEN_WIDTH, OFFSCREEN_HEIGHT);
      replayRef.current = new StrokeReplay({
        surface: offscreenSurface(off, offCtx),
        render: (stroke) => renderStrokeSafely(offCtx, off, stroke),
      });
    }
    offscreenRef.current = off;
  }
  // 重放没画完（分片进行中）。这段时间离屏只是半成品，可见画布保留上一帧，画完再一次换上去。
  const replayPendingRef = useRef(false);
  const replaySliceScheduledRef = useRef(false);
  const unmountedRef = useRef(false);

  // 进行中的喷枪、蜡笔是增量画在可见画布上的：这里记着哪一笔、画到第几条线段。
  // 可见画布一旦被整张覆盖，这些像素就没了，要从头补画。
  const liveStrokeRef = useRef<object | null>(null);
  const liveSegmentsRef = useRef(0);
  // 对端的 move 按帧合并，一帧最多重绘一次
  const remoteFrameRef = useRef<number | null>(null);

  // 重放分片期间离屏只是半成品，可见画布用开始重放前那一帧做底（加上这期间提交的笔画），
  // 画完再换成离屏。进行中的笔画、形状预览、框选预览都画在这个底上，不会露出半成品。
  const frozenFrameRef = useRef<HTMLCanvasElement | null>(null);
  const frozenValidRef = useRef(false);

  const freezeVisible = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      frozenValidRef.current = false;
      return;
    }
    const frozen = frozenFrameRef.current ?? document.createElement("canvas");
    frozenFrameRef.current = frozen;
    frozen.width = canvas.width;
    frozen.height = canvas.height;
    const ctx = frozen.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      frozenValidRef.current = false;
      return;
    }
    ctx.drawImage(canvas, 0, 0);
    frozenValidRef.current = true;
  }, [canvasRef]);

  /** 把可见画布恢复成底图：平时是离屏，重放分片期间是冻结的那一帧。进行中的笔画要另外补画。 */
  const syncVisibleFromOffscreen = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }
    const base =
      replayPendingRef.current && frozenValidRef.current
        ? frozenFrameRef.current
        : offscreenRef.current;
    if (!base) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    liveStrokeRef.current = null;
  }, [canvasRef]);

  /** 把进行中的笔画画到可见画布上。按帧调用。 */
  const paintLiveStroke = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const stroke = currentStrokeRef.current;
    if (!canvas || !ctx || !stroke || stroke.points.length === 0) {
      return;
    }
    const toPixels = (p: Point): Point => ({ x: p.x * canvas.width, y: p.y * canvas.height });
    const lw = scaleLineWidth(stroke.lineWidth, canvas.width);
    if (!isIncrementalBrush(stroke.brushType)) {
      // 水彩有模糊和透明度，普通笔的成本很低：都是每帧整条重画，每个像素只涂一次
      syncVisibleFromOffscreen();
      renderBrushStroke(ctx, stroke.points.map(toPixels), stroke.color, lw, stroke.brushType);
      return;
    }
    // 喷枪、蜡笔整条重画的成本和路径长度成正比，一笔长了对端就卡。上一帧的像素还在画布上，只补新线段。
    if (liveStrokeRef.current !== stroke) {
      syncVisibleFromOffscreen();
      liveStrokeRef.current = stroke;
      liveSegmentsRef.current = 0;
    }
    const from = liveSegmentsRef.current;
    const pts = stroke.points.slice(from).map(toPixels);
    renderBrushSegments(ctx, pts, stroke.color, lw, stroke.brushType, from);
    liveSegmentsRef.current = Math.max(from, stroke.points.length - 1);
  }, [canvasRef, syncVisibleFromOffscreen]);

  /** 底图 + 进行中的笔画。可见画布被整张覆盖（窗口缩放、重放结束）之后调用。 */
  const repaintVisible = useCallback(() => {
    syncVisibleFromOffscreen();
    paintLiveStroke();
  }, [syncVisibleFromOffscreen, paintLiveStroke]);

  const finishReplay = useCallback(() => {
    replayPendingRef.current = false;
    frozenValidRef.current = false;
    repaintVisible();
  }, [repaintVisible]);

  /** 让离屏追上 strokesRef。画得完就当场换上去，画不完就分片继续，不长时间占住主线程。 */
  const pumpReplay = useCallback(() => {
    const replay = replayRef.current;
    if (!replay) {
      return;
    }
    if (replay.sync(strokesRef.current, REPLAY_SLICE_MS)) {
      finishReplay();
      return;
    }
    if (!replayPendingRef.current) {
      // 可见画布还是改动之前的样子，冻结下来当底图
      freezeVisible();
      replayPendingRef.current = true;
    }
    if (replaySliceScheduledRef.current) {
      return;
    }
    replaySliceScheduledRef.current = true;
    yieldToMain(() => {
      replaySliceScheduledRef.current = false;
      if (replayPendingRef.current && !unmountedRef.current) {
        pumpReplay();
      }
    });
  }, [finishReplay, freezeVisible]);

  /** 要读离屏像素前调用：必须是完整的画面。 */
  const flushReplay = useCallback(() => {
    replayRef.current?.sync(strokesRef.current);
    if (replayPendingRef.current) {
      finishReplay();
    }
  }, [finishReplay]);

  /**
   * 记下一笔并画到离屏。重放进行中就排在后面，轮到它时一起画，顺序不会乱；
   * 同时先画到冻结的底图上，提交了马上就看得到。油漆桶和框选要读像素，只能等重放画完。
   */
  const appendStroke = useCallback(
    (stroke: SerializedStroke) => {
      strokesRef.current.push(stroke);
      if (!replayPendingRef.current) {
        replayRef.current?.sync(strokesRef.current);
        return;
      }
      if (stroke.fill || stroke.selection) {
        flushReplay();
        return;
      }
      const frozen = frozenFrameRef.current;
      const frozenCtx = frozen?.getContext("2d");
      if (frozen && frozenCtx && frozenValidRef.current) {
        renderStrokeSafely(frozenCtx, frozen, stroke);
      }
    },
    [flushReplay],
  );

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (remoteFrameRef.current !== null) {
        cancelAnimationFrame(remoteFrameRef.current);
        remoteFrameRef.current = null;
      }
    };
  }, []);

  /**
   * 丢弃进行中的笔画（本地的，或对端的半截）。
   * keepLocal：自己正按着鼠标时保留，松手时 end 会带着整笔发出去，服务端以它为准。
   */
  const resetStrokeInProgress = useCallback(
    (keepLocal = false) => {
      if (keepLocal && isDrawingRef.current) {
        return;
      }
      const hadStroke = currentStrokeRef.current !== null;
      isDrawingRef.current = false;
      currentStrokeRef.current = null;
      pendingPointsRef.current = [];
      if (hadStroke) {
        syncVisibleFromOffscreen();
      }
    },
    [syncVisibleFromOffscreen],
  );

  // 进行中的笔画不会再结束的情况：
  // - 进入猜词 / 揭晓阶段：服务端不再接受画布操作，本地和对端的半截都作废
  // - 失去画手身份：本地那一笔作废。isDrawingRef 留在 true 的话，之后再当画手时鼠标一动就接着画
  useEffect(() => {
    if (phase === "guessing" || phase === "revealed" || (!isDrawer && isDrawingRef.current)) {
      resetStrokeInProgress();
    }
  }, [isDrawer, phase, resetStrokeInProgress]);

  // 手写字体（Excalifont / Xiaolai）按 unicode-range 子集异步加载：roomState
  // 回放或远端 textStroke 到达时字体可能尚未就绪，文字先以回退字体绘制。
  // 字体到了之后，第一条文字之后的笔画要重画，把回退字形换掉。没有文字就不用重画。
  const refreshTextStrokes = useCallback(() => {
    const firstText = strokesRef.current.findIndex((stroke) => stroke.text);
    if (firstText === -1) {
      // 不动离屏，只把可见画布恢复原样（进行中的笔画也补回来）
      repaintVisible();
      return;
    }
    replayRef.current?.invalidateFrom(firstText);
    pumpReplay();
  }, [pumpReplay, repaintVisible]);

  // 框选悬空时字体到了：重画会恢复已涂白的 src 像素造成重影，等框选结束再补上。
  const fontRefreshPendingRef = useRef(false);
  const settleSelection = useCallback(() => {
    hasPendingSelectionRef.current = false;
    if (fontRefreshPendingRef.current) {
      fontRefreshPendingRef.current = false;
      refreshTextStrokes();
    }
  }, [refreshTextStrokes]);

  // 一批字体往往接连到达，合并成一次重画
  const fontRefreshTimerRef = useRef<number | null>(null);
  const requestTextRefresh = useCallback(() => {
    if (fontRefreshTimerRef.current !== null) {
      return;
    }
    fontRefreshTimerRef.current = window.setTimeout(() => {
      fontRefreshTimerRef.current = null;
      if (unmountedRef.current) {
        return;
      }
      if (hasPendingSelectionRef.current) {
        fontRefreshPendingRef.current = true;
        return;
      }
      refreshTextStrokes();
    }, 100);
  }, [refreshTextStrokes]);

  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) {
      return;
    }
    const fonts = document.fonts;
    const onFontsLoaded = (event: Event) => {
      // 什么字体都没加载完成的事件不用管
      const faces = (event as FontFaceSetLoadEvent).fontfaces;
      if (faces && faces.length === 0) {
        return;
      }
      requestTextRefresh();
    };
    fonts.addEventListener("loadingdone", onFontsLoaded);
    // 样式表到达之前画的文字没能触发字体下载：现在补上，下载完再重画一次
    let unmounted = false;
    void loadHandFontStylesheet().then(async () => {
      const texts = [...new Set(strokesRef.current.flatMap((s) => (s.text ? [s.text] : [])))];
      if (unmounted || texts.length === 0) {
        return;
      }
      await loadHandFonts(texts);
      if (!unmounted) {
        requestTextRefresh();
      }
    });
    return () => {
      unmounted = true;
      fonts.removeEventListener("loadingdone", onFontsLoaded);
      if (fontRefreshTimerRef.current !== null) {
        window.clearTimeout(fontRefreshTimerRef.current);
        fontRefreshTimerRef.current = null;
      }
    };
  }, [requestTextRefresh]);

  /**
   * Drawer-side: open a selection. Extracts a patch from the offscreen src rect,
   * whitens src on the offscreen, mirrors to visible, and returns the patch
   * canvas (upstream holds it in React state for the overlay preview). Nothing
   * is pushed to strokes yet — that happens at commit time.
   */
  const beginSelection = useCallback(
    (srcNorm: { x: number; y: number; w: number; h: number }): HTMLCanvasElement | null => {
      flushReplay();
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
      const pctx = patch.getContext("2d", { willReadFrequently: true });
      if (!pctx) {
        return null;
      }
      pctx.drawImage(offs, srcPxX, srcPxY, srcPxW, srcPxH, 0, 0, srcPxW, srcPxH);
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(srcPxX, srcPxY, srcPxW, srcPxH);
      // 涂白的像素不在 strokes 里，提交之前都不能算数
      replayRef.current?.taint();
      syncVisibleFromOffscreen();
      hasPendingSelectionRef.current = true;
      return patch;
    },
    [flushReplay, syncVisibleFromOffscreen],
  );

  /**
   * Drawer-side: commit a selection in progress. Offscreen already has src
   * whitened (from beginSelection), so we just paste the patch at dst.
   * 返回是否真的提交了：框选已经被作废（比如重连收到全量状态，来源像素画回去了）时不能再粘贴，
   * 否则来源和目标各有一份，本地多出一块别人看不到的重影。调用方据此决定发不发消息。
   */
  const commitLocalSelection = useCallback(
    (
      patch: HTMLCanvasElement,
      srcNorm: { x: number; y: number; w: number; h: number },
      dstNorm: { x: number; y: number },
    ): boolean => {
      if (!hasPendingSelectionRef.current) {
        return false;
      }
      const offs = offscreenRef.current;
      if (!offs) {
        return false;
      }
      const offCtx = offs.getContext("2d");
      if (!offCtx) {
        return false;
      }
      const srcPxW = Math.round(srcNorm.w * offs.width);
      const srcPxH = Math.round(srcNorm.h * offs.height);
      const dstPxX = Math.round(dstNorm.x * offs.width);
      const dstPxY = Math.round(dstNorm.y * offs.height);
      offCtx.drawImage(patch, 0, 0, patch.width, patch.height, dstPxX, dstPxY, srcPxW, srcPxH);
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
      // 涂白 + 粘贴和重放这一笔的结果完全相同，不用重画
      replayRef.current?.noteRendered(stroke);
      replayRef.current?.untaint();
      syncVisibleFromOffscreen();
      settleSelection();
      return true;
    },
    [settleSelection, syncVisibleFromOffscreen],
  );

  /**
   * Drawer-side: abort an in-progress selection. Restores the offscreen from the
   * committed strokes (which don't include the pending selection). Called when
   * the user switches away or clears without commit.
   */
  const cancelLocalSelection = useCallback(() => {
    settleSelection();
    pumpReplay();
  }, [pumpReplay, settleSelection]);

  /**
   * Drawer-side: the floating patch was discarded on purpose (deleted selection, or
   * a full state just arrived). The next stroke rebuilds from the committed strokes.
   */
  const releaseLocalSelection = useCallback(() => {
    settleSelection();
  }, [settleSelection]);

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
      appendStroke({
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
      });
      syncVisibleFromOffscreen();
    },
    [appendStroke, syncVisibleFromOffscreen],
  );

  /**
   * Apply a bucket-fill stroke (from local tool click OR a remote S_Fill message).
   * Runs flood fill on the offscreen, mirrors to the visible canvas, and records
   * the stroke so replay / undo are correct. Does NOT send a wire message — the
   * caller is responsible for that when appropriate.
   */
  const addFill = useCallback(
    (normX: number, normY: number, fillColor: string, tolerance: number) => {
      appendStroke({
        points: [{ x: normX, y: normY }],
        color: fillColor,
        lineWidth: 0,
        fill: { tolerance },
      });
      syncVisibleFromOffscreen();
    },
    [appendStroke, syncVisibleFromOffscreen],
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

    // ========== Pen / Eraser tool ==========
    // 橡皮擦 = 强制白色 + 强制 pen brush 的「特殊 pen」。所有协议、存储、
    // undo 都走现有 pen 笔画路径，不需要特殊消息类型。
    if (tool === "pen" || tool === "eraser") {
      const isEraser = tool === "eraser";
      const effColor = isEraser ? "#ffffff" : color;
      const effBrush: BrushType = isEraser ? "pen" : brushType;

      // 网络发送按时间节流：rAF 频率等于屏幕刷新率，高刷屏每帧发一条会撞服务端限流。
      // 取 16ms 而不是 1000/60：60Hz 屏的帧间隔有抖动，16.67 会让大约一半的帧被跳过。
      const MOVE_SEND_INTERVAL_MS = 16;
      let lastMoveSentAt = 0;

      const sendPendingMove = () => {
        const points = pendingPointsRef.current;
        if (points.length === 0) {
          return;
        }
        pendingPointsRef.current = [];
        lastMoveSentAt = performance.now();
        const last = points[points.length - 1];
        send({
          type: "draw",
          action: "move",
          x: last.x,
          y: last.y,
          color: effColor,
          lineWidth,
          points,
        });
      };

      const flushPendingMove = () => {
        rafIdRef.current = null;
        if (pendingPointsRef.current.length === 0) {
          return;
        }
        if (performance.now() - lastMoveSentAt >= MOVE_SEND_INTERVAL_MS) {
          sendPendingMove();
        } else {
          // 还没到发送时间：点留在队列里，下一帧再试，不会丢
          scheduleFlush();
        }
        // 视觉重绘：每 RAF 帧一次，避免 mousemove 高频触发的浪费
        paintLiveStroke();
      };

      const scheduleFlush = () => {
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flushPendingMove);
        }
      };

      // 喷枪「按住持续喷射」：mousedown 后启动定时器，每 SPRAY_INTERVAL_MS
      // 把 lastPos 重新加进 stroke。鼠标静止时浓度按时间累积；移动时 stamp
      // 间距大、密度低，匹配 Win Paint 的 hold-still 体感。
      const SPRAY_INTERVAL_MS = 80;
      let lastPos: Point | null = null;
      let sprayInterval: number | null = null;
      const startSpray = () => {
        if (effBrush !== "airbrush" || sprayInterval !== null) {
          return;
        }
        sprayInterval = window.setInterval(() => {
          if (!isDrawingRef.current || !lastPos || !currentStrokeRef.current) {
            return;
          }
          addPoint(lastPos.x, lastPos.y);
        }, SPRAY_INTERVAL_MS);
      };
      const stopSpray = () => {
        if (sprayInterval !== null) {
          window.clearInterval(sprayInterval);
          sprayInterval = null;
        }
      };

      const beginStroke = (x: number, y: number) => {
        currentStrokeRef.current = {
          points: [{ x, y }],
          path: 0,
          color: effColor,
          lineWidth,
          brushType: effBrush,
        };
        // brushType 仅在 start 上发；服务端缓存后透传 move/end 给对端
        send({
          type: "draw",
          action: "start",
          x,
          y,
          color: effColor,
          lineWidth,
          ...(effBrush !== "pen" ? { brushType: effBrush } : {}),
        });
      };

      // 结束当前笔：先提交到本地，再把整笔随 end 发出去。服务端和对端都以这份为准，
      // 所以中途断线丢掉的 start / move 不影响结果。
      const finishStroke = (x: number, y: number) => {
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        // end 之前必须发完，不受节流限制，否则对端看到的进行中笔画会少点
        sendPendingMove();
        const stash = currentStrokeRef.current;
        if (!stash) {
          return;
        }
        stash.points.push({ x, y });
        const finalized: SerializedStroke = {
          points: stash.points,
          color: stash.color,
          lineWidth: stash.lineWidth,
          // 默认 pen 不写字段（保持与历史 stroke 一致）
          ...(stash.brushType !== "pen" ? { brushType: stash.brushType } : {}),
        };
        appendStroke(finalized);
        syncVisibleFromOffscreen();
        currentStrokeRef.current = null;
        send({ type: "draw", action: "end", x, y, color: effColor, lineWidth, stroke: finalized });
        onLocalPenEnd?.();
      };

      // 关键：两个数组各自 push **独立的副本**而不是共享同一对象引用，
      // 避免未来谁误改其中一个连带影响另一个
      const addPoint = (x: number, y: number) => {
        const stroke = currentStrokeRef.current;
        if (!stroke) {
          return;
        }
        const last = stroke.points[stroke.points.length - 1];
        stroke.path += Math.hypot(x - last.x, y - last.y);
        stroke.points.push({ x, y });
        pendingPointsRef.current.push({ x, y });
        // 超长的一笔自动分段，从同一点接着画，服务端不收超过上限的笔画。
        // 点数留一个名额给 end 的终点；路径留 1/4 的余量，下一次移动或松手可能有一大段跳变。
        if (
          stroke.points.length >= MAX_STROKE_POINTS - 1 ||
          stroke.path >= MAX_STROKE_PATH * 0.75
        ) {
          finishStroke(x, y);
          beginStroke(x, y);
          return;
        }
        scheduleFlush();
      };

      const onMouseDown = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        isDrawingRef.current = true;
        const { x, y } = normalize(e);
        lastPos = { x, y };
        beginStroke(x, y);
        startSpray();
      };

      const onMouseMove = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        if (!isDrawingRef.current) {
          return;
        }
        const { x, y } = normalize(e);
        lastPos = { x, y };
        addPoint(x, y);
      };

      const onMouseUp = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        if (!isDrawingRef.current) {
          return;
        }
        isDrawingRef.current = false;
        stopSpray();
        const { x, y } = normalize(e);
        finishStroke(x, y);
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
        stopSpray();
        pendingPointsRef.current = [];
      };
    }

    // ========== Bucket (flood fill) tool ==========
    // One click = one fill. No drag, no editing overlay.
    if (tool === "bucket") {
      const FILL_TOLERANCE = 32;
      const onClick = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        const normX = e.offsetX / canvas.width;
        const normY = e.offsetY / canvas.height;
        addFill(normX, normY, color, FILL_TOLERANCE);
        send({ type: "fill", x: normX, y: normY, color, tolerance: FILL_TOLERANCE });
        onLocalPenEnd?.();
      };
      canvas.addEventListener("click", onClick);
      return () => canvas.removeEventListener("click", onClick);
    }

    // ========== Selection (marquee + element pick) tool ==========
    // 拖拽 → 框选移动（原有行为）；单击 → 命中已提交元素上报（选中删除）；
    // 空闲悬浮 → hover 浅虚线提示。位移 < CLICK_EPS_PX 视为单击，介于单击与
    // 最小框选尺寸之间的微小拖拽按误触丢弃。
    if (tool === "selection") {
      const MIN_SIZE_PX = 20;
      const CLICK_EPS_PX = 4;
      let startPx: Point | null = null;
      let lastHover: number | null = null;
      const reportHover = (idx: number | null) => {
        if (idx !== lastHover) {
          lastHover = idx;
          onStrokeHovered?.(idx);
        }
        // 行内 style 覆盖 Twind cursor class；空串还原为工具默认光标
        canvas.style.cursor = idx !== null ? "pointer" : "";
      };
      const onDown = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        startPx = { x: e.offsetX, y: e.offsetY };
        // 拖拽期间不显示 hover 提示
        reportHover(null);
      };
      const onMove = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        if (!startPx) {
          // 空闲悬浮：浅虚线提示最上层可选元素
          const hits = findStrokesAtPoint(strokesRef.current, canvas, e.offsetX, e.offsetY);
          reportHover(hits.length > 0 ? hits[0] : null);
          return;
        }
        syncVisibleFromOffscreen();
        ctx.strokeStyle = "#818cf8";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(startPx.x, startPx.y, e.offsetX - startPx.x, e.offsetY - startPx.y);
        ctx.setLineDash([]);
      };
      const onUp = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        if (!startPx) {
          return;
        }
        const start = startPx;
        startPx = null;
        const bx = Math.min(start.x, e.offsetX);
        const by = Math.min(start.y, e.offsetY);
        const bw = Math.abs(e.offsetX - start.x);
        const bh = Math.abs(e.offsetY - start.y);
        if (Math.max(bw, bh) < CLICK_EPS_PX) {
          // 单击：上报光标下全部命中（最上层在前），上游负责选中 / 下钻 / 取消
          syncVisibleFromOffscreen();
          onStrokePicked?.(findStrokesAtPoint(strokesRef.current, canvas, e.offsetX, e.offsetY));
          return;
        }
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
          // 进入框选移动时取消元素选中，避免两种虚线框叠加
          onStrokePicked?.([]);
          onSelectionDrawn?.(srcNorm, patch);
        }
      };
      const onLeave = () => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        reportHover(null);
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
        onStrokeHovered?.(null);
        canvas.style.cursor = "";
      };
    }

    // ========== Shape / arrow tools ==========
    // mousedown: record start
    // mousemove: repaint visible (clear + blit offscreen + preview), never writes to offscreen
    // mouseup: emit DrawnShape — upstream holds it in editingShape state
    const filled = fillMode === "fill";
    const shapeKind: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart" = tool;
    let shapeStart: Point | null = null;

    const onShapeDown = (e: MouseEvent) => {
      if (phase === "guessing" || phase === "revealed") {
        return;
      }
      shapeStart = normalize(e);
    };

    // 把鼠标坐标钳到画布范围内：mouseleave 时 offsetX/Y 会超出边界，
    // 否则形状会画到 canvas 之外（normalized > 1 或 < 0）。
    const clampToCanvas = (e: MouseEvent): Point => ({
      x: Math.max(0, Math.min(canvas.width, e.offsetX)) / canvas.width,
      y: Math.max(0, Math.min(canvas.height, e.offsetY)) / canvas.height,
    });

    const onShapeMove = (e: MouseEvent) => {
      if (phase === "guessing" || phase === "revealed") {
        return;
      }
      if (!shapeStart) {
        return;
      }
      const current = clampToCanvas(e);
      syncVisibleFromOffscreen();
      drawShapePreview(ctx, canvas, shapeStart, current, color, lineWidth, shapeKind, filled);
    };

    // mouseup 与 mouseleave 都走这里——参考 pen 的做法：鼠标离开边界 =
    // 在边界处提交形状（坐标已被 clampToCanvas 钳到画布内），而不是清空预览。
    const onShapeUp = (e: MouseEvent) => {
      if (phase === "guessing" || phase === "revealed") {
        return;
      }
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
    brushType,
    send,
    appendStroke,
    paintLiveStroke,
    syncVisibleFromOffscreen,
    onShapeDrawn,
    onLocalPenEnd,
    onSelectionDrawn,
    onStrokePicked,
    onStrokeHovered,
    addFill,
    beginSelection,
    phase,
  ]);

  // Replay a remote draw event (pen).
  const replayDraw = useCallback(
    (msg: S_Draw) => {
      // 这里不能因为画布没挂载就提前返回：roomState 刚到时 Canvas 还没渲染，紧跟着的 end
      // 丢了的话这一笔就永远缺了。笔画和离屏都不依赖可见画布，挂载后会从离屏同步过去。

      // brushType 由服务端透传到所有 action（worker 缓存了 start 时的笔型），
      // 这里直接读 msg.brushType；缺值视作 "pen"。
      const incomingBrush: BrushType = msg.brushType ?? "pen";

      if (msg.action === "start") {
        currentStrokeRef.current = {
          points: [{ x: msg.x, y: msg.y }],
          path: 0,
          color: msg.color,
          lineWidth: msg.lineWidth,
          brushType: incomingBrush,
        };
      } else if (msg.action === "move") {
        const points = msg.points ?? [{ x: msg.x, y: msg.y }];
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push(...points);
          // 不管消息来得多快，一帧只重绘一次
          if (remoteFrameRef.current === null) {
            remoteFrameRef.current = requestAnimationFrame(() => {
              remoteFrameRef.current = null;
              paintLiveStroke();
            });
          }
        }
      } else if (msg.action === "end") {
        if (remoteFrameRef.current !== null) {
          cancelAnimationFrame(remoteFrameRef.current);
          remoteFrameRef.current = null;
        }
        const stash = currentStrokeRef.current;
        currentStrokeRef.current = null;
        // 以服务端存下的整笔为准：中途加入、重连时漏了 start 或部分 move 都能补全。
        // 旧服务端不带这个字段，退回本地累积的点。
        let finalized = msg.stroke ?? null;
        if (!finalized && stash) {
          stash.points.push({ x: msg.x, y: msg.y });
          finalized = {
            points: stash.points,
            color: stash.color,
            lineWidth: stash.lineWidth,
            ...(stash.brushType !== "pen" ? { brushType: stash.brushType } : {}),
          };
        }
        if (finalized) {
          appendStroke(finalized);
          syncVisibleFromOffscreen();
        }
      }
    },
    [appendStroke, paintLiveStroke, syncVisibleFromOffscreen],
  );

  /**
   * 把笔画换成 strokes 并画出来。撤销、删除、收到全量状态都走这里，只补必要的部分，
   * 画不完就分片继续（见 pumpReplay）。
   */
  const replayAll = useCallback(
    (strokes: SerializedStroke[]) => {
      strokesRef.current = strokes;
      pumpReplay();
    },
    [pumpReplay],
  );

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    liveStrokeRef.current = null;
    replayRef.current?.clear();
    replayPendingRef.current = false;
    strokesRef.current = [];
    // 画布清空后没有悬空的框选了。对端的半截笔画也作废（画手离开时会走到这里）。
    hasPendingSelectionRef.current = false;
    fontRefreshPendingRef.current = false;
    if (!isDrawingRef.current) {
      currentStrokeRef.current = null;
    }
  }, [canvasRef]);

  // Add a text stroke from remote (commit to offscreen + mirror to visible)
  const addTextStroke = useCallback(
    (
      text: string,
      x: number,
      y: number,
      textColor: string,
      fontSize: number,
      colorRanges?: TextColorRange[],
    ) => {
      const stroke: SerializedStroke = {
        points: [{ x, y }],
        color: textColor,
        lineWidth: 0,
        text,
        fontSize,
      };
      if (colorRanges && colorRanges.length > 0) {
        stroke.colorRanges = colorRanges;
      }
      appendStroke(stroke);
      syncVisibleFromOffscreen();
    },
    [appendStroke, syncVisibleFromOffscreen],
  );

  /** Add a shape/arrow/line stroke (from local commit OR remote). Accepts normalized points. */
  const addShape = useCallback(
    (
      p0: Point,
      p1: Point,
      shapeColor: string,
      shapeLineWidth: number,
      shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart",
      filled: boolean,
    ) => {
      appendStroke({
        points: [p0, p1],
        color: shapeColor,
        lineWidth: shapeLineWidth,
        shape,
        filled,
      });
      syncVisibleFromOffscreen();
    },
    [appendStroke, syncVisibleFromOffscreen],
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
    releaseLocalSelection,
    resetStrokeInProgress,
    repaintVisible,
    strokesRef,
  };
}
