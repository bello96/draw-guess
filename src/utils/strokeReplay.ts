// 离屏画布的重放管理。
//
// 画布没法“反绘”某一笔，撤销、删除只能回到更早的状态再往后画。从头画的成本和整幅画成正比，
// 油漆桶多的画一次要上千毫秒。这里记下“画布上现在画到了哪一笔”，再存几张检查点快照：
// - 目标只是多了几笔（落笔、重做）：直接往后画
// - 目标变短或中间变了（撤销、删除）：回到最近的检查点，只补后面的部分
// - 笔画太多一次画不完（新人加入、重连）：调用方给时间预算，分几次画完，不长时间占住主线程
//
// 只依赖下面的接口，不碰 canvas，所以能直接单测。

export interface ReplaySurface<TSnapshot> {
  /** 把当前画面存成快照。reuse 是淘汰下来的旧快照，可以复用它的存储。 */
  snapshot(reuse: TSnapshot | null): TSnapshot;
  /** 把画面恢复成快照；null 表示空白画布。 */
  restore(snapshot: TSnapshot | null): void;
  /** 这份快照不再使用，可以释放存储。 */
  discard(snapshot: TSnapshot): void;
}

export interface StrokeReplayOptions<TStroke, TSnapshot> {
  surface: ReplaySurface<TSnapshot>;
  render: (stroke: TStroke) => void;
  now?: () => number;
  /** 距上一个检查点累计渲染了这么久，就存一个新的。它也是撤销一笔要补画的时间上限。 */
  checkpointCostMs?: number;
  /** 快照张数上限。1600×960 一张约 6 MB。 */
  maxCheckpoints?: number;
}

interface Checkpoint<TSnapshot> {
  /** 快照里画了前多少笔 */
  count: number;
  /** 画到这里累计花的时间 */
  cost: number;
  snapshot: TSnapshot;
}

const DEFAULT_CHECKPOINT_COST_MS = 20;
const DEFAULT_MAX_CHECKPOINTS = 6;

export class StrokeReplay<TStroke, TSnapshot> {
  private readonly surface: ReplaySurface<TSnapshot>;
  private readonly render: (stroke: TStroke) => void;
  private readonly now: () => number;
  private readonly checkpointCostMs: number;
  private readonly maxCheckpoints: number;

  /** 画面上现在的笔画。调用方的数组会被原地修改，这里单独存一份引用来比较。 */
  private rendered: TStroke[] = [];
  /** 按 count 升序。不变式：每个检查点都是 rendered 的前缀画出来的结果。 */
  private checkpoints: Checkpoint<TSnapshot>[] = [];
  private spares: TSnapshot[] = [];
  /** 画 rendered 累计花的时间 */
  private cost = 0;
  /** 画面上有 rendered 推不出来的像素（比如框选把来源涂白了），下一次 sync 必须先恢复。 */
  private tainted = false;

  constructor(options: StrokeReplayOptions<TStroke, TSnapshot>) {
    this.surface = options.surface;
    this.render = options.render;
    this.now = options.now ?? (() => performance.now());
    this.checkpointCostMs = options.checkpointCostMs ?? DEFAULT_CHECKPOINT_COST_MS;
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
  }

  /**
   * 让画面对齐 target（按对象引用比较）。超过 budgetMs 就停下返回 false，
   * 之后再调一次接着画；至少会画一笔，不会原地空转。
   */
  sync(target: readonly TStroke[], budgetMs = Infinity): boolean {
    const common = commonPrefixLength(this.rendered, target);
    if (this.tainted || common < this.rendered.length) {
      this.rewind(common);
    }
    const startedAt = this.now();
    while (this.rendered.length < target.length) {
      const stroke = target[this.rendered.length];
      const before = this.now();
      this.render(stroke);
      const after = this.now();
      this.rendered.push(stroke);
      this.cost += after - before;
      this.addCheckpointIfDue();
      if (after - startedAt >= budgetMs && this.rendered.length < target.length) {
        return false;
      }
    }
    return true;
  }

  /** 外部直接改了画面，改动不是 rendered 能推出来的。 */
  taint(): void {
    this.tainted = true;
  }

  /** 外部的改动已经等于 rendered 的结果了（配合 noteRendered 用）。 */
  untaint(): void {
    this.tainted = false;
  }

  /** 外部已经把这一笔画上去了，这里只记账。 */
  noteRendered(stroke: TStroke): void {
    this.rendered.push(stroke);
  }

  /** 从第 index 笔开始的渲染结果作废（比如字体到了，文字要重画）。下一次 sync 生效。 */
  invalidateFrom(index: number): void {
    this.dropCheckpointsAfter(index);
    this.tainted = true;
  }

  /** 回到空白画布，释放所有快照。 */
  clear(): void {
    for (const checkpoint of this.checkpoints) {
      this.surface.discard(checkpoint.snapshot);
    }
    for (const spare of this.spares) {
      this.surface.discard(spare);
    }
    this.checkpoints = [];
    this.spares = [];
    this.rendered = [];
    this.cost = 0;
    this.tainted = false;
    this.surface.restore(null);
  }

  private rewind(keep: number): void {
    this.dropCheckpointsAfter(keep);
    const latest = this.checkpoints[this.checkpoints.length - 1];
    this.surface.restore(latest ? latest.snapshot : null);
    this.rendered.length = latest ? latest.count : 0;
    this.cost = latest ? latest.cost : 0;
    this.tainted = false;
  }

  private dropCheckpointsAfter(count: number): void {
    while (this.checkpoints.length > 0) {
      const latest = this.checkpoints[this.checkpoints.length - 1];
      if (latest.count <= count) {
        return;
      }
      this.spares.push(latest.snapshot);
      this.checkpoints.pop();
    }
  }

  private addCheckpointIfDue(): void {
    const latest = this.checkpoints[this.checkpoints.length - 1];
    if (this.cost - (latest ? latest.cost : 0) < this.checkpointCostMs) {
      return;
    }
    let reuse: TSnapshot | null = this.spares.pop() ?? null;
    if (reuse === null && this.checkpoints.length >= this.maxCheckpoints) {
      reuse = this.checkpoints.splice(this.pickCheckpointToEvict(), 1)[0].snapshot;
    }
    this.checkpoints.push({
      count: this.rendered.length,
      cost: this.cost,
      snapshot: this.surface.snapshot(reuse),
    });
  }

  /**
   * 张数到上限时淘汰哪一张：比较“去掉它之后留下的空档”和“这个空档离当前末尾有多远”。
   * 撤销多半只退几步，所以离末尾近的要密，远的可以稀疏，空档大致按距离成比例增长。
   */
  private pickCheckpointToEvict(): number {
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < this.checkpoints.length; i++) {
      const prev = i > 0 ? this.checkpoints[i - 1].cost : 0;
      const next = i + 1 < this.checkpoints.length ? this.checkpoints[i + 1].cost : this.cost;
      const score = (next - prev) / (this.cost - next + this.checkpointCostMs);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }
}

function commonPrefixLength<T>(a: readonly T[], b: readonly T[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i++;
  }
  return i;
}
