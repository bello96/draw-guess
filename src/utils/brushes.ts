// 手绘笔型的渲染器。只依赖传入的 2D context，两端用同样的点序画出同样的结果。
import type { BrushType } from "../types/protocol";

type Point = { x: number; y: number };

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
  base = 0,
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
    if (base === 0) {
      stampAt(pts[0].x, pts[0].y, 0, 0);
      ctx.globalAlpha = 1;
    }
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
      stampAt(p0.x, p0.y, base + i, 0);
      continue;
    }
    const steps = Math.max(1, Math.floor(dist / stride));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const cx = p0.x + dx * t;
      const cy = p0.y + dy * t;
      stampAt(cx, cy, base + i, s);
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
  base = 0,
): void {
  if (pts.length < 2) {
    return;
  }
  ctx.fillStyle = color;
  const halfW = lw * 1.0; // 总宽 ~2 lw（粗壮）
  const stride = Math.max(0.6, lw * 0.18); // 极密采样 = 颗粒重叠多，中间近实色
  const grainsPerPos = 6;
  const grainSize = lw * 0.4; // 颗粒尺寸随 lw scale
  for (let n = 0; n < pts.length - 1; n++) {
    const i = base + n;
    const p0 = pts[n];
    const p1 = pts[n + 1];
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

/** 这两种笔的散点只取决于线段序号和坐标，后面的线段不影响前面已经画的，可以只画新增的部分。 */
export function isIncrementalBrush(brushType: BrushType | undefined): boolean {
  return brushType === "airbrush" || brushType === "crayon";
}

/**
 * 只画一段线段，配合 isIncrementalBrush 用。pts 从第 base 条线段的起点开始。
 * 分几次画完的结果和 renderBrushStroke 一次画完完全一样，因为散点按绝对序号生成。
 */
export function renderBrushSegments(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  scaledLineWidth: number,
  brushType: BrushType | undefined,
  base: number,
): void {
  if (pts.length < 2) {
    return;
  }
  if (brushType === "airbrush") {
    renderAirbrush(ctx, pts, color, scaledLineWidth, base);
  } else if (brushType === "crayon") {
    renderCrayon(ctx, pts, color, scaledLineWidth, base);
  }
}
