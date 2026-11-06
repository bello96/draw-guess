// 画板文本的手写字体：Excalifont 覆盖英文/数字，Xiaolai（小赖体）覆盖中文。
// 字体在自托管 CDN 上，按 unicode-range 子集懒加载；CDN 不可达时回退 cursive / 系统字体。

export const HAND_FONT_FAMILY = '"Excalifont", "Xiaolai", cursive';

const HAND_FONT_STYLESHEET = "https://fonts.dengjiabei.cn/hand.css";

// document.fonts.check / load 用的探针串。故意不含 cursive：generic family
// 永远视作已加载，带上它 check() 恒为 true，真正需要的网络加载会被跳过。
const HAND_FONT_PROBE = '16px "Excalifont", "Xiaolai"';

let stylesheetLoaded: Promise<void> | null = null;

/**
 * 加载字体的样式表。只有画板用得到，进房间才加载：首页不用等，CDN 慢也不挡首屏。
 * 不管成败都会 resolve，失败就一直用回退字体。
 *
 * 样式表到达之前 check() 找不到字体定义，会直接返回 true，所以这之前画的文字不会触发字体下载。
 * 调用方要在它 resolve 之后把文字重画一遍。
 */
export function loadHandFontStylesheet(): Promise<void> {
  if (stylesheetLoaded) {
    return stylesheetLoaded;
  }
  stylesheetLoaded = new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = HAND_FONT_STYLESHEET;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
  return stylesheetLoaded;
}

/** 下载这些文字要用到的字体子集，全部结束（不管成败）后 resolve。 */
export async function loadHandFonts(texts: string[]): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) {
    return;
  }
  await Promise.allSettled(texts.map((text) => document.fonts.load(HAND_FONT_PROBE, text)));
}

/**
 * 触发 text 所需手写字体子集的下载。canvas 的 fillText 不像 DOM 文本那样会
 * 自动触发 @font-face（unicode-range 子集）加载，必须显式 load；加载完成后
 * 由 useCanvas 里的 "loadingdone" 监听统一重画文字，把回退字形换成手写体。
 */
export function kickHandFontLoad(text: string): void {
  if (typeof document === "undefined" || !document.fonts) {
    return;
  }
  try {
    if (!document.fonts.check(HAND_FONT_PROBE, text)) {
      document.fonts.load(HAND_FONT_PROBE, text).catch(() => {
        // CDN 不可达：维持回退字体渲染，不重试不报错
      });
    }
  } catch {
    // 老浏览器无 FontFaceSet API：直接用回退字体
  }
}
