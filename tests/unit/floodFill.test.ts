import { describe, expect, it } from "vitest";
import { floodFill } from "../../src/utils/floodFill";

type Rgb = [number, number, number];

const W = 400;
const H = 300;
const RED: Rgb = [255, 0, 0];
const BLACK: Rgb = [0, 0, 0];

function blank(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H * 4).fill(255);
}

function rect(d: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
}

/** 空心框，线宽 t：框内的区域和外面不连通。 */
function box(d: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, t = 4): void {
  rect(d, x0, y0, x1, y0 + t, BLACK);
  rect(d, x0, y1 - t, x1, y1, BLACK);
  rect(d, x0, y0, x0 + t, y1, BLACK);
  rect(d, x1 - t, y0, x1, y1, BLACK);
}

function px(d: Uint8ClampedArray, x: number, y: number): number[] {
  const i = (y * W + x) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

function fillRed(d: Uint8ClampedArray, x: number, y: number) {
  return floodFill(d, W, H, x, y, RED[0], RED[1], RED[2], 32);
}

describe("floodFill", () => {
  it("把种子所在的连通区域涂成填充色，框外不动", () => {
    const d = blank();
    box(d, 10, 10, 60, 60);
    fillRed(d, 30, 30);
    expect(px(d, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(px(d, 14, 14)).toEqual([255, 0, 0, 255]);
    expect(px(d, 100, 100)).toEqual([255, 255, 255, 255]);
    expect(px(d, 10, 10)).toEqual([0, 0, 0, 255]);
  });

  it("不改写和填充区域不连通的同色块", () => {
    const d = blank();
    box(d, 10, 10, 60, 60);
    rect(d, 200, 100, 250, 150, RED);
    const before = d.slice();
    fillRed(d, 30, 30);
    let changedOutsideBox = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 70; x < W; x++) {
        if (px(d, x, y).join() !== px(before, x, y).join()) {
          changedOutsideBox++;
        }
      }
    }
    expect(changedOutsideBox).toBe(0);
  });

  it("连续填充同一种颜色，旧色块不会一圈圈变大", () => {
    const d = blank();
    rect(d, 200, 100, 250, 150, RED);
    box(d, 10, 10, 60, 60);
    box(d, 70, 10, 120, 60);
    box(d, 10, 70, 60, 120);
    fillRed(d, 30, 30);
    fillRed(d, 90, 30);
    fillRed(d, 30, 90);
    expect(px(d, 199, 125)).toEqual([255, 255, 255, 255]);
    expect(px(d, 250, 125)).toEqual([255, 255, 255, 255]);
    expect(px(d, 225, 99)).toEqual([255, 255, 255, 255]);
    expect(px(d, 225, 150)).toEqual([255, 255, 255, 255]);
  });

  it("描边边缘的过渡像素按离背景色的距离混入填充色，消除白边", () => {
    const d = blank();
    box(d, 10, 10, 60, 60);
    // 框内一行 1px 灰（模拟描边的抗锯齿边缘），灰度 215 超出容差 32，填不到，只靠边缘混合
    rect(d, 14, 14, 56, 15, [215, 215, 215]);
    fillRed(d, 30, 30);
    // 距离 40，alpha = 1 - 40/96 = 0.5833：R = 215*0.4167 + 255*0.5833 = 238.3，G = B = 89.6
    expect(px(d, 30, 14)).toEqual([238, 90, 90, 255]);
  });

  it("离背景色足够远的描边核心不混合", () => {
    const d = blank();
    box(d, 10, 10, 60, 60);
    fillRed(d, 30, 30);
    expect(px(d, 13, 30)).toEqual([0, 0, 0, 255]);
  });

  it("填充色和目标色在容差内但不相等时能结束，连通像素都被涂到", () => {
    const d = blank();
    box(d, 10, 10, 60, 60);
    floodFill(d, W, H, 30, 30, 250, 250, 250, 32);
    expect(px(d, 30, 30)).toEqual([250, 250, 250, 255]);
    expect(px(d, 55, 55)).toEqual([250, 250, 250, 255]);
    expect(px(d, 100, 100)).toEqual([255, 255, 255, 255]);
  });

  it("种子已经是填充色时什么都不做", () => {
    const d = blank();
    rect(d, 20, 20, 40, 40, RED);
    const before = d.slice();
    expect(fillRed(d, 30, 30)).toBeNull();
    expect(d.join()).toBe(before.join());
  });

  it("返回的脏矩形包住所有被改动的像素，且不比填充区域大多少", () => {
    const d = blank();
    box(d, 10, 10, 60, 60);
    rect(d, 14, 14, 56, 15, [215, 215, 215]);
    const before = d.slice();
    const dirty = fillRed(d, 30, 30);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (px(d, x, y).join() !== px(before, x, y).join()) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    expect(dirty).not.toBeNull();
    expect(dirty!.x).toBeLessThanOrEqual(minX);
    expect(dirty!.y).toBeLessThanOrEqual(minY);
    expect(dirty!.x + dirty!.w).toBeGreaterThan(maxX);
    expect(dirty!.y + dirty!.h).toBeGreaterThan(maxY);
    // 框的外沿是 50×50，边缘混合最多外扩到框上，脏矩形不会更大
    expect(dirty!.w).toBeLessThanOrEqual(50);
    expect(dirty!.h).toBeLessThanOrEqual(50);
  });

  it("填满整张画布时脏矩形就是整张画布，贴边也不越界", () => {
    const d = blank();
    expect(fillRed(d, 0, 0)).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(px(d, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(d, W - 1, H - 1)).toEqual([255, 0, 0, 255]);
  });
});
