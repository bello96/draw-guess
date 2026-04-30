# CLAUDE.md

本文件为 AI 助手（Claude Code 等）提供该仓库的上下文。人类阅读请直接看 `README.md`。

> 项目：**🎨 我画你猜** · 双人实时画画猜词游戏
> 线上：https://draw-guess.dengjiabei.cn

---

## 一、项目速览

- **纯前端**：React 18 + TypeScript + Vite + Twind（CSS-in-JS Tailwind）
- **后端**：Cloudflare Workers + Durable Objects（Hibernatable WebSocket + SQLite backend）
- **实时通信**：WebSocket JSON 消息
- **部署**：GitHub Actions → Cloudflare Pages（前端）+ Workers（后端）
- **单仓库两个包**：根目录是前端，`worker/` 是后端，两边各自 `package.json` 与 `tsconfig.json`

## 二、目录结构

```
├── src/                          # 前端
│   ├── main.tsx                  # 入口，Twind install
│   ├── App.tsx                   # 顶层路由（首页 / 昵称弹窗 / 房间）
│   ├── api.ts                    # apiUrl / wsUrl 工具
│   ├── pages/
│   │   ├── Home.tsx              # 创建 / 加入房间
│   │   └── Room.tsx              # 主游戏页，消息分发 + 撤销/重做栈
│   ├── components/
│   │   ├── Canvas.tsx            # 画板容器 + 文字/形状/框选编辑 overlay
│   │   ├── Toolbar.tsx           # 8 工具 + ColorPalette/CustomColorPanel 颜色选择 + undo/redo/clear
│   │   ├── PlayerBar.tsx         # 顶栏房间号、玩家、操作按钮
│   │   ├── ChatPanel.tsx         # 聊天 / 设答案 / 猜词三合一输入
│   │   ├── Confetti.tsx          # 猜对时的彩带雨（canvas + RAF）
│   │   └── Toast.tsx             # 右上角错误提示（取代粗糙的 system message）
│   ├── hooks/
│   │   ├── useWebSocket.ts       # WS 连接、重连、心跳、leave/pagehide
│   │   └── useCanvas.ts          # 画布事件、笔画、归一化坐标、离屏缓存、flood fill
│   ├── utils/
│   │   └── color.ts              # normalizeColor（hex 字符串规范化）
│   ├── assets/                   # 图标源文件（SVG），当前用 inline path 镜像到 Toolbar
│   └── types/protocol.ts         # ⭐ 前后端共享的消息类型契约
├── worker/
│   ├── src/
│   │   ├── index.ts              # HTTP 入口 + 路由到 DO + Origin 白名单
│   │   ├── room.ts               # ⭐ GameRoom Durable Object（状态机 + 消息 handlers）
│   │   ├── types.ts              # DO 内部类型（PlayerAttachment, DisconnectedPlayer 等）
│   │   ├── constants.ts          # 所有可调参数（grace、limits、protocol version）
│   │   └── helpers.ts            # 纯函数 helpers（strokeKey, normalizeForCompare）
│   └── wrangler.toml             # durable_objects + routes
└── .github/workflows/            # deploy-pages.yml / deploy-worker.yml
```

## 三、核心设计要点

### 1. Hibernatable WebSocket
`this.state.acceptWebSocket(server)` 接受连接后，Durable Object 进程可**在无消息时被回收**，唤醒时通过 `this.state.getWebSockets()` 恢复所有 ws。玩家身份存在 **ws attachment** 里（`serializeAttachment` / `deserializeAttachment`）以跨休眠保留。

### 2. 状态持久化策略
- **ws attachment**：玩家身份（id / name / isOwner / quickLeave）— 跟着连接走
- **DO storage**（SQLite backend）：房间元数据（phase / drawerId / answer / strokes / chatHistory / disconnectedPlayers）
- `ensureLoaded()` 第一次访问时从 storage 恢复内存快照；之后所有读操作用内存
- `saveState()` / `state.storage.put(key, value)` 写回

### 3. 断线 / 重连模型
两级 grace period：

| 场景 | Grace | 触发方式 |
|------|-------|----------|
| 正常断线 | 30s | `ws.onclose` → `onDisconnect` 进入 `disconnectedPlayers` |
| 页面刷新 / 关闭 | 5s | `pagehide` → `navigator.sendBeacon('/quickleave')` 标记 `quickLeave=true` |
| 主动离开 | 即时 | 前端发 `{type:"leave"}` → 服务端 `onLeave` → `processActualLeave` |

超时由 `alarm()` 统一处理；`scheduleNextAlarm()` 会取 `min(所有 disconnected grace 结束时刻, lastActivityAt + 10min)`。

### 4. 玩家身份恢复
- 前端在 `roomState` 到达后把 `yourId` 存到 `sessionStorage(draw-guess-playerId)`
- 刷新后 `App.tsx:useEffect` 读取 sessionStorage，`useWebSocket` 携带 playerId 连接
- 服务端 `onJoin` 检查两路：
  1. `disconnectedPlayers` map（已经走过 onDisconnect）→ 恢复 attachment
  2. 已存在的 ws（旧连接尚未 close）→ **take over**：关闭旧 ws，新 ws 继承身份

### 5. 游戏阶段机（`GamePhase`）
```
waiting        ← 初始，只有 1 人时
  ↓ 第二人加入
drawing        ← 画手自由画
  ↓ setAnswer
guessing       ← 猜词方开始猜；画手可继续画
  ↓ 猜对
revealed       ← 可 "继续出题" 回到 drawing，或 "转让画笔" 切换画手
```
状态只在 `room.ts` 服务端变更，客户端通过 `phaseChange` 被动同步。

### 6. 画板坐标归一化与分辨率
- 所有 `{x, y}` 在线上协议和存储里都是 `[0, 1]` 归一化值。画布实际像素 = 归一化 × `canvas.width`
- `REF_WIDTH = 800` 是逻辑参考宽度，用于 `scaleLineWidth` / 字号缩放（clamp 0.5~2.0 倍）
- `OFFSCREEN_WIDTH × OFFSCREEN_HEIGHT = 1600 × 1200`（4:3，与 visible 比例一致）：实际离屏画布尺寸，2× 线性分辨率，曲线/油漆桶在更高分辨率下渲染再 bilinear 下采样到 visible，显著减少阶梯锯齿
- 两个常量解耦：visible 渲染用 `canvas.width / REF_WIDTH` 算 scale；offscreen 渲染用 `1600 / 800 = 2.0` 算 scale；最终 drawImage 缩到 visible 后两者视觉粗细一致

### 7. 工具系统（8 种 + 编辑态）

工具栏左→右分 6 组（用竖线分隔）：油漆桶和框选移动各自独占一栏，把"区域填充"和"像素搬运"两类区别于规则形状的工具单独凸显。
```
[画笔 | 文本] │ [油漆桶] │ [矩形 | 椭圆 | 直线 | 箭头] │ [框选] │ [撤销 | 重做] │ [清除]
```

每个工具按钮点击时**弹出独立 popover**（参考微信截图风格）：
- 画笔 / 矩形 / 椭圆 / 直线 / 箭头：线宽选项 + 颜色选择
- 矩形 / 椭圆 额外：**线框 / 填充** 切换
- 文本：**小 / 中 / 大** 字号 + 颜色选择
- 油漆桶：仅颜色选择（无线宽、无 alpha）
- 框选：无 popover（直接进入框选模式）

颜色选择行（适用于带 `hasColor: true` 的工具）= `ColorPalette` 组件：
- 7 个固定预设色（黑/蓝/绿/黄/红/紫/白）
- 分隔条
- 1 个**自定义色块**：右下角带彩虹三角标识；背景棋盘格 + 当前 customColor 覆盖；面板打开时 background 跟随 draft 实时变化；面板关闭后若 `customColor === value` 则显示高亮 ring（表示当前画布色就是上次确认的自定义色）

`customColor` state 提升到 `Toolbar` 函数层级（不在 `ColorPalette` 内部），保证 popover 反复开关时上次确认的自定义色不丢失。

再次点同一工具按钮 toggle 关闭 popover。popover 的 `ToolPopover`（Toolbar.tsx 内）会用 `useLayoutEffect` 测量 popover 宽度，**clamp 到视窗边缘**，同时三角反向偏移以持续指向被点击的按钮。

### 8. 编辑态（失焦即 commit）

文字 / 矩形 / 椭圆 / 直线 / 箭头 / 框选 **画完后不立即 commit**，而是进入编辑态（dashed overlay），支持：
- **拖拽整体平移**（`editingText` / `editingShape` / `editingSelection` 的 points 同步更新 pixel + normalized）
- **点击 overlay 外任何地方** → commit 并同步到对端
- **切换工具 / 清除 / 转让画笔 / 继续出题** → commit 或丢弃
- 文字 overlay 额外保留角点调字号（corner handles）
- 矩形 / 椭圆 overlay 保留 4 角点缩放
- 箭头 / 直线 overlay 保留 2 端点拖拽（改长度 + 角度）
- 框选 overlay 仅支持平移（不缩放，不旋转）

实现要点：
- 三类编辑态分别用 `data-text-overlay` / `data-shape-overlay` / `data-selection-overlay` 标记 DOM
- Room.tsx 全局 `mousedown` 监听，editingShape / editingSelection 用 **capture 阶段**（先于 canvas 的 mousedown commit 旧 overlay，再让新 drag 开始）
- arrow / line 的 `points` 是 `[start, end]`，**方向保留**；rect/ellipse 的 `points` 是 `[bbox 的两角]`，**顺序不重要**（消费方 min/max）
- arrow / line 编辑 overlay 用 SVG（`overflow: visible` 处理退化 bbox），rect/ellipse 用 DOM `div` + border/background

### 9. 撤销 / 重做

双端维护对称 redoStack：
- **客户端**：Room.tsx 的 `redoStackRef`（ref，非 state）+ `canUndo`/`canRedo` state（用于 Toolbar 按钮 disabled）
- **服务端**：`room.ts` 的 `redoStack: SerializedStroke[]`（in-memory，**不持久化**）
- `syncHistoryFlags()` 在每次改动 strokesRef/redoStackRef 后同步 state

核心规则：
- `onUndo`：strokes.pop → redoStack.push → broadcast **exclude sender**（否则发起者会二次 pop，⚠️ 曾经犯过这个 bug）
- `onRedo`：redoStack.pop → strokes.push → broadcast **exclude sender**
- 任何新笔画（pen end / textStroke / shape）→ 服务端和两端客户端都清空 redoStack
- clear / transfer / continueDrawing / alarm reset / processActualLeave → 同清

---

## 四、⚠️ 已知坑点（开发前必读）

> 这些点是过去踩过或代码里已隐含约束，改动相关区域请特别小心。

1. **桌面端专用（有意为之）**：`index.html` 有 `min-width: 1200px`，`useCanvas.ts` 已删除 Touch 事件处理。若未来要支持移动端需独立布局，不要简单移除 min-width。

2. ~~**WebSocket 无自动重连**~~ ✅ 已修复：`useWebSocket` 带指数退避重连（1s→30s），识别 5 种 terminal close reason（`left`/`room not found`/`room full`/`inactivity`/`reconnected`）不重连。重连时从 `sessionStorage` 读最新 `playerId`，走服务端 take-over / disconnectedPlayers 恢复分支。

3. ~~**房间号冲突**~~ ✅ 已修复：parent Worker 循环最多 5 次；`/init` 已创建时返回 **409**，调用方据此换码重试。新增 `/init` 时注意保持这个语义。

4. **`saveState()` 是全字段写**：`strokes` 和 `chatHistory` 都在里面。频繁调用会放大写入。已经对 `onDraw` 做了"只在 end 时 put strokes"的优化，其他地方慎用。

5. **DO storage 单值 128 KB 上限**：`strokes` 被整体 put，复杂画作会超限。当前未处理。

6. **`touchActivity()` 在 `join` 类型消息里不会被 `webSocketMessage` 的通用分支调用**：`onJoin` 内部显式 touch。新加类型时注意这个约定。

7. **`executeTransfer` / `onContinueDrawing` 会发 3 条 broadcast**（transferDone/clear/phaseChange）：顺序敏感。前端 Room.tsx 的 switch 里依赖的就是这个顺序。

8. **前端 `msgIdCounter` 是模块级 `let`**：React StrictMode / 组件 remount 下不重置。靠 `++` 保证唯一即可，别改为 useState。

9. **Twind 条件 class 语法**：`tx("base", cond && "cls-a")`。`false` 会被 Twind 忽略，但别写成 `cond ? "a" : "b"` 和纯字符串混用时出现奇怪优先级。

10. **`App.tsx` 用 `window.history.replaceState`（不是 pushState）**：浏览器返回键不会退出房间，是有意的。

11. **中文答案匹配**：服务端用 `.toLowerCase()` 比较，对中文无效；全角 / 半角 / 空格 / 标点任一不同都会判错。

12. **`VITE_API_BASE` 指向生产 Worker**：`npm run dev` 直接连线上。要本地联调服务端得 `npm run dev:worker` 并手动改环境变量。

---

## 五、开发流程

### 本地起服务
```bash
# 前端（默认连线上 Worker）
npm run dev

# 本地 Worker（需 wrangler 登录）
cd worker && npx wrangler dev
# 并把 .env.development 的 VITE_API_BASE 临时改为 http://localhost:8787
```

### 代码规范
遵循全局 CLAUDE.md：
- **Git commit message 必须中文**（`feat:`/`fix:`/`style:` 前缀保留英文，描述部分中文）
- commit 末尾加 `贡献者：Claude Opus 4.6`（不要 `Co-Authored-By` 英文格式）
- 所有 `if` 语句**强制**带 `{}`（ESLint `curly: error` 已固化）
- TypeScript 严格模式，提交前跑 `npx tsc --noEmit`
- 响应用户一律使用**中文**

### Lint & Format
- `npm run lint` — 检查 src/ + worker/src/
- `npm run lint:fix` — auto-fix（`curly` 可自动加花括号）
- `npm run format` — Prettier 格式化
- `npm run format:check` — CI 友好的只读检查
- 配置文件：根目录 `eslint.config.js`（flat config）+ `.prettierrc.json` + `.prettierignore`
- 忽略目录：`dist/` / `node_modules/` / `.wrangler/` / `*.config.*`
- 3 个允许存在的 `exhaustive-deps` warnings 是有意留的（mount-only effect / 避免重渲染）
- **已知依赖坑**：`@twind/core` 的 peer 只接受 TypeScript `^4.8.4`，与项目实际 TS 5.9 冲突。`npm install` 必须加 `--legacy-peer-deps` 跳过（或在 `.npmrc` 里固化 `legacy-peer-deps=true`）

### 编辑协议类型的流程
`src/types/protocol.ts` 是**前后端共享的契约**，服务端 `worker/src/room.ts` 目前是手动按字段写的（没有 import 前端类型）。修改协议时：
1. 在 `protocol.ts` 加类型
2. 去 `room.ts` 的 switch-case 手动加处理
3. 两端都要跑 `tsc --noEmit`

### 部署
- 推 `master`：
  - 改到 `worker/**` 外的文件 → 触发 Pages 部署
  - 改到 `worker/**` → 触发 Worker 部署
- 手动：`cd worker && npx wrangler deploy` / `npm run build && npx wrangler pages deploy dist`

---

## 六、修改某个区域时常用的入口

| 我想做… | 先看这里 |
|---------|---------|
| 加一种 WS 消息 | `src/types/protocol.ts` → `worker/src/room.ts:webSocketMessage` → `src/pages/Room.tsx:addListener switch` |
| 改画板交互 | `src/hooks/useCanvas.ts`（事件）+ `src/components/Canvas.tsx`（DOM） |
| 改游戏阶段流转 | `worker/src/room.ts` 的 `onSetAnswer` / `onGuess` / `onContinueDrawing` / `executeTransfer` |
| 改断线 / 重连 | `useWebSocket.ts`（前端）+ `room.ts` 的 `onJoin` / `onDisconnect` / `alarm` |
| 改 UI 样式 | 组件里的 `tx(...)`；全局主题色在 `src/main.tsx` 的 Twind `install({theme:{extend:{colors}}})` |

---

## 七、未完成 / 待改进（Roadmap）

按优先级，详见分析报告：

- ~~**P0**~~：全部已处理 — WebSocket 重连 ✅ / 桌面端定位 ✅ / 房间码冲突 ✅ / 输入长度限制 ✅
- ~~**P1**~~：全部已处理 — WS 心跳 ✅ / 答案归一化 ✅ / draw RAF 批量 ✅ / strokes 分片存储 ✅
- **P2**：Origin 白名单 ✅ / rate limit ✅ / 错误 Toast ✅ / 文字点击空白 commit ✅ / ESLint + Prettier ✅ / ~~状态机单测~~ ⏳
- **P3**：协议版本号 ✅ / `room.ts` 拆文件 ✅ / ~~draw 二进制协议~~ ⏭ / 离屏 canvas 缓存 ✅ / Confetti 改 canvas 渲染 ✅

> **为什么跳过 draw 二进制协议**：permessage-deflate 已经压掉 JSON 的冗余，实际带宽 <40 KB/s 峰值。手写 binary 协议需要前后端双端 encode/decode + bump 协议版本 + 维持 JSON fallback，工程成本大但收益边际。如果某天带宽成了瓶颈再做，现在不值。

**输入长度硬限制（服务端常量 in `worker/src/room.ts`）**：
- `MAX_NAME_LENGTH = 10`
- `MAX_ANSWER_LENGTH = 20`
- `MAX_CHAT_LENGTH = 200`（guess/chat 共用）
- `MAX_TEXT_STROKE_LENGTH = 100`

客户端各 input 的 `maxLength` 应与上述常量一致，改一边别忘另一边。

**心跳（ping/pong）**：客户端 `useWebSocket` 每 25s 发 `{type:"ping"}`，服务端回 `{type:"pong"}` 并**跳过 `touchActivity`**——否则会把 10 分钟 idle 定时器重置，auto-close 永远不触发。pong 在 `useWebSocket.onmessage` 里就被吞掉，不经过 listener。

**答案归一化**：`worker/src/room.ts` 的 `normalizeForCompare()`，NFKC + lowercase + 去空格 + 去 `\p{P}` 标点（保留 emoji / 数字 / 字母 / CJK 字）。`this.answer` 存**原文**（画手面板展示用、`answerLength` 算用），compare 时两侧都跑归一化。不要图方便直接存归一化后的，会让画手看到 "答案：你好！" → "你好"。

**draw 消息 RAF 批量**：`C_Draw.points?: {x,y}[]` 为可选批量字段。客户端 `onMouseMove` 把点塞进 `pendingPointsRef`，一帧一次 `requestAnimationFrame(flushPendingMove)` 合并发送；`onMouseUp` 前强制 flush 一次再发 `end`。服务端 `onDraw` 的 move 分支 `msg.points ?? [{x:msg.x,y:msg.y}]` 兼容单点。`replayDraw` 同样处理 `points` 数组。

**strokes 分片存储**：strokes 不再用单 key `"strokes"` 存，每条独立 key `stroke:0000000001` …，避免 128KB 单值上限。关键点：
- 写入：`onDraw end` / `onTextStroke` 用 `strokeKey(this.strokes.length - 1)` put 单条
- 撤销：`onUndo` delete 最后一个 key
- 清空：所有"重置 strokes"的地方都必须调 `clearStrokeStorage()`（alarm / onClear / onContinueDrawing / executeTransfer / processActualLeave 空房间）
- `saveState()` **不再** put strokes 字段
- `ensureLoaded()` 用 `list({prefix: "stroke:"})` 恢复，并顺手 `delete("strokes")` 清掉旧版遗留的 legacy blob
- batch delete 上限 128 key/次，`clearStrokeStorage` 内部已分批

**Origin 白名单**：`worker/src/index.ts` 的 `isAllowedOrigin()` 是**所有** API 路由 + WebSocket upgrade 的入口闸门。接受 production 域名 + 任意 `localhost` / `127.0.0.1` 端口。**缺失 Origin header 一律 403**（不把无头请求当可信）。新增后端接口时记得它也会被闸门拦——如果故意要开放，在 if 前面开白。`corsHeaders(origin)` 始终回 echo 来的 origin，不再用 `*`。

**Rate limit**：`checkRateLimit(ws)` 在 `webSocketMessage` 最顶部调用，rolling 1s window / 150 msg/ws。正常流量峰值 ~60/s（RAF 节流后的 draw）。超限则 send error + `ws.close(1008, "rate limited")`。前端 `TERMINAL_CLOSE_REASONS` 已把 `"rate limited"` 列入不重连清单——别去掉，否则会 ping-pong。计数器是 WeakMap，hibernation 时自然丢失（可接受，相当于窗口 reset）。

**Toast 错误提示**：`src/components/Toast.tsx` 是通用组件（error / info / success），右上角滑入、3s 自动消失、点击关闭。Room.tsx 里 `error` 消息改用 Toast，不再塞到聊天历史。同一时刻只有一个 toast；新 toast 会覆盖旧 toast（靠 `key={toast.id}` 强制 remount 动画）。

**文字工具点击空白 commit**：Room.tsx 里有 `useEffect` 监听全局 `mousedown`，editingText 存在时：
- `target.closest("[data-text-overlay]")` → 忽略（内部 UI 交互）
- `target.tagName === "CANVAS"` → 忽略（`onCanvasClick` 会 commit + 开新的）
- 其他 → commit

新增文字编辑相关 DOM 时记得挂 `data-text-overlay="true"` 以免被误 commit。

**协议版本号（PROTOCOL_VERSION）**：双写在 `src/types/protocol.ts` 和 `worker/src/constants.ts`，两边必须一致。客户端把 `v` 放进 `join` 消息，服务端 `onJoin` 校验，不匹配发 error 并 `close(1000, "version mismatch")`。前端 `TERMINAL_CLOSE_REASONS` 已把 `"version mismatch"` 纳入不重连——否则刷新前会死循环重连 + 被踢。

**画板比例 4:3**：visible canvas 是 **4:3**（width:height）。`Canvas.tsx` 的 `resizeCanvas` **高度驱动**：先取 `container.clientHeight` 作为高度，宽度 = 高度 × 4/3；如果宽度溢出 container 就回退成宽度驱动（高度 = 宽度 × 3/4）。`container` 的 CSS 最小尺寸改成 `min-w-[533px] min-h-[400px]`（533 = 400 × 4/3）。

**离屏 canvas 缓存**：`useCanvas.ts` 维护一个固定 **1600×1200 (4:3，OFFSCREEN_WIDTH × OFFSCREEN_HEIGHT)** 的 `offscreenRef`，作为"已完成笔画"的单一来源。2× 线性分辨率，曲线 / 油漆桶在更高分辨率下渲染再 bilinear 下采样到 visible canvas，显著减少阶梯锯齿。所有 stroke end 分支（本地 onMouseUp / 远程 replayDraw 的 end / addTextStroke / addFill / addSelection）都会把完成的 stroke **commit 到 offscreen**。resize 时 Room 的 `handleCanvasResize` 调 `syncVisibleFromOffscreen`，直接 `drawImage(offs, 0, 0, canvas.width, canvas.height)` 一次 blit 搞定，**O(1)** 而不是 O(总点数) full replay。

关键约束：
- offscreen 尺寸固定 1600×1200（OFFSCREEN_WIDTH × OFFSCREEN_HEIGHT，比例 4:3）；REF_WIDTH=800 是用于 lineWidth/字号缩放的「逻辑参考」，与离屏物理尺寸**解耦**。`scaleLineWidth` clamp 范围 0.5~**2.0**（上限 2.0 是为了让 offscreen 的 1600/800 = 2× 倍率不被钳掉，否则 commit 后线突然变细）
- aspect ratio 必须与 visible 一致，否则图形会被拉伸；`Canvas.tsx` 的 `RATIO_W/RATIO_H = 4/3` 必须等于 `OFFSCREEN_WIDTH:OFFSCREEN_HEIGHT`
- **live drawing（mousemove 中）不写 offscreen**，只在 stroke end 时 flush —— 如果用户一边 resize 一边还在画，当前未完成的 in-progress stroke 的已绘像素会丢失。这种 edge case 不处理（用户几乎不会这样操作）
- `replayAll` / `clearCanvas` / `undo` 仍然 O(N)（rebuild offscreen），因为 canvas 无法"反绘"某条笔画
- **改画板比例要三处联动**：Canvas.tsx 的 `RATIO_W/RATIO_H`、useCanvas 的 `OFFSCREEN_WIDTH/OFFSCREEN_HEIGHT`、字号/线宽参考 `REF_WIDTH`

**Confetti 性能版**：`src/components/Confetti.tsx` 是单 canvas + requestAnimationFrame 粒子系统，替代了旧版 150 confetti DOM + 16 rocket × 60 粒子 ≈ **1100 个 DOM 节点 + CSS 动画**。现在只有一个 `<canvas fixed inset-0 pointer-events-none>`。
- 所有粒子在 useEffect 里创建，RAF 循环 tick 更新 + 绘制
- 三类：`ConfettiPiece`（顶部下落）/ `Rocket`（上升 + 爆炸 + flash）/ `FwParticle`（爆炸粒子，radial + gravity 拖尾 + 可选 sparkle 闪烁）
- 循环里 `alive` 计数，0 时 `setVisible(false)` 卸载整个组件
- 视觉与旧版**大致一致**但不完全 pixel-perfect（曲线近似用 `progress^0.85` + 二次项重力，而非原 CSS 四段 keyframes 精确还原）
- 低端机 / Safari 上 compositing 压力显著降低

**什么时候 bump**：
- **要 bump** —— 删除消息类型 / 删除必填字段 / 改字段类型 / 改字段语义
- **不 bump** —— 加新消息类型 / 加可选字段

**bump 流程**：同时改两个文件的常量（目前是 1 → 2），push 服务端再 push 前端。服务端先上比前端先上更安全：老客户端被服务端拒绝 + 提示刷新 → 用户刷新拿到新客户端 → OK。

**legacy grace**：当前服务端对 `clientVersion == null` 豁免（兼容 P3-1 部署瞬间在线的老客户端）。**当确认线上没有无 v 字段的客户端后，把 `if (clientVersion != null && …)` 里的 null 分支去掉，改成严格相等**。这一步别忘，否则 version 校验永远有漏洞。

修改前建议先阅读仓库根的《全面分析报告》（会话历史里的那次完整输出），里面有每条问题对应的代码位置和修复思路。

---

## 八、追加实现要点（工具栏重构之后的新功能）

**形状消息（C_Shape / S_Shape）**：`shape: "rect" | "ellipse" | "arrow"` + `filled: boolean` + `x/y/width/height` + color/lineWidth。服务端 `onShape` 存入 strokes 时：
- rect/ellipse：`points = [{x,y}, {x+width, y+height}]`（min→max，width/height 始终非负）
- arrow：`points = [{x,y}, {x+width, y+height}]`（start → end，width/height 可为负）

`SerializedStroke` 的 `shape?: "rect"|"ellipse"|"arrow"` 和 `filled?: boolean` 字段让 `renderStrokeToCtx` 里分支渲染：arrow 画 line + 填充三角形头；rect/ellipse 按 bounding box + fill/stroke 模式画。

**SVG 图标**：`src/assets/*.svg` 里是源文件，实际代码中 **path 数据内联到 `Toolbar.tsx`** 的 `IconRect` / `IconEllipse` / `IconArrow` / `IconPen` / `IconText` / `IconUndo` / `IconRedo` / `IconClear` 里。统一 `viewBox="0 0 1024 1024"`、`width="18"`、`fill="currentColor"`（色由父按钮的 CSS color 驱动）。修改 svg 文件后需**手动同步** path 到 tsx。

**Popover viewport clamp**：`Toolbar.tsx` 里的 `ToolPopover` 用 `useLayoutEffect([anchorEl])` 测量后计算 `leftOffset`（超出视窗边缘时内缩）。popover 的 `transform: translateX(calc(-50% + ${leftOffset}px))` 移位，三角尖的 `transform: translateX(calc(-50% - ${leftOffset}px))` 反向抵消，永远指向按钮中心。`window.resize` 会触发重新测量。

**canUndo / canRedo reactive flags**：`redoStackRef` 是 ref（避免 push/pop 触发 re-render），但按钮 disabled 状态要 reactive。解法：Room.tsx 里 `const [canUndo, setCanUndo] = useState(false)` + 每次 strokesRef / redoStackRef 变动时调 `syncHistoryFlags()` 把 "> 0" 同步到 state。在以下位置都要调：
- WebSocket case: `roomState` / `draw end` / `clear` / `textStroke` / `shape` / `undo` / `redo`
- Local: `handleUndo` / `handleRedo` / `handleClear` / `handleTransfer` / `handleContinueDrawing` / `commitEditingText` / `commitEditingShape` / `handleLocalPenEnd`

**`onLocalPenEnd` callback 的存在**：useCanvas 内部 pen 笔画结束时直接 push strokesRef（不经过 Room）。Room 需要借此回调清空 redoStackRef + sync flags。Shape 工具走 `onShapeDrawn` 不经过这里。

---

## 九、⚠️ 追加坑点（本版功能相关）

1. **undo/redo broadcast 必须 `exclude sender`**（`this.broadcast({...}, ws)`）。否则 drawer 本地 pop 一次 + 收到自己的广播又 pop 一次 → **双步 bug**。其他消息（draw/textStroke/shape）都是 exclude 的，之前漏掉了 undo/redo。

2. **服务端 redoStack 不持久化**：Hibernate 后丢失。极端场景：drawer undo 后 idle 超过 DO hibernate 时间再点 redo，服务端 redoStack 空 → 不广播 → 对端画面不同步 drawer 本地状态，造成 diverge。当前接受此 trade-off（触发条件苛刻）；真要解决就把 redoStack 加入 `saveState()`。

3. **画板 aspect ratio 联动**：`Canvas.tsx` 的 `RATIO_W/H = 4/3` 与 `useCanvas.ts` 的 `OFFSCREEN_WIDTH:OFFSCREEN_HEIGHT = 1600:1200` 必须**比例一致**，否则离屏 drawImage 缩放会让图形变形。改画板比例时两处必须同步；`REF_WIDTH = 800` 是逻辑参考（不影响比例）但如果要改也要联动调整。

4. **`src/assets/*.svg` 只是源文件**：真正渲染用的 path 是**内联在 `Toolbar.tsx`** 的。svg 文件被修改后要手动同步到 tsx。想自动化就装 `vite-plugin-svgr`，当前没装。

5. **`editingShape` 拖动时 pixel + normalized 都更新**：overlay 用 pixel 做 CSS 定位，但 commit 时 send 用 normalized。两者通过 `rect.width` / `rect.height` 换算。resize canvas 期间拖动会 drift，但实际不会发生（用户不会一边 resize 一边拖）。

6. **Toolbar 的 popover outside click 监听 vs editingShape 的全局监听**：前者 `bubble` 阶段用于关闭 popover，后者 `capture` 阶段用于 commit shape。capture 先触发不冲突。但如果以后两者都用 capture 要想清楚执行顺序。

---

## 十、自定义颜色拾取器（Toolbar.tsx）

**库**：`@uiw/react-color`（不是 react-colorful，因为后者 hue 行为是 horizontal-only，不支持竖向 hue）。导出 `Saturation` / `Hue` / `Alpha` 原子组件 + `hexToHsva` / `hsvaToHex` 工具。peer dep 需要 `@babel/runtime`（已加）。

**组件结构**（都内联在 Toolbar.tsx）：
- `ColorPalette`：色行容器。7 固定色 + 分隔条 + 1 个自定义色块
- `CustomColorPanel`：二级浮层。SV 方块（240×140）+ 竖向 Hue 条（14×140）+ hex 输入 + 屏幕吸色按钮 + 清空 / 确定。**不包含 Alpha**（透明度功能已移除，颜色一律 6 位 hex）
- `customColor: string | null` state 提升到 `Toolbar` 函数层级（不是 ColorPalette 内部 state），保证 popover 反复开关后上次确认的自定义色不丢

**自定义色块视觉**：
- 背景：棋盘格 + customColor 覆盖（`panelOpen ? draft : customColor`，面板打开时实时跟随 draft）
- 右下角 8×8 彩虹三角（`linear-gradient(135deg, ...) + clip-path: polygon(100% 0, 100% 100%, 0 100%)`）—— 标识这是自定义入口
- 高亮 ring：仅当 panel 关闭、customColor 非 null、且 `value.toLowerCase() === customColor.toLowerCase()` 时显示

**屏幕吸色**：浏览器原生 `window.EyeDropper` API（Chrome 95+ / Edge 95+）。Firefox / Safari 不支持时按钮自动隐藏（`"EyeDropper" in window` 检测）。返回 `{ sRGBHex: "#rrggbb" }`，写入 draft 不再走 alpha 合成。

**Twind 抑制告警**：`@uiw/react-color` 给内部 div 加的 `w-color-*` 类（`w-color-saturation` / `w-color-hue` / `w-color-alpha-*` 等）以 `w-` 开头，会被 Twind runtime 当 width 工具类解析失败 → `[TWIND_INVALID_CLASS]`。在 `src/main.tsx` 的 `install` 配置里加了 `ignorelist: [/^w-color-/]`。

**色行 outside click**：`ColorPalette` 用 capture 阶段的全局 `mousedown` 监听关闭二级浮层。`data-color-panel` / `data-color-trigger` 标记浮层和触发按钮，`closest()` 命中则不关。

---

## 十一、油漆桶（bucket flood fill）

**协议**：`C_Fill` / `S_Fill`：`{ x, y, color, tolerance }`。`SerializedStroke.fill = { tolerance }`，`stroke.points = [{x, y}]` 存种子。

**算法**（`useCanvas.ts` 的 `scanlineFill`）：标准 scanline flood fill（4-邻域 + span tracking + 早返检查 target == fill）。tolerance per-channel（默认 32）。

**边缘抗锯齿**（`antiAliasFillEdges`）：scanline 完成后做一遍 1px 边界 alpha 混合 pass：
- 遍历所有未填充像素
- 若有任意 4 邻居是填充色，按「该像素离背景色的最大通道距离」算 α（FALLOFF=96）
- alpha-blend 填充色到该像素，消除填充与抗锯齿描边之间的 1~2px 白晕
- 双端确定性：纯整数运算 + Uint8ClampedArray clamp，A/B 两端跑出的像素完全一致，不需要传位图

**白底初始化**：offscreen 在所有"重置"路径都要 `fillStyle = "#ffffff"; fillRect(...)` —— 否则 flood fill 在未初始化（透明黑）的画布上会无限蔓延。

**桶不带 alpha**：fill 只用 `(fr, fg, fb)`，paint 时 `data[idx+3] = 255`。透明度反直觉（多次填充会叠加），永远不应用。

**⚠️ visited 位图（关键修复，不可回退）**：scanlineFill 内部用 `Uint8Array(w * h)` 记录已 paint 的像素，`matches()` 优先检查 visited 返回 false。**这是必要的**：fill 色与 target 色在容差内但不**完全相等**时（吸管吸到画布反走样像素的经典场景），painted 像素的 RGB 仍落在 matches 容差里，**没有 visited 会反复 push 进 stack 导致死循环 (Array.push 抛 `RangeError: Invalid array length`) + 浏览器卡死崩溃**。matches/paint 的入参是像素索引 `px`（不是字节偏移 `idx`），内部 `idx = px * 4`。

**offscreen `willReadFrequently: true`**：offscreen canvas 创建时一定要用 `getContext("2d", { willReadFrequently: true })` —— bucket 每次 fill 都要 `getImageData` 整张 readback，不设此 flag 浏览器走 GPU readback 慢路径并发 console warning（`Multiple readback operations using getImageData are faster with willReadFrequently...`）。flag 一旦 context 创建就固定，所有后续 `offs.getContext("2d")` 返回同一个 context 忽略 flag，所以仅需在初始化处设置一次。

---

## 十二、画笔逐帧重绘（pen overdraw 修复）

**旧 bug**：`onMouseDown` 调 `ctx.beginPath() + ctx.moveTo(...)`，每次 `onMouseMove` 调 `ctx.lineTo(...) + ctx.stroke()`。后者 stroke 的是从 beginPath 起的**整条累积路径** → 每个像素被反复涂 → alpha < 1 时透明度叠加成不透明。在 alpha 还存在时这是用户报的 bug，移除 alpha 后是 dead code 路径但依然修了（行为更直观）。

**修法**（`tool === "pen"` 块）：
- `onMouseDown`：仅记录起点 + send `start`，不动 ctx
- `onMouseMove`：push 点到 `currentStrokeRef.points` + `pendingPointsRef`，scheduleFlush
- `flushPendingMove`（RAF 帧）：先 send 网络批量 move，然后 `syncVisibleFromOffscreen()`（committed strokes）+ `drawInProgressStroke()`（当前 stroke 一次性 beginPath + 所有 lineTo + stroke）。**每帧重画 = 每个像素只涂一次**
- `onMouseUp`：commitToOffscreen + syncVisibleFromOffscreen + send end
- `replayDraw`（peer 端）同样改成「sync offscreen + 重绘 in-progress」

**代价**：每 RAF 帧多一次 `drawImage(offs, 0, 0, w, h)`（~0.5ms 量级 @ 1067px wide）+ 一次完整路径重绘。60fps 持续 ~30ms/sec，可忽略。

---

## 十三、形状工具越界处理

**旧行为**：`onShapeLeave`（mouseleave）把 `shapeStart = null + syncVisibleFromOffscreen` 清空预览 → 鼠标一滑出画布形状就消失，UX 突兀。

**新行为**（参考 pen 的「mouseleave = 在边界处提交」）：
- `mouseleave` 直接绑到 `onShapeUp`（同一 handler，与 mouseup 共用）
- `clampToCanvas(e)` helper 把 `offsetX/Y` 钳到 `[0, canvas.width/height]`，替代裸 `normalize()`。`onShapeMove` / `onShapeUp` 都用它
- 越界时 `offsetX/Y` 必然超出，钳到边缘后形状的终点正好落在画布边界 → 弹 editing overlay，用户可继续调整

**注意**：selection 工具的 `onLeave` 行为没改（语义不同，涉及 patch 提取）。

---

## 十四、协议追加（v1，非破坏性）

`SerializedStroke` 新增可选字段（`PROTOCOL_VERSION` 仍为 1，纯加字段不算破坏性）：
- `fill?: { tolerance: number }` —— 油漆桶填充。`stroke.points = [{x, y}]` 是种子点；`stroke.color` 是填充色
- `selection?: { srcX, srcY, w, h, dstX, dstY }` —— 框选移动。所有值归一化 `[0, 1]`。canvas 三步：从 src 取 patch → 把 src whiten 成白 → 把 patch 贴到 dst
- `shape: "line"` 加入 shape 联合（原有 rect/ellipse/arrow）

`worker/src/types.ts` / `worker/src/room.ts` 镜像加这些字段；`onShape` / `onFill` / `onSelection` 三个 handler 同型——存进 strokes、清 redoStack、broadcast exclude sender、saveState。

---

## 十五、依赖管理

- **新增**：`@uiw/react-color`（颜色拾取器）+ `@babel/runtime`（@uiw 的 peer dep）
- **历史新增过又移除**：`react-colorful` —— 一开始用，后来因不支持竖向 hue 换成 @uiw（commit `2da549e`）
- **历史新增过又移除**：`useRecentColors` hook + `stripAlpha` 工具 —— 最近色和透明度功能都被用户砍掉
- 装包统一加 `--legacy-peer-deps`（`@twind/core` peer 范围旧）

---

## 十六、心形几何（pathHeart / svgPathHeart）

6 段贝塞尔，几何参考 Material Icons ❤️ 的圆润心形：
- 起点 `(cx, h)` 底部尖端，顺时针绕一圈
- 凹槽 notch 在 `(cx, 0.114h)` —— 故意做得很浅，让顶部凹槽视觉柔和（旧版 0.30h 太深，凹槽刺眼）
- 左/右瓣顶尖在 `(0.275w, 0)` / `(0.725w, 0)` —— 收拢到中心一些，避免顶部展成水平长条（旧版在 0.30w 处水平切线 + 相邻控制点贴 y=0，曲线在两瓣顶部"贴着 y=0 水平爬"）
- 段 2/3/4/5 通过相邻控制点保持 C1 平滑（控制点共线），瓣顶是圆弧顶点而非平台
- 底部尖端两侧控制点 `(0.17w/0.83w, 0.673h)`，斜向 ~45° 收敛 —— 不针状

`pathHeart` (canvas) 与 `svgPathHeart` (编辑态 SVG 预览) **必须几何完全一致**——overlay 预览要与 canvas 渲染像素对齐。改一边必须同步另一边。

---

## 十七、Room.tsx 连接管理（关键，不要回退）

### listener 必须用 ref 模式
`Room.tsx` 的消息 listener 用 `messageHandlerRef` 持有最新闭包，effect 依赖只留 `[addListener]`，**注册一次永不卸载**。

为什么不能用普通 useEffect + 依赖列表：曾经依赖里有 `editingSelection / onLeave / addSystemMessage` 等多达 14 项变化值，每次变化都触发 add/remove listener。`ws.onmessage` 是浏览器原生事件，理论上可能撞上 listener 卸载窗口导致 `roomState` 等关键消息丢失 → 客户端永远卡在「连接中…」。

ref 模式：每次 render 重新赋值 `messageHandlerRef.current = (msg) => { ... }`（render body 里直接赋值），闭包通过 React 闭包语义自动看到最新 state；listener 从 ref 调用 → 永远命中最新 handler。**不要改回 `addListener((msg) => switch...)` 直接传匿名函数 + 依赖数组的写法**。

### join 超时（首次加入兜底）
`hasJoinedOnceRef` 标记是否曾经收到过 roomState：
- 首次加入：10s 内仍 `myId == null` → 设 joinError → 1.5s 后退出
- 重连场景（`hasJoinedOnceRef.current === true`）：跳过此超时，给慢网络足够时间

### joinError 统一退出 effect
任何路径 setJoinError 后，统一由一个 effect 在 1.5s 后调用 `onLeave`，cleanup 时取消 timer。`case "error"` / `case "roomClosed"` / join 超时三处都走这条路径。**不要在 case 内部各自 setTimeout**——会导致 timer 散落难追踪、且 onLeave 可能被多次调用。

### 重连不阻断 UI
渲染条件 `if (!myId || joinError)` 切错误屏（首次未加入 / 加入失败 / 房间被关）。已加入后 ws 断开（`!connected`）保留主 UI，顶部加黄色 banner「网络异常，正在重连…」。画板和聊天上下文不消失。

### case "roomClosed" 走 joinError 路径
设置 `setJoinError("房间已关闭：" + reason)` 立即切错误屏。**不要回退到 `addSystemMessage + setTimeout(onLeave)`**——那条路径会让服务端紧接着的 ws.close 触发 setConnected(false)，主 UI 上闪一下重连 banner，体验上像 bug。

---

## 十八、服务端 storage 写入节流

### touchActivity 节流（关键性能优化）
`touchActivity` 在每条非 `join`/`ping` 消息上调用，原本每次都 `storage.put("lastActivityAt")` + `setAlarm`。画手 60Hz 画画时**每秒 60 次 storage 写**，1000 房间满载 = 6 万次/秒 = Cloudflare DO 计费黑洞。

现在改成节流：内存值 `this.lastActivityAt` 每次都更新（保证 inactivity 检查准确），但 `storage.put` + `scheduleNextAlarm` **仅当距离上次持久化超过 `ACTIVITY_PERSIST_MIN_INTERVAL_MS` (30s) 才执行**。新字段 `lastActivityPersistedAt` 仅内存维护，**不持久化**——DO 重启后回到 0，第一次 touchActivity 立即触发持久化（`now - 0 >> 30000`），状态自动同步回一致。

收益：storage 写入量降 ~1800 倍。代价：inactivity 触发精度从「立即」降到 ±30s，10 分钟阈值下完全可忽略。

关键约束：
- **`onDisconnect` / `/quickleave` 路径直接调 `scheduleNextAlarm`，不走节流** —— grace 期（30s 或 5s）的 alarm 时间需要精准。
- 节流跳过 alarm 重设可能让 alarm 比真实理想触发时间略早 30s，但 alarm 末尾的 `scheduleNextAlarm` 会重新基于内存里最新 `lastActivityAt` 推到下一次合适时间，最终销毁时刻仍准确。

### 房间销毁时重置 lastActivityAt
`processActualLeave` 末尾「空房间」分支显式 `this.lastActivityAt = 0`（与 inactivity 路径对齐）。否则下次 `/init` 复用此 DO 时，scheduleNextAlarm 可能基于旧值算出已过期的 inactivity 时间点。`saveState` 已覆盖此字段，单加一行赋值即可。
