# 自定义颜色拾取器设计稿

日期：2026-04-27
作者：用户 + Claude Opus 4.6（brainstorming 协作）
范围：仅前端，不动后端 / 协议版本

---

## 1. 目标

工具栏中每个支持颜色的工具（pen / text / rect / ellipse / line / arrow / bucket）的颜色选择，从「7 个固定色」扩展为「7 个固定色 + 最近 6 色 + 自定义拾色器」。拾色器支持 SV 取色 + Hue + Alpha + Hex 输入，参考 lddgo.net colorpicker 风格。

## 2. 范围外

- **桶（bucket）工具不支持 alpha**。bucket 拾色面板隐藏 Alpha 滑块；hex 输入若带 alpha 自动 strip。决议：alpha 半透明 flood fill 语义反直觉（多次填充会累积），暂不做。
- **不引入「跨端同步最近色」**。最近色仅本地，不入协议。
- **不做拖动滑块时实时预览到画布**。「确定」后才提交色到 Room.tsx。

## 3. 依赖

新增：`react-colorful@^5.6.1`（~3KB gzip，零依赖，TS 原生支持）。
安装命令：`npm install react-colorful --legacy-peer-deps`（项目既有要求）。

## 4. UI / 交互

### 4.1 色行布局

替换 `Toolbar.tsx:131-147` 的 `ColorPicker` 为 `ColorPalette`：

```
[黑 蓝 绿 黄 红 紫 白] | [最近色 0..6] | [+]
   固定 7 色             用户拾过的色      自定义按钮
```

每个色块仍是 20×20 px，圆角 4 px，选中态 `ring-2 ring-indigo-400 scale-110`。
最近色为空时该段不渲染（紧凑布局，不留空位）。
「+」按钮：20×20 px，灰色描边圆角方块，里面 `+` 图标。

### 4.2 自定义拾色器二级浮层

- 触发：点「+」 → 弹出
- **再次点击「+」**：toggle 关闭（不通过外点路径）
- 尺寸：宽 240 px，高约 320 px（含 alpha 时）/ 280 px（不含 alpha 时，即 bucket）
- 锚点：浮层**底-右角** 对齐 「+」按钮**顶-右角**（即浮层向上向左延展）。如靠近视口左边缘导致溢出，clamp 到 viewport（参考 Toolbar.tsx 的 `ToolPopover` 已有的 `useLayoutEffect` 测量套路）
- 关闭：toggle 「+」 / 点击浮层外（捕获阶段全局监听）/ 点「清空」/ 点「确定」

### 4.3 浮层内部结构（从上到下）

1. **SV 方块** —— 240 × 140 px，react-colorful 主体
2. **Hue 横条** —— 240 × 12 px
3. **Alpha 横条** —— 240 × 12 px，**bucket 工具隐藏**
4. **预览 + Hex 输入** —— 一行 240 px：
   - 左：32 × 24 px 预览块，背景为白底棋盘格（用 CSS `repeating-linear-gradient`），上叠当前 draftColor
   - 右：input，placeholder 显示当前色，可输入 `#rgb` / `#rrggbb` / `#rrggbbaa`，回车或失焦应用
5. **按钮行** —— 「清空」（次要按钮，关闭面板不更新色）+ 「确定」（主按钮，写入色 + push 最近色 + 关闭）

## 5. 组件结构

```
Toolbar.tsx
  ├─ ColorPalette ★新（替代 ColorPicker）
  │   ├─ 固定色 row
  │   ├─ 最近色 row
  │   └─ 「+」按钮 → 触发 CustomColorPanel
  └─ CustomColorPanel ★新
      ├─ <HexAlphaColorPicker /> 或 <HexColorPicker />
      ├─ 预览 + hex input
      └─ 「清空」/ 「确定」按钮

src/hooks/useRecentColors.ts ★新
  └─ localStorage-backed [string]，max 6，支持降级到 in-memory

src/utils/color.ts ★新
  ├─ normalizeColor(input): string | null
  └─ stripAlpha(color): string

src/hooks/useCanvas.ts
  └─ hexToRgba() 扩展为接受 6/8 位 hex（向前兼容）
```

## 6. 状态分层

| 状态 | 拥有者 | 何时变 |
|---|---|---|
| `color: string` | `Room.tsx`（不动） | 用户点「确定」时 |
| `draftColor: string` | `CustomColorPanel` | 拖滑块/输入 hex 实时更新 |
| `isPanelOpen: boolean` | `ColorPalette` | 点「+」 / 外点 / 确定 / 清空 |
| `recentColors: string[]` | `useRecentColors`（localStorage） | 「确定」时 push |

**关键不变量**：`draftColor` 改变不引起 `color` 变更，画布颜色仅在「确定」时更新；这保证操作可撤销。

## 7. 色值与协议

### 7.1 协议

`SerializedStroke.color: string` 字段不变。`PROTOCOL_VERSION` 不 bump。

### 7.2 线上格式

- 新拾的色：统一 `#rrggbbaa`（8 位 hex，alpha=ff 也存）
- 历史 stroke 的 `#rrggbb`（6 位）：完全兼容，Canvas 视为 alpha=ff
- 桶工具发送前 `stripAlpha`，发出去的色一定是 6 位 hex

### 7.3 渲染兼容

`ctx.fillStyle = stroke.color` 和 `ctx.strokeStyle = stroke.color` 全部位置：Canvas 原生支持 6/8 位 hex，**无需改动**。

### 7.4 hexToRgba 扩展

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

桶用此函数仍取 RGB，alpha 强制 255 写入像素，不受影响。

## 8. localStorage

- key：`draw-guess-recent-colors`
- value：JSON `string[]`，最多 6
- 读取：try/catch 包裹；解析失败 / 非数组 / 元素非合法 hex → 静默归零
- 写入：try/catch 包裹；私密模式 / 配额满 → 静默失败，运行时降级为内存

## 9. 外点关闭实现

`ColorPalette` 内 useEffect 注册全局 `mousedown`（**capture 阶段**）：

```ts
useEffect(() => {
  if (!isPanelOpen) return;
  const onDown = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (t?.closest("[data-color-panel]")) return;
    if (t?.closest("[data-color-trigger]")) return;
    setIsPanelOpen(false);
  };
  document.addEventListener("mousedown", onDown, true);
  return () => document.removeEventListener("mousedown", onDown, true);
}, [isPanelOpen]);
```

`CustomColorPanel` 根节点：`data-color-panel="true"`；「+」按钮：`data-color-trigger="true"`。

注意：项目已有 `Room.tsx` 的全局 `mousedown` 用于 commit 文字 / 形状 / 选区。颜色面板的监听独立、不冲突——对方 capture 阶段的逻辑只检查 canvas / overlay 标识，不会干扰 popover。

## 10. Hex 输入行为

- value 跟随 `draftColor`
- 用户编辑时不立即更新（避免每键事件触发重渲染）
- 失焦或回车：`normalizeColor(input)` 成功 → 更新 `draftColor`；失败 → 回滚到当前 `draftColor`
- bucket 模式（`withAlpha=false`）下：输入 8 位合法 hex 也接受，但 `stripAlpha` 后写入

## 11. 选中态判定

固定色与最近色高亮命中条件：`color.toLowerCase() === c.toLowerCase()` 严格相等（含 alpha）。`#ff0000` 与 `#ff0000ff` 视为不同（用户预期：透明度也是色的一部分）。

## 12. 测试自查（开发 + 验收）

- 拖 SV/hue/alpha 滑块，画布颜色不变；点「确定」后才变
- 「清空」 / 浮层外点击 → 关闭，`color` state 不动
- 桶工具下 alpha 滑块不渲染；hex 输入 `#ff0000aa` → 自动变 `#ff0000`
- 最近色：连续拾 7 个色后，最早的被挤出，队列长度 6
- 刷新页面后最近色保留
- 浮层显示时一级 popover 不被错误外点关
- 历史房间的 6 位 hex stroke 回放不变样（含本人重连后接收 roomState）
- 双端验证：A 端用 `#ff000080`（50% 红）画一笔，B 端笔画呈现 50% 红的合成
- 桶 + 半透明色组合：选 `#ff000080`，切到桶，alpha 滑块隐藏，draftColor 变成 `#ff0000`，确定后填充表现完全不透明

## 13. 实现计划范围（交给 writing-plans）

- 新增依赖 `react-colorful`
- 新建 `src/utils/color.ts`（normalize / strip）
- 新建 `src/hooks/useRecentColors.ts`
- 改 `src/components/Toolbar.tsx`：替换 `ColorPicker` → `ColorPalette` + `CustomColorPanel`
- 改 `src/hooks/useCanvas.ts`：`hexToRgba` 扩展 6/8 位
- 验证：tsc / eslint / prettier 全绿
- 不改：协议、worker、其他组件

## 14. 双端一致性结论

色字符串 `#rrggbbaa` 是 Canvas 原生格式，两端各自渲染产生像素一致；不传位图、不需服务端校验色格式。最近色仅本地，与对端无关。无需 bump 协议版本。
