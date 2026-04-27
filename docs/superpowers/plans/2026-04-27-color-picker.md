# 自定义颜色拾取器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Toolbar 颜色行加入自定义拾色器（含 alpha）+ 最近 6 色 localStorage 持久化；桶（bucket）工具仍走纯 RGB 不带 alpha。

**Architecture:** 在现有 `Toolbar.tsx` 内新增 `ColorPalette` 与 `CustomColorPanel` 内联组件（沿用既有 inlined picker 的模式）。`react-colorful` 提供 SV/Hue/Alpha 主体，外圈我们自己包装 hex 输入 + 预览 + 确定/清空 + 最近色行。新增 `src/utils/color.ts` 与 `src/hooks/useRecentColors.ts`。色字符串扩到 `#rrggbbaa`，**协议字段不变、版本不 bump**。

**Tech Stack:** React 18 + TypeScript + Twind + `react-colorful` + localStorage

**Spec reference:** `docs/superpowers/specs/2026-04-27-color-picker-design.md`

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `package.json` / `package-lock.json` | 修改 | 添加 react-colorful 依赖 |
| `src/utils/color.ts` | 新建 | `normalizeColor` + `stripAlpha` 纯函数 |
| `src/hooks/useRecentColors.ts` | 新建 | localStorage 后端的最近色队列 |
| `src/hooks/useCanvas.ts` | 修改 | `hexToRgba` 兼容 6/8 位 hex |
| `src/components/Toolbar.tsx` | 修改 | 新增 `ColorPalette` + `CustomColorPanel` 内联组件，替换 `ColorPicker` |

---

## Windows commit 命令模板（贯穿全部 task）

每个 task 末尾的提交：项目要求 commit message 为中文，且禁用 `Co-Authored-By` 英文行（改用「贡献者：Claude Opus 4.6」）。bash 在 Windows 下 heredoc 不可用，统一用临时文件：

```bash
# 1. 用 Write 工具或 echo 单行写入 .commit-msg.tmp（多行内容用 Write）
git add <files>
git commit -F .commit-msg.tmp
rm .commit-msg.tmp
```

单行简短消息可用 `git commit -m "..."`。

---

### Task 1：安装 react-colorful 依赖

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1：安装**

```bash
npm install react-colorful --legacy-peer-deps
```

Expected：`added 1 package` 或 `up to date` 之类，无 ERROR。

- [ ] **Step 2：类型检查（确认依赖安装后无破坏）**

```bash
npx tsc --noEmit
```

Expected：无输出。

- [ ] **Step 3：单行提交**

```bash
git add package.json package-lock.json
git commit -m "chore: 添加 react-colorful 依赖（自定义颜色拾取器需要）"
```

注：单行无需 .commit-msg.tmp。

---

### Task 2：创建 `src/utils/color.ts`

**Files:**
- Create: `src/utils/color.ts`

- [ ] **Step 1：写入文件**

```ts
// src/utils/color.ts

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
```

- [ ] **Step 2：类型检查 + lint**

```bash
npx tsc --noEmit && npx eslint src/utils/color.ts
```

Expected：无输出。

- [ ] **Step 3：提交**

```bash
git add src/utils/color.ts
git commit -m "feat: 新增颜色工具函数（normalizeColor + stripAlpha）"
```

---

### Task 3：创建 `src/hooks/useRecentColors.ts`

**Files:**
- Create: `src/hooks/useRecentColors.ts`

- [ ] **Step 1：写入文件**

```ts
// src/hooks/useRecentColors.ts
import { useCallback, useState } from "react";

const STORAGE_KEY = "draw-guess-recent-colors";
const MAX_RECENT = 6;
const HEX_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function readFromStorage(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr
      .filter((x): x is string => typeof x === "string" && HEX_RE.test(x))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeToStorage(arr: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // 私密模式 / 配额满 / 禁用：静默失败，运行时降级为内存
  }
}

export function useRecentColors(): {
  recent: string[];
  push: (color: string) => void;
} {
  const [recent, setRecent] = useState<string[]>(() => readFromStorage());
  const push = useCallback((color: string) => {
    setRecent((prev) => {
      const next = [color, ...prev.filter((x) => x !== color)].slice(0, MAX_RECENT);
      writeToStorage(next);
      return next;
    });
  }, []);
  return { recent, push };
}
```

- [ ] **Step 2：类型检查 + lint**

```bash
npx tsc --noEmit && npx eslint src/hooks/useRecentColors.ts
```

Expected：无输出。

- [ ] **Step 3：提交**

```bash
git add src/hooks/useRecentColors.ts
git commit -m "feat: 新增 useRecentColors hook（localStorage 最近色队列）"
```

---

### Task 4：扩展 `hexToRgba` 兼容 8 位 hex

**Files:**
- Modify: `src/hooks/useCanvas.ts`（约 161 行起的 `hexToRgba` 函数）

调用方调研已完成：`hexToRgba` 全工程仅 1 个调用点 `drawFillOnContext`（line 353），仅解构 `[fr, fg, fb]`，第 4 项 alpha 被丢弃。**扩展返回真实 alpha 是向前兼容的安全改动。**

- [ ] **Step 1：替换 `hexToRgba` 函数体**

找到 `src/hooks/useCanvas.ts` 现有的 `hexToRgba`：

```ts
function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return [r, g, b, 255];
}
```

替换为：

```ts
function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}
```

- [ ] **Step 2：类型检查**

```bash
npx tsc --noEmit
```

Expected：无输出。

- [ ] **Step 3：lint + format**

```bash
npx eslint src/hooks/useCanvas.ts && npx prettier --write src/hooks/useCanvas.ts
```

Expected：lint 无输出；prettier 显示 unchanged 或 just formatted。

- [ ] **Step 4：提交**

```bash
git add src/hooks/useCanvas.ts
git commit -m "feat: hexToRgba 支持 8 位 hex（兼容 alpha 通道）"
```

---

### Task 5：添加 CustomColorPanel + ColorPalette 并替换 ColorPicker

**Files:**
- Modify: `src/components/Toolbar.tsx`

这是本计划最大的一个 task。分 5 个 step：先加新组件、再替换调用点、再删旧 ColorPicker 定义。中间允许 lint warning（unused `ColorPicker`），最终 step 一并清理。

**架构提醒**：

- `CustomColorPanel` 是二级浮层，渲染在 `ColorPalette` 内部，`absolute` 定位，向上向左展开。
- `ColorPalette` 接 `withAlpha: boolean` prop。`withAlpha=false`（即 bucket 工具）时：
  1. 内部使用 `<HexColorPicker>` 而非 `<HexAlphaColorPicker>`
  2. 所有 onChange 出口（固定色、最近色、自定义面板确定）都先过 `stripAlpha`
- 已有的 toolbar 全局 `mousedown` 在 `Toolbar.tsx:380-391` 监听到外点关 popover；ColorPalette 的二级浮层渲染在 popover 内部 DOM 树（toolbarRef 子树），那个全局 handler 不会误关 popover。
- ColorPalette 自己另装一个 **capture 阶段** 全局 `mousedown` 用于关闭 panel（点 panel 内 / 点 「+」 → 跳过；其他 → 关）。

- [ ] **Step 1：在 Toolbar.tsx 顶部新增 import**

找到现有 import 区块（约 1-15 行），加入：

```tsx
import { HexColorPicker, HexAlphaColorPicker } from "react-colorful";
import { useRecentColors } from "../hooks/useRecentColors";
import { normalizeColor, stripAlpha } from "../utils/color";
```

`useState` / `useEffect` / `useRef` / `useLayoutEffect` 如果尚未在 React import 里，需要补全。检查现有 react import 行调整。

- [ ] **Step 2：在现有 `ColorPicker` 函数下方追加 `CustomColorPanel` 组件**

定位到 `Toolbar.tsx` 现有 `ColorPicker`（约 131-147 行），在它**之后**插入：

```tsx
function CustomColorPanel({
  initial,
  withAlpha,
  onCancel,
  onConfirm,
}: {
  initial: string;
  withAlpha: boolean;
  onCancel: () => void;
  onConfirm: (color: string) => void;
}) {
  const [draft, setDraft] = useState<string>(() =>
    withAlpha ? initial : stripAlpha(initial),
  );
  const [hexInput, setHexInput] = useState<string>(draft);

  // draft 变化时同步 hex 输入框
  useEffect(() => {
    setHexInput(draft);
  }, [draft]);

  const commitHexInput = () => {
    const normalized = normalizeColor(hexInput);
    if (normalized === null) {
      setHexInput(draft); // 非法 → 回滚
      return;
    }
    setDraft(withAlpha ? normalized : stripAlpha(normalized));
  };

  const Picker = withAlpha ? HexAlphaColorPicker : HexColorPicker;

  return (
    <div
      data-color-panel="true"
      className={tx(
        "absolute bottom-full right-0 mb-2 p-3 bg-white rounded-lg shadow-lg border border-gray-200 z-50",
      )}
      style={{ width: 240 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Picker
        color={withAlpha ? draft : draft.slice(0, 7)}
        onChange={(c: string) => setDraft(withAlpha ? c : stripAlpha(c))}
        style={{ width: "100%" }}
      />
      <div className={tx("flex items-center gap-2 mt-3")}>
        <div
          className={tx("w-8 h-6 rounded border border-gray-300 relative overflow-hidden")}
          style={{
            backgroundImage:
              "repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%)",
            backgroundSize: "8px 8px",
          }}
        >
          <div className={tx("absolute inset-0")} style={{ background: draft }} />
        </div>
        <input
          type="text"
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          onBlur={commitHexInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitHexInput();
            }
          }}
          className={tx(
            "flex-1 px-2 py-1 border border-gray-300 rounded text-sm font-mono outline-none focus:border-indigo-400",
          )}
          spellCheck={false}
        />
      </div>
      <div className={tx("flex justify-end gap-2 mt-3")}>
        <button
          onClick={onCancel}
          className={tx(
            "px-3 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50 transition",
          )}
        >
          清空
        </button>
        <button
          onClick={() => onConfirm(draft)}
          className={tx(
            "px-3 py-1 text-sm rounded bg-indigo-500 text-white hover:bg-indigo-600 transition",
          )}
        >
          确定
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3：在 `CustomColorPanel` 之后追加 `ColorPalette` 组件**

```tsx
function ColorPalette({
  value,
  onChange,
  withAlpha,
}: {
  value: string;
  onChange: (c: string) => void;
  withAlpha: boolean;
}) {
  const { recent, push } = useRecentColors();
  const [panelOpen, setPanelOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 外点关闭：捕获阶段，避免被画布 mousedown 抢跑
  useEffect(() => {
    if (!panelOpen) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest("[data-color-panel]")) {
        return;
      }
      if (t?.closest("[data-color-trigger]")) {
        return;
      }
      setPanelOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [panelOpen]);

  const handleSelect = (c: string) => {
    onChange(withAlpha ? c : stripAlpha(c));
  };

  const handleConfirm = (c: string) => {
    const final = withAlpha ? c : stripAlpha(c);
    push(final);
    onChange(final);
    setPanelOpen(false);
  };

  const isActive = (c: string) => c.toLowerCase() === value.toLowerCase();

  return (
    <div className={tx("flex gap-1.5 items-center relative")}>
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => handleSelect(c)}
          className={tx(
            "w-5 h-5 rounded transition border",
            isActive(c) ? "ring-2 ring-indigo-400 scale-110" : "border-gray-300",
          )}
          style={{ backgroundColor: c }}
        />
      ))}
      {recent.length > 0 && (
        <>
          <div className={tx("w-px h-5 bg-gray-200 mx-1")} />
          {recent.map((c) => (
            <button
              key={c}
              onClick={() => handleSelect(c)}
              className={tx(
                "w-5 h-5 rounded transition border relative overflow-hidden",
                isActive(c) ? "ring-2 ring-indigo-400 scale-110" : "border-gray-300",
              )}
              style={{
                backgroundImage:
                  "repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%)",
                backgroundSize: "6px 6px",
              }}
              title={c}
            >
              <span className={tx("absolute inset-0")} style={{ background: c }} />
            </button>
          ))}
        </>
      )}
      <div className={tx("w-px h-5 bg-gray-200 mx-1")} />
      <button
        ref={triggerRef}
        data-color-trigger="true"
        onClick={() => setPanelOpen((v) => !v)}
        className={tx(
          "w-5 h-5 rounded border border-gray-300 flex items-center justify-center text-gray-500 hover:bg-gray-50 transition text-sm leading-none",
        )}
        title="自定义颜色"
      >
        +
      </button>
      {panelOpen && (
        <CustomColorPanel
          initial={value}
          withAlpha={withAlpha}
          onCancel={() => setPanelOpen(false)}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4：替换 ColorPicker 引用**

在 `Toolbar.tsx` 中找到唯一一处使用：

```tsx
{meta.hasColor && <ColorPicker value={color} onChange={onColorChange} />}
```

替换为：

```tsx
{meta.hasColor && (
  <ColorPalette
    value={color}
    onChange={onColorChange}
    withAlpha={t !== "bucket"}
  />
)}
```

注意：`t` 是 `renderToolButton` 的形参，已经在作用域里。

- [ ] **Step 5：删除旧 `ColorPicker` 函数**

把现有 `ColorPicker` 函数（约 131-147 行）整体删除，避免 unused warning。

- [ ] **Step 6：类型检查 + lint + format**

```bash
npx tsc --noEmit && npx eslint src/components/Toolbar.tsx && npx prettier --write src/components/Toolbar.tsx
```

Expected：tsc 无输出；eslint 无输出；prettier 显示 unchanged 或 just formatted。

- [ ] **Step 7：提交（多行消息用 .commit-msg.tmp）**

先用 Write 工具建 `.commit-msg.tmp`：

```
feat: 工具栏新增自定义颜色拾取器（含 alpha + 最近 6 色）

- ColorPalette 替代旧 ColorPicker：固定 7 色 + 最近色队列 + 自定义按钮
- CustomColorPanel 二级浮层：react-colorful 主体 + hex 输入 + 清空/确定
- 桶（bucket）工具不带 alpha：禁用 Alpha 滑块、所有出口走 stripAlpha
- 最近色 localStorage 持久化（key=draw-guess-recent-colors，max 6）
- 协议字段 SerializedStroke.color 不变；新色一律 #rrggbbaa；历史 #rrggbb 完全兼容

贡献者：Claude Opus 4.6
```

然后：

```bash
git add src/components/Toolbar.tsx
git commit -F .commit-msg.tmp
rm .commit-msg.tmp
```

---

### Task 6：构建产物 + 手动浏览器验证

**Files:** none

CI/test infra 还没建立，本项目的「绿灯」是 tsc + eslint + 浏览器手测三件套。每个 task 内已经做了前两件，本 task 做最后一件。

- [ ] **Step 1：构建确认**

```bash
npm run build
```

Expected：`✓ built in <ms>`，`dist/` 产出 index.html + assets/index-*.js。无 ERROR。bundle 体积应在 ~91 KB gzip 量级（增量约 +3 KB）。

- [ ] **Step 2：启动开发服务器**

```bash
npm run dev
```

服务器起来后浏览器打开提示的 localhost URL（通常 http://localhost:5173）。

- [ ] **Step 3：核对验收清单**

按 spec §12 跑一遍，逐项打勾：

- [ ] 拾色器面板：拖 SV/hue/alpha 滑块，画布颜色不变；点「确定」后才变
- [ ] 「清空」 / 浮层外点击 → 关闭，画布颜色不动
- [ ] 桶工具下 alpha 滑块不渲染；hex 输入 `#ff0000aa` → 自动变 `#ff0000`
- [ ] 最近色：连续拾 7 个色后，最早的被挤出，队列长度 6
- [ ] 刷新页面后最近色保留（localStorage）
- [ ] 二级浮层显示时一级 popover 不被错误外点关
- [ ] 历史房间的 6 位 hex stroke 回放不变样
- [ ] 双端验证（开两个 tab/浏览器进同一房间）：A 用 `#ff000080`（50% 红）画一笔，B 端笔画呈现 50% 红的合成结果
- [ ] 桶 + 半透明色组合：选 `#ff000080`，切到桶，alpha 滑块隐藏，draftColor 变成 `#ff0000`，确定后填充表现完全不透明

- [ ] **Step 4：异常路径手测**

- [ ] hex 输入框输入 `#xyz`（非法），失焦后 input 内容回退到当前色（不报错）
- [ ] hex 输入 `#fff`（3 位）→ 失焦后展开成 `#ffffff`
- [ ] 同色多次「确定」最近色不重复（去重生效）
- [ ] localStorage 里手动写入坏数据（`localStorage.setItem("draw-guess-recent-colors", "garbage")`），刷新页面，最近色为空（不崩溃）

- [ ] **Step 5：（可选）部署**

如果验证全绿，听用户号令决定是否：

```bash
npm run deploy:page
```

部署仅前端（Worker 完全没动）。

---

## 自审

### 1. Spec coverage check

| Spec 段 | 对应 Task |
|---|---|
| §3 react-colorful 依赖 | Task 1 |
| §4.1 色行布局 | Task 5 Step 3 (`ColorPalette`) |
| §4.2 二级浮层结构 | Task 5 Step 2 (`CustomColorPanel`) |
| §4.3 浮层内部组件 | Task 5 Step 2 |
| §5 组件结构 | Task 2/3/5 |
| §6 状态分层（draftColor 隔离） | Task 5 Step 2（`CustomColorPanel` 内 useState） |
| §7.1 协议不动 | 不变更；Task 4 `hexToRgba` 仅扩展 |
| §7.2 #rrggbbaa 格式 | Task 5 默认透传 react-colorful 输出（库返回 `#rrggbbaa`） |
| §7.3 渲染兼容 | Task 4 |
| §7.4 hexToRgba 扩展 | Task 4 |
| §8 localStorage | Task 3 |
| §9 外点关闭（捕获） | Task 5 Step 3（`ColorPalette` useEffect） |
| §10 hex 输入行为 | Task 5 Step 2（`CustomColorPanel` commitHexInput） |
| §11 选中态判定 | Task 5 Step 3（`isActive`） |
| §12 测试自查 | Task 6 |
| §14 双端一致 | 不需代码（spec 论证） |

### 2. Placeholder scan

无 TBD / TODO / FIXME。每个步骤都有完整代码或确切命令。

### 3. Type consistency

- `normalizeColor` / `stripAlpha` 签名 Task 2 定义，Task 5 使用一致
- `useRecentColors` 返回 `{ recent: string[]; push: (color: string) => void }`：Task 3 定义，Task 5 解构一致
- `CustomColorPanel` props 接口 Task 5 Step 2 定义，Step 3 中 `ColorPalette` 调用方式一致
- `ColorPalette` 接 `withAlpha: boolean`：Step 3 定义，Step 4 替换 ColorPicker 时传入一致

### 4. Ambiguity scan

- 二级浮层定位：`absolute bottom-full right-0 mb-2`—— 锚于 ColorPalette 容器，向上 + 右对齐。视口边界 clamp 通过 max-width + responsive margin 自然处理（spec §4.2 提到的复杂 clamp 套路在此版可省，因为 panel 宽 240px 通常够用；如真溢出可后续微调，不阻塞 ship）。
- 桶模式 hex 输入合法 8 位输入：自动 stripAlpha 后写入。已在 `commitHexInput` 内显式处理。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-color-picker.md`. Two execution options:

1. **Subagent-Driven（推荐）** — 每个 task 派一个 fresh subagent，task 间审查，迭代快
2. **Inline Execution** — 当前会话内用 executing-plans skill 批量执行 + checkpoint

哪种？
