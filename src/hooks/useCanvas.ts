import { useRef, useCallback, useEffect } from "react";
import type {
  BrushType,
  ClientMessage,
  GamePhase,
  S_Draw,
  SerializedStroke,
} from "../types/protocol";
import type { FillMode, ToolMode } from "../components/Toolbar";

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

// 画板文本的手写字体栈：Excalifont 覆盖英文/数字，Xiaolai（小赖体）覆盖中文。
// 字体由自托管 CDN 提供（index.html 引入 fonts.dengjiabei.cn/hand.css），按
// unicode-range 子集懒加载；CDN 不可达时回退 cursive / 系统字体。
export const HAND_FONT_FAMILY = '"Excalifont", "Xiaolai", cursive';

// document.fonts.check / load 用的探针串。故意不含 cursive：generic family
// 永远视作已加载，带上它 check() 恒为 true，真正需要的网络加载会被跳过。
const HAND_FONT_PROBE = '16px "Excalifont", "Xiaolai"';

/**
 * 触发 text 所需手写字体子集的下载。canvas 的 fillText 不像 DOM 文本那样会
 * 自动触发 @font-face（unicode-range 子集）加载，必须显式 load；加载完成后
 * 由 useCanvas 里的 "loadingdone" 监听统一重建离屏，把回退字形换成手写体。
 */
function kickHandFontLoad(text: string): void {
  if (typeof document === "undefined" || !document.fonts) {
    return;
  }
  try {
    if (!document.fonts.check(HAND_FONT_PROBE, text)) {
      document.fonts.load(HAND_FONT_PROBE, text).catch(() => {
        // CDN 不可达：维持回退字体渲染，不重试不报错
      });
    }
  } catch {
    // 老浏览器无 FontFaceSet API：直接用回退字体
  }
}

// Physical offscreen canvas dimensions (5:3). Larger than REF for finer
// anti-aliasing on curves: pen strokes are rendered at 2× linear resolution,
// then downsampled when blitted onto the visible canvas (which is typically
// smaller than OFFSCREEN_WIDTH). This dramatically reduces stair-step
// aliasing on curved fills/strokes vs. rendering directly at REF_*.
// Aspect ratio MUST match RATIO_W:RATIO_H in Canvas.tsx and REF_WIDTH:REF_HEIGHT.
const OFFSCREEN_WIDTH = 1600;
const OFFSCREEN_HEIGHT = 960;

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

/**
 * 确定性伪随机：对相同 (x, y, n) 返回相同值。两端用同一公式渲染相同点序，
 * 散点位置完全一致，无需通过协议传随机数据。返回 [0, 1)。
 */
function pseudoRandom(x: number, y: number, n: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + n * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** 普通画笔：实色 round-cap stroke，沿点序连线。 */
function renderPenBrush(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  lw: number,
): void {
  if (pts.length === 0) {
    return;
  }
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      ctx.moveTo(pts[i].x, pts[i].y);
    } else {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
  }
  ctx.stroke();
}

/**
 * 喷枪：仿 Windows 画图工具 —— 大量小点 + **均匀**面积分布（关键 bug 修复）。
 *
 * 之前误用 r = R · u² 让小 r 出现概率高 → 每个 stamp 中心比外围密 → 沿路径
 * 所有 stamp 中心连成一条可见的实线。改成 r = R · √u（u² 的反函数）让点
 * 在 disc 内**按面积均匀分布**：径向各处单位面积内点数相同，无中心偏置。
 *
 * 配合上层在 hold-still 时由 setInterval 持续把 lastPos 加进 stroke 的逻辑：
 * 移动快 → stamp 间隔大 → 浓度低；移动慢/不动 → stamp 在同一处叠加 → 浓度
 * 按时间累积，匹配 Win Paint 的「按住一直喷」体感。
 */
function renderAirbrush(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  lw: number,
): void {
  if (pts.length < 1) {
    return;
  }
  ctx.fillStyle = color;
  const radius = lw * 1.8;
  const stride = Math.max(1.0, lw * 0.5); // 加大步长，避免相邻 stamp 在路径上重叠形成中心线
  const dotsPerPos = 14;
  const dotSize = Math.max(0.5, lw * 0.18);

  /** 在 (cx, cy) 撒一坨散点；segIdx 用作 PRNG 域，保证不同 stamp 散点不同。 */
  const stampAt = (cx: number, cy: number, segIdx: number, stepIdx: number) => {
    for (let d = 0; d < dotsPerPos; d++) {
      const angle = pseudoRandom(segIdx, stepIdx, d) * Math.PI * 2;
      const u = pseudoRandom(segIdx + 7919, stepIdx, d * 3 + 1);
      // 均匀面积分布：r = R·√u（与之前的 u² 完全相反，去除中心线 bug）
      const r = Math.sqrt(u) * radius;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      const alpha = 0.55 + pseudoRandom(segIdx + 31337, stepIdx, d) * 0.3;
      ctx.globalAlpha = alpha;
      ctx.fillRect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize);
    }
  };

  // 单点的 stroke（hold-still 第一帧 / 或所有点重合的 0 长度连续 stamp）
  if (pts.length === 1) {
    stampAt(pts[0].x, pts[0].y, 0, 0);
    ctx.globalAlpha = 1;
    return;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);
    // 0 长度 segment（hold-still 时同一坐标重复入队）：按 1 步处理，
    // 不同 i 的 PRNG 域保证每帧叠新点，浓度自然累积。
    if (dist < 0.01) {
      stampAt(p0.x, p0.y, i, 0);
      continue;
    }
    const steps = Math.max(1, Math.floor(dist / stride));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const cx = p0.x + dx * t;
      const cy = p0.y + dy * t;
      stampAt(cx, cy, i, s);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * 蜡笔：完全不画核心实线（旧版的细黑实线让蜡笔看起来更像「描边+稀疏喷枪」，
 * 用户反馈太丑）。改成沿路径密集铺颗粒，跨垂直方向均匀分布；颗粒大小、alpha
 * 都随 PRNG 抖动，靠堆叠和重叠形成中间近实色 + 边缘自然散开的鳞片感纹理。
 */
function renderCrayon(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  lw: number,
): void {
  if (pts.length < 2) {
    return;
  }
  ctx.fillStyle = color;
  const halfW = lw * 1.0; // 总宽 ~2 lw（粗壮）
  const stride = Math.max(0.6, lw * 0.18); // 极密采样 = 颗粒重叠多，中间近实色
  const grainsPerPos = 6;
  const grainSize = lw * 0.4; // 颗粒尺寸随 lw scale
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.2) {
      continue;
    }
    const ux = dx / dist;
    const uy = dy / dist;
    const perpX = -uy;
    const perpY = ux;
    const steps = Math.max(2, Math.floor(dist / stride));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const cx = p0.x + dx * t;
      const cy = p0.y + dy * t;
      for (let g = 0; g < grainsPerPos; g++) {
        const u = pseudoRandom(i, s, g) * 2 - 1; // [-1, 1) 均匀
        const offset = u * halfW;
        const along = (pseudoRandom(i + 12345, s, g) - 0.5) * stride * 1.6;
        const gx = cx + perpX * offset + ux * along;
        const gy = cy + perpY * offset + uy * along;
        // 颗粒尺寸 + alpha 抖动 = 不规则鳞片纹理
        const sz = grainSize * (0.6 + pseudoRandom(i + 9001, s, g + 11) * 0.7);
        // 中心 alpha 高 / 边缘 alpha 低 + 颗粒间随机抖动
        const dist01 = Math.abs(u);
        const alpha = (1 - dist01 * 0.6) * (0.55 + pseudoRandom(i + 31337, s, g + 23) * 0.4);
        ctx.globalAlpha = alpha;
        ctx.fillRect(gx - sz / 2, gy - sz / 2, sz, sz);
      }
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * 水彩笔：仿 Windows 画图工具的「湿润」笔触感。
 *
 * 关键技术：用 ctx.filter = "blur(...)" 给外层柔边 stroke 加 Gaussian 模糊，
 * 形成自然的边缘渐隐（替代旧版 2/3 层硬叠加 —— 那种讨巧叠加会在小 lw 下
 * 出现可见的同心环 / 双线空心，而 blur 是连续 Gaussian 衰减，无阶梯感）。
 *
 * 之后再叠一层不模糊的稍窄核心，得到「软边 + 实心」的湿笔触观感。
 *
 * 跨端一致：blur(Npx) 是 W3C Filter Effects 规范定义的高斯模糊；现代
 * Chromium / Firefox / Safari 实现一致，blit 后视觉相同。blur 半径按
 * scaledLineWidth 比例 scale，offscreen→visible 缩放后视觉一致。
 */
function renderWatercolor(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  lw: number,
): void {
  if (pts.length === 0) {
    return;
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;

  const drawPath = () => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) {
        ctx.moveTo(pts[i].x, pts[i].y);
      } else {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
    }
    ctx.stroke();
  };

  // 外层柔边：模糊 stroke 形成 Gaussian 衰减边缘
  const prevFilter = ctx.filter;
  const blurRadius = Math.max(0.5, lw * 0.32);
  ctx.filter = `blur(${blurRadius}px)`;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = lw * 1.1;
  drawPath();
  ctx.filter = prevFilter;

  // 核心：不模糊、稍窄、深一些 —— 形成实心笔触感
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = lw * 0.55;
  drawPath();

  ctx.globalAlpha = 1;
}

/** 根据 brushType 派发到具体笔型渲染器。导出供 Toolbar 画笔选择 popover 的 preview 复用。 */
export function renderBrushStroke(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  scaledLineWidth: number,
  brushType: BrushType | undefined,
): void {
  switch (brushType) {
    case "airbrush":
      renderAirbrush(ctx, pts, color, scaledLineWidth);
      return;
    case "crayon":
      renderCrayon(ctx, pts, color, scaledLineWidth);
      return;
    case "watercolor":
      renderWatercolor(ctx, pts, color, scaledLineWidth);
      return;
    case "pen":
    case undefined:
    default:
      renderPenBrush(ctx, pts, color, scaledLineWidth);
  }
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
  // Seed 已经是 fill 色 → 无事可做。
  if (tr === fr && tg === fg && tb === fb) {
    return;
  }
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
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], px, py + (i + 0.5) * lineHeight);
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
    color: string;
    lineWidth: number;
    brushType: BrushType;
  } | null>(null);
  const pendingPointsRef = useRef<Point[]>([]);
  const rafIdRef = useRef<number | null>(null);
  // 框选悬空标记：beginSelection 已把 src 区域涂白、patch 还浮在 overlay 上。
  // 此窗口内禁止 rebuildOffscreen（会把 src 原像素恢复出来，commit 后变重影）。
  const hasPendingSelectionRef = useRef(false);

  // Offscreen canvas — single source of truth for committed strokes.
  // Initialized with an opaque white background so the bucket tool has
  // real pixels to read (transparent pixels would make every fill degenerate).
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  if (offscreenRef.current === null && typeof document !== "undefined") {
    const off = document.createElement("canvas");
    off.width = OFFSCREEN_WIDTH;
    off.height = OFFSCREEN_HEIGHT;
    // willReadFrequently: true → 关闭 GPU 加速，让 getImageData 走 CPU 直读。
    // 油漆桶 / 反走样每次填充都要 readback 整张离屏，标记后浏览器不再重复
    // 警告，且 readback 性能更稳定。
    const offCtx = off.getContext("2d", { willReadFrequently: true });
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

  // 手写字体（Excalifont / Xiaolai）按 unicode-range 子集异步加载：roomState
  // 回放或远端 textStroke 到达时字体可能尚未就绪，文字先以回退字体绘制。
  // 任一批字体加载完成（loadingdone）后整体重建离屏并同步可见画布，替换
  // 回退字形。pen 进行中的 live 笔画只画在 visible 上，下一 RAF 帧会自愈。
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) {
      return;
    }
    const fonts = document.fonts;
    const onFontsLoaded = () => {
      // 框选悬空期跳过：rebuild 会恢复已涂白的 src 像素造成重影。此时不重绘，
      // 字形等下一次全量重建（undo / clear / 撤销框选等）再矫正。
      if (hasPendingSelectionRef.current) {
        return;
      }
      rebuildOffscreen(strokesRef.current);
      syncVisibleFromOffscreen();
    };
    fonts.addEventListener("loadingdone", onFontsLoaded);
    return () => {
      fonts.removeEventListener("loadingdone", onFontsLoaded);
    };
  }, [rebuildOffscreen, syncVisibleFromOffscreen]);

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
      hasPendingSelectionRef.current = true;
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
      hasPendingSelectionRef.current = false;
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
    hasPendingSelectionRef.current = false;
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

    // ========== Pen / Eraser tool ==========
    // 橡皮擦 = 强制白色 + 强制 pen brush 的「特殊 pen」。所有协议、存储、
    // undo 都走现有 pen 笔画路径，不需要特殊消息类型。
    if (tool === "pen" || tool === "eraser") {
      const isEraser = tool === "eraser";
      const effColor = isEraser ? "#ffffff" : color;
      const effBrush: BrushType = isEraser ? "pen" : brushType;
      // 关键：在 visible canvas 上重绘当前 in-progress stroke。
      // 配合 syncVisibleFromOffscreen 使用，每帧 visible = offscreen + 单次绘制的当前 stroke。
      // 旧实现是 ctx.beginPath() once + 每次 mousemove 调 ctx.lineTo + ctx.stroke()，
      // 这会让累积路径反复 stroke，alpha < 1 时透明度叠加成不透明 → 修复。
      const drawInProgressStroke = () => {
        const stroke = currentStrokeRef.current;
        if (!stroke || stroke.points.length === 0) {
          return;
        }
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
          color: effColor,
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
          // 关键：两个数组各自 push **独立的副本**而不是共享同一对象引用
          // —— 与 onMouseMove 一致；避免未来谁误改其中一个连带影响另一个
          currentStrokeRef.current.points.push({ x: lastPos.x, y: lastPos.y });
          pendingPointsRef.current.push({ x: lastPos.x, y: lastPos.y });
          scheduleFlush();
        }, SPRAY_INTERVAL_MS);
      };
      const stopSpray = () => {
        if (sprayInterval !== null) {
          window.clearInterval(sprayInterval);
          sprayInterval = null;
        }
      };

      const onMouseDown = (e: MouseEvent) => {
        if (phase === "guessing" || phase === "revealed") {
          return;
        }
        isDrawingRef.current = true;
        const { x, y } = normalize(e);
        lastPos = { x, y };
        currentStrokeRef.current = {
          points: [{ x, y }],
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
        currentStrokeRef.current?.points.push({ x, y });
        pendingPointsRef.current.push({ x, y });
        scheduleFlush();
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
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push({ x, y });
          const stash = currentStrokeRef.current;
          const finalized: SerializedStroke = {
            points: stash.points,
            color: stash.color,
            lineWidth: stash.lineWidth,
            // 默认 pen 不写字段（保持与历史 stroke 一致）
            ...(stash.brushType !== "pen" ? { brushType: stash.brushType } : {}),
          };
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
        send({ type: "draw", action: "end", x, y, color: effColor, lineWidth });
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
    commitToOffscreen,
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
      };

      // brushType 由服务端透传到所有 action（worker 缓存了 start 时的笔型），
      // 这里直接读 msg.brushType；缺值视作 "pen"。
      const incomingBrush: BrushType = msg.brushType ?? "pen";

      if (msg.action === "start") {
        currentStrokeRef.current = {
          points: [{ x: msg.x, y: msg.y }],
          color: msg.color,
          lineWidth: msg.lineWidth,
          brushType: incomingBrush,
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
          const stash = currentStrokeRef.current;
          const finalized: SerializedStroke = {
            points: stash.points,
            color: stash.color,
            lineWidth: stash.lineWidth,
            ...(stash.brushType !== "pen" ? { brushType: stash.brushType } : {}),
          };
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
      shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart",
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
