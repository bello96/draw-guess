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
        primary: "#0066cc",
        "primary-focus": "#0071e3",
        ink: "#1d1d1f",
        "ink-muted": "#7a7a7a",
        canvas: "#ffffff",
        "canvas-parchment": "#f5f5f7",
        "surface-tile": "#272729",
        "surface-tile-2": "#2a2a2c",
        hairline: "#ebebeb",
      },
      fontFamily: {
        display: ['"SF Pro Display"', "system-ui", "-apple-system", "sans-serif"],
        text: ['"SF Pro Text"', "system-ui", "-apple-system", "sans-serif"],
      },
      fontSize: {
        body: ["17px", { lineHeight: "1.47", letterSpacing: "-0.374px" }],
        lead: ["28px", { lineHeight: "1.14", letterSpacing: "0.196px" }],
        "display-md": ["34px", { lineHeight: "1.47", letterSpacing: "-0.374px" }],
        "display-lg": ["40px", { lineHeight: "1.1" }],
        hero: ["56px", { lineHeight: "1.07", letterSpacing: "-0.28px" }],
      },
      boxShadow: {
        product: "rgba(0, 0, 0, 0.10) 2px 4px 20px",
      },
    },
  },
});

createRoot(document.getElementById("root")!).render(<App />);
