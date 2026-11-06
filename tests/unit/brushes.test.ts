import { describe, expect, it } from "vitest";
import { renderBrushSegments, renderBrushStroke } from "../../src/utils/brushes";

type Point = { x: number; y: number };

/** 记录画了什么的假 context。喷枪、蜡笔只用 fillRect。 */
function recordingCtx() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "",
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push([x, y, w, h, this.globalAlpha, this.fillStyle].join(","));
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function path(n: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({ x: 100 + 300 * Math.sin(i / 7), y: 200 + 150 * Math.cos(i / 5) });
  }
  // 中间夹几个重合的点：喷枪按住不动时就是这样
  pts.splice(10, 0, { ...pts[10] }, { ...pts[10] });
  return pts;
}

describe.each(["airbrush", "crayon"] as const)("%s 增量渲染", (brush) => {
  it("分几段画和一次画完，落笔顺序和位置完全一样", () => {
    const pts = path(40);
    const full = recordingCtx();
    renderBrushStroke(full.ctx, pts, "#123456", 8, brush);
    expect(full.calls.length).toBeGreaterThan(100);

    const parts = recordingCtx();
    let drawn = 0;
    for (const end of [2, 3, 11, 12, 13, 25, pts.length]) {
      // 只传还没画的部分，带上上一段的终点
      renderBrushSegments(parts.ctx, pts.slice(drawn, end), "#123456", 8, brush, drawn);
      drawn = end - 1;
    }
    expect(parts.calls).toEqual(full.calls);
  });

  it("画完把 globalAlpha 还原", () => {
    const { ctx } = recordingCtx();
    renderBrushSegments(ctx, path(5), "#000000", 8, brush, 3);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("只有一个点时没有线段可画", () => {
    const { ctx, calls } = recordingCtx();
    renderBrushSegments(ctx, [{ x: 10, y: 10 }], "#000000", 8, brush, 5);
    expect(calls.length).toBe(0);
  });
});
