import { tx } from "@twind/core";

const DISMISSED_KEY = "draw-guess-touch-continue";

// Safari 阻止所有 Cookie 时，一碰 sessionStorage 就抛 SecurityError。首屏渲染就要读它，不能让整页进错误页
function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 只有触屏、没有鼠标或触控板的设备（手机、不接鼠标的平板）。画板只接鼠标事件，这种设备画不了，
 * 页面也是按桌面宽度排的。不认识这两个媒体特性的老浏览器两个都是 false，不会误判。
 */
export function shouldShowTouchNotice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  const touchOnly =
    window.matchMedia("(any-pointer: coarse)").matches &&
    !window.matchMedia("(any-pointer: fine)").matches;
  return touchOnly && !readDismissed();
}

export default function TouchNotice({ onContinue }: { onContinue: () => void }) {
  const handleContinue = () => {
    // 同一个标签页里不再提示（进房间、刷新都不再拦）。存不了就只管这一次
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // 存储被禁用
    }
    onContinue();
  };
  // fixed 铺满视口：body 有 1200px 的最小宽度，手机上普通的居中会跑到屏幕外面
  return (
    <div
      className={tx(
        "fixed inset-0 z-[10000] flex items-center justify-center p-6 bg-canvas-parchment",
      )}
    >
      <div
        className={tx("bg-white rounded-lg p-6 w-full max-w-sm border border-hairline text-center")}
      >
        <div className={tx("text-4xl mb-3")}>💻</div>
        <h2 className={tx("text-xl font-semibold text-ink mb-2")}>请用电脑打开</h2>
        <p className={tx("text-sm text-ink-muted mb-6")}>
          画画要用鼠标，手机和平板的触屏画不了。把链接发到电脑上打开就能玩。
        </p>
        <button
          onClick={handleContinue}
          className={tx(
            "w-full py-2.5 px-4 rounded-full text-sm text-primary border border-primary",
            "hover:bg-canvas-parchment active:scale-95 transition",
          )}
        >
          仍要继续
        </button>
      </div>
    </div>
  );
}
