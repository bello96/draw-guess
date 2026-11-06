import { describe, expect, it } from "vitest";
import { withClickDot } from "../../src/utils/strokePoints";

describe("withClickDot：原地单击的笔画补一个点", () => {
  it("所有点重合时，在右边 offset 处补一个点", () => {
    const pts = [
      { x: 0.5, y: 0.25 },
      { x: 0.5, y: 0.25 },
    ];
    expect(withClickDot(pts, 0.001, 100)).toEqual([
      { x: 0.5, y: 0.25 },
      { x: 0.5, y: 0.25 },
      { x: 0.501, y: 0.25 },
    ]);
  });

  it("动过的笔画不动", () => {
    const pts = [
      { x: 0.5, y: 0.25 },
      { x: 0.6, y: 0.25 },
    ];
    expect(withClickDot(pts, 0.001, 100)).toEqual([
      { x: 0.5, y: 0.25 },
      { x: 0.6, y: 0.25 },
    ]);
  });

  it("点数已经到上限就不补（喷枪原地按住很久），服务端不收超过上限的笔画", () => {
    const pts = Array.from({ length: 5 }, () => ({ x: 0.5, y: 0.5 }));
    expect(withClickDot(pts, 0.001, 5)).toHaveLength(5);
  });

  it("差一个到上限时还能补，补完正好到上限", () => {
    const pts = Array.from({ length: 4 }, () => ({ x: 0.5, y: 0.5 }));
    expect(withClickDot(pts, 0.001, 5)).toHaveLength(5);
  });

  it("不改传进来的数组", () => {
    const pts = [
      { x: 0.1, y: 0.1 },
      { x: 0.1, y: 0.1 },
    ];
    withClickDot(pts, 0.001, 100);
    expect(pts).toHaveLength(2);
  });

  it("空笔画原样返回", () => {
    expect(withClickDot([], 0.001, 100)).toEqual([]);
  });
});
