/**
 * 复制一段文本，返回是否成功。
 * 剪贴板接口可能不存在（非安全上下文）或被拒绝（页面没有焦点、权限），这时退回 execCommand。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 下面退回旧方法
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // 不管成没成功都删掉：留在页面上的透明文本框会挡住点击、占着焦点
    ta.remove();
  }
}
