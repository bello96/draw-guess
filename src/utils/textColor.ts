import type { TextColorRange } from "../types/protocol";

// 文本局部上色的区间工具（纯函数，被 useCanvas 渲染与 Canvas 编辑层共用）。
// 区间为字符索引 [start, end)，按整段文本计数（含 \n）。约定互不重叠、
// 按 start 升序；未覆盖的字符用笔画默认色。

/** 裁剪非法值、排序、合并相邻同色区间。 */
export function normalizeRanges(ranges: TextColorRange[], textLength: number): TextColorRange[] {
  const sorted = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, textLength)),
      end: Math.max(0, Math.min(r.end, textLength)),
      color: r.color,
    }))
    .filter((r) => r.start < r.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextColorRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.end === r.start && last.color === r.color) {
      merged[merged.length - 1] = { ...last, end: r.end };
    } else {
      merged.push(r);
    }
  }
  return merged;
}

/** 把 [start, end) 上成 color：切掉与既有区间的重叠部分后插入新区间。 */
export function applyColorToRanges(
  ranges: TextColorRange[],
  start: number,
  end: number,
  color: string,
  textLength: number,
): TextColorRange[] {
  const out: TextColorRange[] = [];
  for (const r of ranges) {
    if (r.end <= start || r.start >= end) {
      out.push(r);
      continue;
    }
    if (r.start < start) {
      out.push({ start: r.start, end: start, color: r.color });
    }
    if (r.end > end) {
      out.push({ start: end, end: r.end, color: r.color });
    }
  }
  out.push({ start, end, color });
  return normalizeRanges(out, textLength);
}

/**
 * 文本单次连续编辑（输入 / 删除 / 选区替换 / 粘贴）后平移颜色区间。
 * 用公共前缀/后缀定位变更段。纯插入发生在某区间内部时该区间随之扩张
 * （颜色跟随续打）；替换段完整落在某区间内部时区间整体伸缩（IME 组词
 * 提交、选中一段重打都继承颜色，与常见富文本编辑器一致）；其余情况
 * 切掉被替换的部分，新插入字符用默认色。
 */
export function adjustRangesForTextChange(
  ranges: TextColorRange[],
  oldText: string,
  newText: string,
): TextColorRange[] {
  if (ranges.length === 0 || oldText === newText) {
    return ranges;
  }
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldEnd = oldText.length - suffix; // 旧文本被替换段 [prefix, oldEnd)
  const insertLen = newText.length - suffix - prefix;
  const delta = newText.length - oldText.length;
  const isPureInsert = oldEnd === prefix;

  const out: TextColorRange[] = [];
  for (const r of ranges) {
    if (r.end <= prefix) {
      out.push(r);
      continue;
    }
    if (r.start >= oldEnd) {
      out.push({ start: r.start + delta, end: r.end + delta, color: r.color });
      continue;
    }
    if (isPureInsert && r.start < prefix && prefix < r.end) {
      out.push({ start: r.start, end: r.end + insertLen, color: r.color });
      continue;
    }
    // 替换段被该区间完整覆盖：区间随 delta 整体伸缩，替换文本继承区间色。
    // 典型路径是 IME 组词——拼音预编辑串在区间内逐字符纯插入（上一分支已
    // 扩张），提交时候选词替换预编辑串；若走切残段逻辑，提交的字符会掉色。
    // 区间被整段删空时 end+delta === start，由 normalizeRanges 过滤。
    if (!isPureInsert && r.start <= prefix && r.end >= oldEnd) {
      out.push({ start: r.start, end: r.end + delta, color: r.color });
      continue;
    }
    const leftEnd = Math.min(r.end, prefix);
    if (r.start < leftEnd) {
      out.push({ start: r.start, end: leftEnd, color: r.color });
    }
    const rightStart = Math.max(r.start, oldEnd);
    if (rightStart < r.end) {
      out.push({ start: rightStart + delta, end: r.end + delta, color: r.color });
    }
  }
  return normalizeRanges(out, newText.length);
}

/**
 * 把一行文本按颜色区间切成 (text, color) 段；color 为 null 表示用默认色。
 * lineStart 是该行首字符在整段文本中的索引。对 ranges 不要求预排序
 * （远端数据防御性排序一次）。
 */
export function lineSegments(
  line: string,
  lineStart: number,
  ranges: TextColorRange[],
): { text: string; color: string | null }[] {
  if (line.length === 0) {
    return [];
  }
  const lineEnd = lineStart + line.length;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const segs: { text: string; color: string | null }[] = [];
  let pos = 0;
  for (const r of sorted) {
    if (r.end <= lineStart || r.start >= lineEnd) {
      continue;
    }
    const s = Math.max(Math.max(r.start, lineStart) - lineStart, pos);
    const e = Math.min(r.end, lineEnd) - lineStart;
    if (s > pos) {
      segs.push({ text: line.slice(pos, s), color: null });
    }
    if (e > s) {
      segs.push({ text: line.slice(s, e), color: r.color });
    }
    pos = Math.max(pos, e);
  }
  if (pos < line.length) {
    segs.push({ text: line.slice(pos), color: null });
  }
  return segs;
}
