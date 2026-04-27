/**
 * 把任意合法颜色字符串规范化为小写 6 位 hex。
 * 接受 "#rgb" / "#rrggbb"（大小写均可），不合法返回 null。
 */
export function normalizeColor(input: string): string | null {
  const m = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(m)) {
    return m;
  }
  if (/^#[0-9a-f]{3}$/.test(m)) {
    return (
      "#" +
      m
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    );
  }
  return null;
}
