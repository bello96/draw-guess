/**
 * 把任意合法颜色字符串规范化为小写 6 位或 8 位 hex。
 * 接受 "#rgb" / "#rrggbb" / "#rrggbbaa"（大小写均可），不合法返回 null。
 */
export function normalizeColor(input: string): string | null {
  const m = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(m)) {
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

/**
 * 去掉 alpha 后缀。8 位 hex 截到 6 位，6 位原样返回。
 * 桶（bucket）工具用：alpha 在 flood fill 语义里反直觉，统一去掉。
 */
export function stripAlpha(color: string): string {
  return color.length === 9 ? color.slice(0, 7) : color;
}
