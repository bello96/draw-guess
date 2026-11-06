// 构建测试用的前端包（不改项目文件），API 指向本地代理：
//   build-local        和线上同一份源码
//   build-full-redraw  对照组：进行中的笔画每帧整条重画，用来验证增量渲染的结果逐像素相同
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const tmp = path.join(here, ".tmp");

process.env.VITE_API_BASE = "http://127.0.0.1:8788";

await build({ root, logLevel: "warn", build: { outDir: path.join(tmp, "build-local"), emptyOutDir: true } });

const fullRedraw = {
  name: "full-redraw",
  enforce: "pre",
  transform(code, id) {
    if (id.replace(/\\/g, "/").endsWith("src/utils/brushes.ts")) {
      const from = /export function isIncrementalBrush\(brushType: BrushType \| undefined\): boolean \{[\s\S]*?\n\}/;
      if (!from.test(code)) {
        throw new Error("build-full-redraw：没找到 isIncrementalBrush");
      }
      return code.replace(from, "export function isIncrementalBrush(_b: BrushType | undefined): boolean {\n  return false;\n}");
    }
    return null;
  },
};
await build({ root, logLevel: "warn", plugins: [fullRedraw], build: { outDir: path.join(tmp, "build-full-redraw"), emptyOutDir: true } });
console.log("测试包构建完成");
process.exit(0);
