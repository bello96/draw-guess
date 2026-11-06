type Point = { x: number; y: number };

/**
 * 原地单击（所有点重合）的笔画补一个往右 offset 的点，让它画得出来：零长度线段 Chromium 不画圆头，
 * 蜡笔也只沿线段铺颗粒，画笔、水彩、蜡笔单击都画不出东西，却会进撤销栈。
 * 点数到了上限就不补（喷枪原地按住很久也是所有点重合），服务端不收超过上限的笔画。
 * 改的是笔画数据，不是渲染，旧版页面画出来也一样。返回新数组，不改传进来的。
 */
export function withClickDot(points: Point[], offset: number, maxPoints: number): Point[] {
  if (points.length === 0 || points.length >= maxPoints) {
    return points;
  }
  const first = points[0];
  if (!points.every((p) => p.x === first.x && p.y === first.y)) {
    return points;
  }
  return [...points, { x: first.x + offset, y: first.y }];
}
