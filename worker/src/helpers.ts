// Pure functions used by GameRoom. No DO state access — safe to unit-test
// without a Cloudflare runtime.

import { REDO_KEY_PREFIX, STROKE_INDEX_PAD, STROKE_KEY_PREFIX } from "./constants";
import type { SerializedStroke } from "./types";

/** Storage key for an individual stroke at `index`. Zero-padded for ordered list(). */
export function strokeKey(index: number): string {
  return STROKE_KEY_PREFIX + String(index).padStart(STROKE_INDEX_PAD, "0");
}

/** Storage key for the undone stroke at stack position `index`. */
export function redoKey(index: number): string {
  return REDO_KEY_PREFIX + String(index).padStart(STROKE_INDEX_PAD, "0");
}

/** 折线的累计长度，单位是归一化坐标（1 约等于一个画布宽）。 */
export function pathLength(points: { x: number; y: number }[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

/**
 * 入口统一记错误。线上不记调用日志（见 wrangler.toml），没有这个就查不到报错。
 * 只记入口名和异常本身，不写消息内容。错误继续往外抛，行为和不包一样。
 */
export async function logFailure<T>(where: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`${where} failed`, err);
    throw err;
  }
}

const strokeCosts = new WeakMap<SerializedStroke, number>();

/**
 * 一笔占用多少房间预算（MAX_ROOM_STROKE_COST）。大致按全量重放的耗时和内存算：手绘看路径长度
 * （蜡笔、喷枪的渲染成本和它成正比）和点数，填充、框选要读写整张画布，其他类型很便宜。
 */
export function strokeCost(stroke: SerializedStroke): number {
  const cached = strokeCosts.get(stroke);
  if (cached !== undefined) {
    return cached;
  }
  let cost = 0.1;
  if (stroke.fill || stroke.selection) {
    cost += 5;
  } else if (!stroke.shape && !stroke.text && Array.isArray(stroke.points)) {
    cost += pathLength(stroke.points) + stroke.points.length / 200;
  }
  strokeCosts.set(stroke, cost);
  return cost;
}

/**
 * Normalize text for answer comparison. Handles common "should match" variants:
 * - NFKC: full-width → half-width, compatibility forms
 * - lowercase: English case-insensitive
 * - strip all whitespace (incl. CJK full-width space U+3000)
 * - strip Unicode punctuation (keeps letters, digits, emoji/symbols)
 *
 * Raw answer is stored as-is so the drawer sees what they typed; normalization
 * runs at compare-time only.
 */
export function normalizeForCompare(s: string): string {
  return stripForCompare(s).replace(/\p{P}/gu, "");
}

function stripForCompare(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/**
 * Whether a guess matches the answer. An answer made only of punctuation normalizes
 * to nothing, so any punctuation-only guess would match it; compare with the
 * punctuation kept in that case.
 */
export function answerMatches(guess: string, answer: string): boolean {
  const normalizedAnswer = normalizeForCompare(answer);
  if (normalizedAnswer === "") {
    return stripForCompare(guess) === stripForCompare(answer);
  }
  return normalizeForCompare(guess) === normalizedAnswer;
}
