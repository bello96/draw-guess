import { install } from "@twind/core";
import presetAutoprefix from "@twind/preset-autoprefix";
import presetTailwind from "@twind/preset-tailwind";
import { createRoot } from "react-dom/client";
import App from "./App";

install({
  presets: [presetAutoprefix(), presetTailwind()],
  // 忽略 @uiw/react-color 给内部 div 加的 w-color-* 类（不是 Tailwind 工具类，
  // 否则 Twind 会把它们当 width 工具类解析失败 → 控制台 [TWIND_INVALID_CLASS] 告警）。
  ignorelist: [/^w-color-/],
  theme: {
    extend: {
      colors: {
        primary: "#6366f1",
        "primary-dark": "#4f46e5",
      },
    },
  },
});

createRoot(document.getElementById("root")!).render(<App />);
