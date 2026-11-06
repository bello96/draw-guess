import { describe, expect, it } from "vitest";
import { StrokeReplay } from "../../src/utils/strokeReplay";

interface FakeStroke {
  id: number;
  costMs: number;
  /** 模拟字体：渲染结果取决于渲染时的外部状态 */
  usesFont?: boolean;
}

/** 假画布：像素就是已经画上去的内容列表，所以“画面对不对”可以直接比较。 */
class Harness {
  pixels: string[] = [];
  clock = 0;
  renders = 0;
  snapshots = 0;
  restores = 0;
  fontVersion = 1;
  reused: unknown[] = [];
  live = new Set<{ pixels: string[] }>();
  replay: StrokeReplay<FakeStroke, { pixels: string[] }>;

  constructor(opts: { checkpointCostMs?: number; maxCheckpoints?: number } = {}) {
    this.replay = new StrokeReplay<FakeStroke, { pixels: string[] }>({
      surface: {
        snapshot: (reuse) => {
          this.snapshots++;
          if (reuse) {
            this.reused.push(reuse);
          }
          const s = reuse ?? { pixels: [] };
          s.pixels = [...this.pixels];
          this.live.add(s);
          return s;
        },
        restore: (s) => {
          this.restores++;
          this.pixels = s ? [...s.pixels] : [];
        },
        discard: (s) => {
          this.live.delete(s);
        },
      },
      render: (stroke) => {
        this.renders++;
        this.clock += stroke.costMs;
        this.pixels.push(this.pixelOf(stroke));
      },
      now: () => this.clock,
      ...opts,
    });
  }

  pixelOf(stroke: FakeStroke): string {
    return stroke.usesFont ? `${stroke.id}@font${this.fontVersion}` : String(stroke.id);
  }
}

function makeStrokes(n: number, costMs = 10): FakeStroke[] {
  return Array.from({ length: n }, (_, id) => ({ id, costMs }));
}

function ids(strokes: FakeStroke[]): string[] {
  return strokes.map((s) => String(s.id));
}

describe("StrokeReplay", () => {
  it("画面和目标笔画序列一致", () => {
    const h = new Harness();
    const strokes = makeStrokes(5);
    expect(h.replay.sync(strokes)).toBe(true);
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("末尾追加只画新的一笔", () => {
    const h = new Harness();
    const strokes = makeStrokes(50);
    h.replay.sync(strokes);
    h.renders = 0;
    strokes.push({ id: 999, costMs: 10 });
    h.replay.sync(strokes);
    expect(h.renders).toBe(1);
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("目标不变时什么都不画", () => {
    const h = new Harness();
    const strokes = makeStrokes(10);
    h.replay.sync(strokes);
    h.renders = 0;
    h.restores = 0;
    h.replay.sync([...strokes]);
    expect(h.renders).toBe(0);
    expect(h.restores).toBe(0);
  });

  it("撤销一笔时从最近的检查点接着画，不从头重放", () => {
    const h = new Harness({ checkpointCostMs: 20 });
    const strokes = makeStrokes(200);
    h.replay.sync(strokes);
    h.renders = 0;
    strokes.pop();
    h.replay.sync([...strokes]);
    expect(h.pixels).toEqual(ids(strokes));
    // 阈值 20ms = 2 笔。淘汰之后末尾附近的间距最多翻倍，所以补画不超过 4 笔，不是 199 笔。
    expect(h.renders).toBeLessThanOrEqual(4);
  });

  it("连续撤销到空，每一步画面都对，总渲染量远小于每次全量重放", () => {
    const h = new Harness({ checkpointCostMs: 20, maxCheckpoints: 6 });
    const strokes = makeStrokes(200);
    h.replay.sync(strokes);
    h.renders = 0;
    while (strokes.length > 0) {
      strokes.pop();
      h.replay.sync([...strokes]);
      expect(h.pixels).toEqual(ids(strokes));
    }
    // 每次全量重放是 199+198+...+0 = 19900 次
    expect(h.renders).toBeLessThan(2000);
  });

  it("撤销后重做只画重做的那一笔", () => {
    const h = new Harness({ checkpointCostMs: 20 });
    const strokes = makeStrokes(100);
    h.replay.sync(strokes);
    const popped = strokes.pop()!;
    h.replay.sync([...strokes]);
    h.renders = 0;
    strokes.push(popped);
    h.replay.sync([...strokes]);
    expect(h.renders).toBe(1);
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("删掉中间一笔后，只重放删除点之后的部分", () => {
    const h = new Harness({ checkpointCostMs: 20, maxCheckpoints: 50 });
    const strokes = makeStrokes(100);
    h.replay.sync(strokes);
    h.renders = 0;
    strokes.splice(90, 1);
    h.replay.sync([...strokes]);
    expect(h.pixels).toEqual(ids(strokes));
    // 删除点之后 9 笔，加上回到最近检查点最多补 2 笔
    expect(h.renders).toBeLessThanOrEqual(11);
  });

  it("画得便宜时不存检查点，不占内存", () => {
    const h = new Harness({ checkpointCostMs: 20 });
    h.replay.sync(makeStrokes(10, 1));
    expect(h.snapshots).toBe(0);
  });

  it("检查点数量不超过上限，淘汰下来的存储会复用", () => {
    const h = new Harness({ checkpointCostMs: 10, maxCheckpoints: 4 });
    h.replay.sync(makeStrokes(500));
    expect(h.live.size).toBeLessThanOrEqual(4);
    expect(h.snapshots).toBeGreaterThan(4);
    expect(h.reused.length).toBeGreaterThan(0);
  });

  it("上限内的检查点离末尾越近越密：退回得越近，要重画的越少", () => {
    const h = new Harness({ checkpointCostMs: 10, maxCheckpoints: 6 });
    const strokes = makeStrokes(5000);
    h.replay.sync(strokes);
    for (const back of [1, 2, 5, 20, 100, 500]) {
      const h2 = new Harness({ checkpointCostMs: 10, maxCheckpoints: 6 });
      const s2 = makeStrokes(5000);
      h2.replay.sync(s2);
      h2.renders = 0;
      h2.replay.sync(s2.slice(0, s2.length - back));
      // 退回 back 笔时要补画的笔数，不应该超过 back 的常数倍（再加检查点间距的余量）
      expect(h2.renders).toBeLessThanOrEqual(10 * back + 10);
    }
  });

  it("笔画对象全换了（重连收到全量状态）：丢掉旧检查点，全量重放", () => {
    const h = new Harness({ checkpointCostMs: 20 });
    h.replay.sync(makeStrokes(50));
    const fresh = makeStrokes(30).map((s) => ({ ...s, id: s.id + 1000 }));
    h.renders = 0;
    h.replay.sync(fresh);
    expect(h.renders).toBe(30);
    expect(h.pixels).toEqual(ids(fresh));
  });

  it("画面被外部改过（taint）：下一次 sync 恢复到干净状态，哪怕笔画没变", () => {
    const h = new Harness({ checkpointCostMs: 20 });
    const strokes = makeStrokes(10);
    h.replay.sync(strokes);
    h.pixels.push("框选涂白");
    h.replay.taint();
    h.replay.sync(strokes);
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("taint 期间不存检查点，脏像素不会混进快照", () => {
    const h = new Harness({ checkpointCostMs: 10 });
    const strokes = makeStrokes(3);
    h.replay.sync(strokes);
    h.pixels.push("框选涂白");
    h.replay.taint();
    const more = [...strokes, ...makeStrokes(5).map((s) => ({ ...s, id: s.id + 100 }))];
    h.replay.sync(more);
    expect(h.pixels).toEqual(ids(more));
    for (const s of h.live) {
      expect(s.pixels.includes("框选涂白")).toBe(false);
    }
  });

  it("untaint：外部改动正好等于这一笔的结果，记下来就行，不重画", () => {
    const h = new Harness({ checkpointCostMs: 20 });
    const strokes = makeStrokes(5);
    h.replay.sync(strokes);
    h.replay.taint();
    const pasted: FakeStroke = { id: 77, costMs: 10 };
    h.pixels.push("77");
    h.replay.noteRendered(pasted);
    h.replay.untaint();
    strokes.push(pasted);
    h.renders = 0;
    h.restores = 0;
    h.replay.sync(strokes);
    expect(h.renders).toBe(0);
    expect(h.restores).toBe(0);
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("invalidateFrom：字体到了，只重画第一条文字之后的部分，旧快照不再使用", () => {
    const h = new Harness({ checkpointCostMs: 20, maxCheckpoints: 50 });
    const strokes = makeStrokes(100);
    strokes[60] = { id: 60, costMs: 10, usesFont: true };
    h.replay.sync(strokes);
    expect(h.pixels[60]).toBe("60@font1");
    h.fontVersion = 2;
    h.renders = 0;
    h.replay.invalidateFrom(60);
    h.replay.sync(strokes);
    expect(h.pixels[60]).toBe("60@font2");
    expect(h.pixels.length).toBe(100);
    // 第 60 笔之前不用重画（最多补检查点间距内的 2 笔）
    expect(h.renders).toBeLessThanOrEqual(42);
  });

  it("预算用完就停，下次接着画，不重复也不遗漏", () => {
    const h = new Harness();
    const strokes = makeStrokes(10, 10);
    expect(h.replay.sync(strokes, 25)).toBe(false);
    const after1 = h.renders;
    expect(after1).toBeGreaterThanOrEqual(1);
    expect(after1).toBeLessThan(10);
    expect(h.pixels).toEqual(ids(strokes.slice(0, after1)));
    let rounds = 0;
    while (!h.replay.sync(strokes, 25)) {
      rounds++;
      expect(rounds).toBeLessThan(20);
    }
    expect(h.renders).toBe(10);
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("预算为 0 也至少画一笔，不会原地空转", () => {
    const h = new Harness();
    const strokes = makeStrokes(3);
    let rounds = 0;
    while (!h.replay.sync(strokes, 0)) {
      rounds++;
      expect(rounds).toBeLessThan(5);
    }
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("分片重放途中目标变了，最后仍然对齐", () => {
    const h = new Harness({ checkpointCostMs: 20 });
    const strokes = makeStrokes(40);
    expect(h.replay.sync(strokes, 15)).toBe(false);
    const shorter = strokes.slice(0, 5);
    while (!h.replay.sync(shorter, 15)) {
      // 继续
    }
    expect(h.pixels).toEqual(ids(shorter));
    const extended = [...shorter, { id: 500, costMs: 10 }];
    while (!h.replay.sync(extended, 15)) {
      // 继续
    }
    expect(h.pixels).toEqual(ids(extended));
  });

  it("clear：回到空白，检查点全部释放", () => {
    const h = new Harness({ checkpointCostMs: 10, maxCheckpoints: 4 });
    h.replay.sync(makeStrokes(100));
    h.replay.clear();
    expect(h.pixels).toEqual([]);
    expect(h.live.size).toBe(0);
    const strokes = makeStrokes(3);
    h.renders = 0;
    h.replay.sync(strokes);
    expect(h.renders).toBe(3);
    expect(h.pixels).toEqual(ids(strokes));
  });

  it("模型检查：随机操作序列下，画面始终等于从头重放的结果", () => {
    for (let seed = 1; seed <= 40; seed++) {
      let state = seed * 2654435761;
      const rnd = (n: number) => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state % n;
      };
      const h = new Harness({ checkpointCostMs: 15, maxCheckpoints: 1 + rnd(6) });
      let strokes: FakeStroke[] = [];
      const redo: FakeStroke[] = [];
      let nextId = 0;
      for (let step = 0; step < 300; step++) {
        const op = rnd(100);
        if (op < 45) {
          strokes.push({ id: nextId++, costMs: 1 + rnd(30), usesFont: rnd(10) === 0 });
          redo.length = 0;
        } else if (op < 65) {
          const s = strokes.pop();
          if (s) {
            redo.push(s);
          }
        } else if (op < 80) {
          const s = redo.pop();
          if (s) {
            strokes.push(s);
          }
        } else if (op < 87) {
          if (strokes.length > 0) {
            strokes.splice(rnd(strokes.length), 1);
          }
          redo.length = 0;
        } else if (op < 90) {
          // 重连：同样的内容，全新的对象
          strokes = strokes.map((s) => ({ ...s }));
          redo.length = 0;
        } else if (op < 93) {
          strokes = [];
          redo.length = 0;
          h.replay.clear();
        } else if (op < 96) {
          h.fontVersion++;
          const first = strokes.findIndex((s) => s.usesFont);
          if (first !== -1) {
            h.replay.invalidateFrom(first);
          }
          // 字体变了，后面比较时前面那段没有文字，不受影响；文字都要是新版本
        } else {
          h.pixels.push("脏");
          h.replay.taint();
        }
        const budget = rnd(3) === 0 ? 10 : Infinity;
        if (rnd(4) !== 0 || budget === Infinity) {
          let guard = 0;
          while (!h.replay.sync(strokes, budget)) {
            guard++;
            expect(guard).toBeLessThan(2000);
          }
          // 文字的版本可能比当前旧（字体变化时没有文字在画面上的情况不会触发 invalidate），只比较 id
          expect(h.pixels.map((p) => p.split("@")[0])).toEqual(ids(strokes));
          expect(h.pixels.includes("脏")).toBe(false);
        } else {
          h.replay.sync(strokes, budget);
        }
        expect(h.live.size).toBeLessThanOrEqual(6);
      }
    }
  });
});
