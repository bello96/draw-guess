import { useEffect, useRef, useState } from "react";
import { tx } from "@twind/core";

// =========================================================================
// 可调参数 —— 改这里直接生效（npm run dev 下 Vite HMR 会热更新，刷新页面即可）
// =========================================================================

/** 碎片总数。越多越密，越多越耗 CPU。 */
const PIECE_COUNT = 250;

/** 最后一片碎片出现的最晚时间（ms）。所有碎片的出现时间随机分布在 [0, MAX_DELAY_MS] 内。 */
const MAX_DELAY_MS = 2000;

/** 延迟分布的指数。1=均匀，2=开头密/末尾稀（当前默认），3=更集中在开头。 */
const DELAY_DISTRIBUTION_POWER = 2;

/** 单片从出现到落到屏幕外的时长区间（ms）。 */
const DURATION_MIN_MS = 2500;
const DURATION_MAX_MS = 4000;

/** 水平摇摆幅度（像素）。每片在 [-SWAY_AMPLITUDE_PX, +SWAY_AMPLITUDE_PX] 中随机取一个方向和大小。 */
const SWAY_AMPLITUDE_PX = 50;

/** 碎片边长（像素）区间。 */
const SIZE_MIN_PX = 5;
const SIZE_MAX_PX = 10;

/** 下落过程中每片自转的圈数。1 圈 = 360°。 */
const ROTATION_TURNS = 1;

/** 开始淡出的时间点（0-1）。小于该进度保持不透明，之后线性淡出到 0。 */
const FADE_START_PROGRESS = 1;

/** 可出现的形状。移除其中某项可以让所有碎片都是同一形状。 */
const SHAPES: ConfettiShape[] = ["circle", "rect", "strip"];

/** 颜色池。每片随机取一个。 */
const COLORS = [
  "#ff4757",
  "#ff6b81",
  "#ffa502",
  "#ffd32a",
  "#1e90ff",
  "#48dbfb",
  "#e056fd",
  "#f368e0",
  "#2ed573",
  "#7bed9f",
  "#ff6348",
  "#fab1a0",
  "#a29bfe",
  "#6c5ce7",
  "#fdcb6e",
  "#00cec9",
  "#fd79a8",
  "#e84393",
  "#ff9ff3",
  "#54a0ff",
  "#00d2d3",
  "#ee5a24",
];

// =========================================================================

type ConfettiShape = "circle" | "rect" | "strip";

interface ConfettiPiece {
  startX: number; // px
  delay: number; // ms
  duration: number; // ms
  sway: number; // px
  color: string;
  size: number;
  shape: ConfettiShape;
  rotationStart: number; // rad
}

function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function createConfetti(count: number, width: number): ConfettiPiece[] {
  const durRange = DURATION_MAX_MS - DURATION_MIN_MS;
  const sizeRange = SIZE_MAX_PX - SIZE_MIN_PX;
  return Array.from({ length: count }, () => {
    const r = Math.random();
    return {
      startX: Math.random() * width,
      delay: Math.pow(r, DELAY_DISTRIBUTION_POWER) * MAX_DELAY_MS,
      duration: DURATION_MIN_MS + Math.random() * durRange,
      sway: -SWAY_AMPLITUDE_PX + Math.random() * 2 * SWAY_AMPLITUDE_PX,
      color: pickColor(),
      size: SIZE_MIN_PX + Math.random() * sizeRange,
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
      rotationStart: Math.random() * Math.PI * 2,
    };
  });
}

function drawConfettiPiece(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  piece: ConfettiPiece,
  alpha: number,
  rotation: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.fillStyle = piece.color;
  if (piece.shape === "circle") {
    ctx.beginPath();
    ctx.arc(0, 0, piece.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (piece.shape === "rect") {
    ctx.fillRect(-piece.size / 2, (-piece.size * 0.6) / 2, piece.size, piece.size * 0.6);
  } else {
    const w = piece.size * 0.35;
    const h = piece.size * 1.8;
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

export default function Confetti() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const setSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    setSize();

    const confetti = createConfetti(PIECE_COUNT, canvas.width);
    const startT = performance.now();
    let rafId: number | null = null;

    const tick = (now: number) => {
      const elapsed = now - startT;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = 0;

      for (const p of confetti) {
        if (elapsed < p.delay) {
          alive++;
          continue;
        }
        const localT = elapsed - p.delay;
        if (localT >= p.duration) {
          continue;
        }
        alive++;
        const progress = localT / p.duration;
        // 从屏幕顶部稍上方落到屏幕底部稍下方
        const y = -20 + progress * (canvas.height + 40);
        // 前半段摇出去，后半段部分往回摆
        const swayMul = progress < 0.5 ? progress * 2 : 1 - (progress - 0.5) * 1.5;
        const x = p.startX + p.sway * swayMul;
        const alpha =
          progress < FADE_START_PROGRESS
            ? 1
            : Math.max(0, (1 - progress) / (1 - FADE_START_PROGRESS));
        const rotation = p.rotationStart + progress * Math.PI * 2 * ROTATION_TURNS;
        drawConfettiPiece(ctx, x, y, p, alpha, rotation);
      }

      if (alive === 0) {
        setVisible(false);
        return;
      }
      rafId = requestAnimationFrame(tick);
    };

    const onResize = () => setSize();
    window.addEventListener("resize", onResize);

    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      window.removeEventListener("resize", onResize);
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className={tx("fixed inset-0 pointer-events-none")}
      style={{ zIndex: 9999 }}
    />
  );
}
