# CLAUDE.md

本文件为 AI 助手（Claude Code 等）提供该仓库的上下文。人类阅读请直接看 `README.md`。

> 项目：**🎨 我画你猜** · 2~6 人实时画画猜词游戏
> 线上：https://draw-guess.dengjiabei.cn

---

## 一、项目速览

- **纯前端**：React 18 + TypeScript + Vite + Twind（CSS-in-JS Tailwind）
- **后端**：Cloudflare Workers + Durable Objects（Hibernatable WebSocket + SQLite backend）
- **实时通信**：WebSocket JSON 消息
- **部署**：GitHub Actions（`ci.yml`）：检查通过后先部署 Workers（后端），再部署 Cloudflare Pages（前端）
- **单仓库两个包**：根目录是前端，`worker/` 是后端，两边各自 `package.json` 与 `tsconfig.json`

## 二、目录结构

```
├── src/                          # 前端
│   ├── main.tsx                  # 入口，Twind install
│   ├── App.tsx                   # 顶层路由（首页 / 昵称弹窗 / 房间）；房间页懒加载
│   ├── api.ts                    # apiUrl / wsUrl 工具
│   ├── pages/
│   │   ├── Home.tsx              # 创建 / 加入房间
│   │   └── Room.tsx              # 主游戏页，消息分发 + 撤销/重做栈
│   ├── components/
│   │   ├── Canvas.tsx            # 画板容器 + 文字/形状/框选编辑 overlay
│   │   ├── Toolbar.tsx           # 12 种工具 + ColorPalette/CustomColorPanel 颜色选择 + undo/redo/clear
│   │   ├── PlayerBar.tsx         # 顶栏房间号、玩家、操作按钮
│   │   ├── ChatPanel.tsx         # 聊天 / 设答案 / 猜词三合一输入
│   │   ├── Confetti.tsx          # 猜对时的彩带雨（canvas + RAF）
│   │   ├── Toast.tsx             # 右上角错误提示（取代粗糙的 system message）
│   │   └── ErrorBoundary.tsx     # 渲染出错、页面代码下载失败时的提示
│   ├── hooks/
│   │   ├── useWebSocket.ts       # WS 连接、重连、心跳、leave/pagehide
│   │   └── useCanvas.ts          # 画布事件、笔画、归一化坐标、离屏画布
│   ├── utils/
│   │   ├── color.ts              # normalizeColor（hex 字符串规范化）
│   │   ├── textColor.ts          # 文本局部上色的区间计算
│   │   ├── floodFill.ts          # 油漆桶算法（纯函数，只碰 RGBA 缓冲区）
│   │   ├── brushes.ts            # 手绘笔型渲染器（普通笔、喷枪、蜡笔、水彩）
│   │   ├── strokeReplay.ts       # 离屏重放：记录画到第几笔、检查点、分片
│   │   └── handFont.ts           # 手写字体的样式表加载和字形下载
│   ├── assets/                   # 图标源文件（SVG），当前用 inline path 镜像到 Toolbar
│   └── types/protocol.ts         # ⭐ 前后端共享的消息类型契约
├── worker/
│   ├── src/
│   │   ├── index.ts              # HTTP 入口 + 路由到 DO + Origin 白名单
│   │   ├── room.ts               # ⭐ GameRoom Durable Object（状态机 + 消息 handlers）
│   │   ├── types.ts              # DO 内部类型（PlayerAttachment, DisconnectedPlayer 等）
│   │   ├── constants.ts          # 所有可调参数（grace、limits、protocol version）
│   │   ├── validate.ts           # 客户端消息的入口校验（类型、范围、只留认识的字段）
│   │   └── helpers.ts            # 纯函数 helpers（strokeKey, answerMatches）
│   └── wrangler.toml             # durable_objects + routes + 兼容日期 + 日志
├── public/_headers               # Pages 响应头（CSP、HSTS、资源缓存）
├── tests/
│   ├── unit/                     # vitest：不依赖运行时的纯逻辑
│   └── regression/               # 真实 workerd + 真实浏览器的断言式回归（见第二十一章）
└── .github/workflows/ci.yml      # 检查 → 部署 Worker → 部署 Pages
```

## 三、核心设计要点

### 1. Hibernatable WebSocket
`this.state.acceptWebSocket(server)` 接受连接后，Durable Object 进程可**在无消息时被回收**，唤醒时通过 `this.state.getWebSockets()` 恢复所有 ws。玩家身份存在 **ws attachment** 里（`serializeAttachment` / `deserializeAttachment`）以跨休眠保留。

### 2. 状态持久化策略
- **ws attachment**：玩家身份（id / name / token / quickLeave）— 跟着连接走；还没 join 的连接存 `unjoinedSince`
- **DO storage**（SQLite backend）：房间元数据（phase / drawerId / answer / strokes / chatHistory / disconnectedPlayers / roster）
- `ensureLoaded()` 第一次访问时从 storage 恢复内存快照；之后所有读操作用内存
- `saveState()` / `state.storage.put(key, value)` 写回

### 3. 断线 / 重连模型
两级 grace period：

| 场景 | Grace | 触发方式 |
|------|-------|----------|
| 正常断线 | 30s | `ws.onclose` → `onDisconnect` 进入 `disconnectedPlayers` |
| 页面刷新 / 关闭 | 5s | `pagehide` → `navigator.sendBeacon('/quickleave')` 打上 `quickLeaveAt` 标记（10 秒内断线才算数：beacon 可能比新页面的 join 晚到，落在已接管的新连接上） |
| 主动离开 | 即时 | 前端发 `{type:"leave"}` → 服务端 `onLeave` → `processActualLeave`。连接不在时（正在重连）改发 quickleave，5 秒后释放席位 |

超时由 `alarm()` 统一处理；`scheduleNextAlarm()` 会取 `min(所有 disconnected grace 结束时刻, lastActivityAt + 10min, 最旧的未加入连接的超时时刻)`。

**保留期内的玩家仍算在房间里**：`getPlayerInfoList` 会列出他们（`connected: false`），人数判断一律用 `getEffectivePlayerCount`。有人断线或重连时广播全量 `playerList`（只更新列表，不产生提示）。不要改成重发 `playerJoined`：那是增量消息，旧客户端会重复加人。

前端的“转让”只能选在线玩家：两人房对方离线时按钮禁用，3+ 人房离线候选禁用（服务端只接受在线目标，竞态下会回 error，前端显示 Toast）。画手离开时优先选在线的下家，都不在线才退到保留期玩家。

**实例崩溃 / 强制更新**：连接没了但 close 事件没跑，玩家不在 `disconnectedPlayers` 里。`ensureLoaded` 末尾的 `reconcilePlayers()` 对账：`joinOrder` 里既没连接又不在保留期的玩家转入保留期，名字和 token 从持久化的 `roster` 取。新增玩家字段时记得同步 `roster`（`rememberPlayer`）。

### 4. 玩家身份恢复
- `playerId` 是公开的（玩家列表人人可见），**不能当凭证**。凭证是 `playerToken`：客户端第一次连接前自己生成，存 `sessionStorage(draw-guess-playerToken)`，服务端只收不发，不进任何广播
- **token 由客户端生成，不要改成服务端下发**：join 处理完席位就占了，roomState 没送到就断线的话，客户端还不知道自己的 id，只有 token 能把它带回原身份，否则重试只能当陌生人（两人房直接“房间已满”）
- 前端在 `roomState` 到达后把 `yourId` 存到 `sessionStorage(draw-guess-playerId)`，离开房间时 id 和 token 都清掉
- 刷新后 `App.tsx:useEffect` 读取 sessionStorage，`useWebSocket` 携带 playerId 和 playerToken 连接
- 服务端 `onJoin` 检查两路，都先过 `ownsIdentity`，不通过一律当新玩家（不提示原因）：
  1. `disconnectedPlayers` map（已经走过 onDisconnect）→ 恢复 attachment
  2. 已存在的 ws（旧连接尚未 close）→ **take over**：关闭旧 ws，新 ws 继承身份
- `/quickleave` 同样校验 token。token 放在 beacon 的请求体里，不进 URL；Worker 读出来后放进内部请求头转给 DO
- **过渡期**：旧 JS 的 join 不带 `playerToken`，身份没有 token，只能凭 id（开着的旧标签页还要能重连），刷新拿到新 JS 时记下它的 token。**线上不再有旧客户端后，去掉 `ownsIdentity` 里 `stored.id === playerId` 这个分支**，否则保护有缺口

### 5. 游戏阶段机（`GamePhase`）
```
waiting        ← 初始，只有 1 人时
  ↓ 第二人加入
drawing        ← 画手自由画
  ↓ setAnswer
guessing       ← 猜词方开始猜；画布不能再改
  ↓ 猜对
revealed       ← 可 "继续出题" 回到 drawing，或 "转让画笔" 切换画手
```
状态只在 `room.ts` 服务端变更，客户端通过 `phaseChange` 被动同步。唯一的本地动作是 Room.tsx 的 `answerPending`：答案发出去到 phaseChange 回来的这一小段时间锁住画布（服务端一处理 setAnswer 就丢弃之后的画布操作）。**不要改成本地直接切 phase**：万一答案没送到，ChatPanel 已经切回聊天模式，用户重打答案回车就发到公开聊天了。

**输入框默认模式**（`ChatPanel` 的 `preferredMode`）：画手在绘画阶段默认答案模式，猜词方在猜词阶段默认猜词模式，其余是聊天。默认聊天的话，直接打出来的答案会明文发给所有人（服务端另有兜底，见第七章“聊天里的答案”）。阶段或角色变化时切过去，同一阶段里手动切走的保持不变。输入框里有字时：当前模式还能用就**先不切，这条发出去（输入框空了）再切**，否则正在打的聊天一回车就成了答案或猜测，切不过去的话又会整个阶段停在聊天；当前模式不能用了（打的是答案或猜测，比如对方离开回到 waiting）就**把字丢掉**，退回聊天还留着的话一回车答案就公开了。切模式时把焦点给输入框，但不抢别的输入框（画手可能正在画布上打字），也不滚动页面（`preventScroll`：窗口比 body 的 1200px 窄时会横向滚，画布在鼠标底下挪位）。测试里用 `T.mode('确认' | '猜测' | '发送')` 切到指定模式。

聊天、猜词、设答案三个回调都返回是否发出去了：没发出去时 Room 弹 Toast，ChatPanel 把内容放回输入框。回车先看输入法是否在组词（`isImeComposing`：`isComposing` 或 keyCode 229，Safari 的 compositionend 先于 keydown），昵称弹窗同理。聊天区最多留 300 条（`MAX_MESSAGES`，服务端历史是 200 条）。

`waiting ⇄ drawing` 只由 `recomputePhase()` 判定：按 `getEffectivePlayerCount`（含保留期玩家）算，≥2 人离开 waiting，<2 人回到 waiting 并清答案。phase 真的变了才广播 `phaseChange`，别按人数直接发。

### 6. 画板坐标归一化与分辨率
- 所有 `{x, y}` 在线上协议和存储里都是归一化值，正常在 `[0, 1]`，但可以越界（鼠标滑出画布、编辑框拖到画布外）。画布实际像素 = 归一化 × `canvas.width`
- `REF_WIDTH = 800` 是逻辑参考宽度，用于 `scaleLineWidth` / 字号缩放（clamp 0.5~2.0 倍）
- `OFFSCREEN_WIDTH × OFFSCREEN_HEIGHT = 1600 × 960`（5:3，与 visible 比例一致）：实际离屏画布尺寸，2× 线性分辨率，曲线/油漆桶在更高分辨率下渲染再 bilinear 下采样到 visible，显著减少阶梯锯齿
- 两个常量解耦：visible 渲染用 `canvas.width / REF_WIDTH` 算 scale；offscreen 渲染用 `1600 / 800 = 2.0` 算 scale；最终 drawImage 缩到 visible 后两者视觉粗细一致

### 7. 工具系统（12 种 + 编辑态）

12 种工具见 `Toolbar.tsx` 的 `ToolMode`（下面的分组是早期版本，三角形、五角星、心形、橡皮擦是后来加的）。工具栏左→右分 6 组（用竖线分隔）：油漆桶和框选移动各自独占一栏，把"区域填充"和"像素搬运"两类区别于规则形状的工具单独凸显。
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

**清除要点两下**（`ClearButton`）：清除不能撤销。第一下按钮变成「确认清除？」，3 秒内再点才清；刚变过来 600ms 内的点击不算（系统双击间隔默认 500ms），按住回车的自动重复（`e.repeat`）也不算。判断用 ref，连点时第二下比重渲染先到。测试里用 `T.confirmClear()`（返回确认那一下有没有点到）。

**画布只认左键**（useCanvas 的 `isPrimaryPress` / `leftButtonHeld`。Canvas.tsx 的编辑框拖动、缩放只靠 move 里的 `leftButtonHeld`：右键拖动第一下移动就停，开始拖动时的按键判断看不出效果，就没加）：
- 按下要 `button === 0` 且没按 Ctrl（macOS 的 Ctrl+点击是右键菜单，菜单会吞掉 mouseup）；只认左键的 mouseup，左键拖动中松开右键不结束
- 拖动中收到左键没按着的事件（`buttons & 1` 为 0：在画布外、别的窗口或右键菜单里松开了，没收到 mouseup），在最后一个按着的位置结束，不能接着画。mouseleave 也看这个：左键还按着就在边界处结束，已经松开了就停在松开前的位置
- 窗口失焦（`blur`，按住时切到别的窗口）直接结束，否则喷枪会一直喷到人回来

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
- arrow / line 编辑 overlay 用 SVG（`overflow: visible` 处理退化 bbox）。实心的 rect/ellipse 用 DOM `div` + background（正好填满 bbox）；线框的 rect/ellipse 和三角形、五角星、爱心一样用 SVG 描边：以路径为中心、里外各占半个线宽，和画布的 stroke 一样。以前用 CSS 边框，边框整个画在盒子里面，提交时形状会“跳”半个线宽，形状比线宽还细时盒子还会被边框撑大

### 9. 撤销 / 重做

双端维护对称 redoStack：
- **客户端**：Room.tsx 的 `redoStackRef`（ref，非 state）+ `canUndo`/`canRedo` state（用于 Toolbar 按钮 disabled）
- **服务端**：`room.ts` 的 `redoStack: SerializedStroke[]`，分 key 持久化在 `redo:NNNNNNNNNN`（序号 = 栈位置），休眠后恢复
- `roomState.redoStack` 下发服务端的栈：`redo` 广播不带笔画内容，重连者和新人要靠它才跟得上
- `syncHistoryFlags()` 在每次改动 strokesRef/redoStackRef 后同步 state

核心规则：
- `onUndo`：strokes.pop → redoStack.push → broadcast **exclude sender**（否则发起者会二次 pop，⚠️ 曾经犯过这个 bug）
- `onRedo`：redoStack.pop → strokes.push → broadcast **exclude sender**
- 任何新笔画（pen end / textStroke / shape）→ 服务端和两端客户端都清空 redoStack
- clear / transfer / continueDrawing / alarm reset / processActualLeave → 同清

---

## 四、⚠️ 已知坑点（开发前必读）

> 这些点是过去踩过或代码里已隐含约束，改动相关区域请特别小心。

1. **桌面端专用（有意为之）**：`index.html` 有 `min-width: 1200px`，`useCanvas.ts` 已删除 Touch 事件处理。若未来要支持移动端需独立布局，不要简单移除 min-width。只有触屏的设备（`any-pointer: coarse` 且没有 `fine`）打开时先显示 `TouchNotice`（请用电脑打开，可以选择继续），同一标签页继续过一次就不再拦。提示挡着的时候不预加载房间页；读写 sessionStorage 都包了 try（Safari 阻止所有 Cookie 时会抛 SecurityError，首屏就要读它）。

2. ~~**WebSocket 无自动重连**~~ ✅ 已修复：`useWebSocket` 带指数退避重连（1s→8s，带抖动；上限要小于 30 秒保留期，否则网络恢复了也赶不上；收到 `online` 事件立刻重连）。close reason 在 `TERMINAL_CLOSE_REASONS` 里就不重连（只看 reason，不看 code：限流是 1008），并通过 `terminalReason` 交给 Room 切错误屏。重连时优先读 `sessionStorage` 里最新的 `playerId`（mount 时的 prop 可能已过期），走服务端 take-over / disconnectedPlayers 恢复分支。

3. ~~**房间号冲突**~~ ✅ 已修复：parent Worker 循环最多 5 次；`/init` 已创建时返回 **409**，调用方据此换码重试（没人且已过闲置期的孤儿房除外，直接复用）。新增 `/init` 时注意保持这个语义。

4. **`saveState()` 是全字段写**：`strokes` 和 `chatHistory` 都在里面。频繁调用会放大写入。已经对 `onDraw` 做了"只在 end 时 put strokes"的优化，其他地方慎用。

5. **DO storage 单值 2 MB 上限**（SQLite 后端）：笔画分 key 存；单笔手绘最多 `MAX_STROKE_POINTS` 个点、路径长度最多 `MAX_STROKE_PATH`（两边常量要一致），客户端到上限前自动分段（结束当前笔，从同一点接着画）。房间总量另有预算 `MAX_ROOM_STROKE_COST`，超了服务端拒收并提示。

6. **`touchActivity()` 在 `join` 类型消息里不会被 `webSocketMessage` 的通用分支调用**：`onJoin` 内部显式 touch。新加类型时注意这个约定。

7. **`executeTransfer` / `onContinueDrawing` 会发 3 条 broadcast**（transferDone/clear/phaseChange）：顺序敏感。前端 Room.tsx 的 switch 里依赖的就是这个顺序。

8. **前端 `msgIdCounter` 是模块级 `let`**：React StrictMode / 组件 remount 下不重置。靠 `++` 保证唯一即可，别改为 useState。

9. **Twind 条件 class 语法**：`tx("base", cond && "cls-a")`。`false` 会被 Twind 忽略，但别写成 `cond ? "a" : "b"` 和纯字符串混用时出现奇怪优先级。

10. **`App.tsx` 用 `window.history.replaceState`（不是 pushState）**：浏览器返回键不会退出房间，是有意的。

11. ~~**中文答案匹配**~~ ✅ 已修复：见第七章“答案归一化”。

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
2. 去 `worker/src/validate.ts` 加校验（没写的字段到不了 handler）；范围放宽一点，合法消息被丢弃会造成分叉
3. 去 `room.ts` 的 switch-case 手动加处理
4. 两端都要跑 `tsc --noEmit`

### 部署
- 推 `master` 就上线（`ci.yml`）：先跑类型检查、Lint、格式检查、单元测试、协议回归，通过后部署，**同一次运行里 Worker 先于 Pages**。Worker 部署失败时前端不上
  - 部署什么由 `.github/scripts/deploy-plan.mjs` 决定：和**这个目标上一次部署成功的提交**比，不只看这次 push。上一次检查没过、部署失败或被取消，它的改动会算进下一次。查不到记录就都部署
  - 两个部署各有一个 concurrency 组，排队时被更新的运行挤掉的部署，会由挤掉它的那次运行一起部署
  - 部署 job 的名字（Deploy Worker / Deploy Pages）是 deploy-plan.mjs 查记录用的，改名要一起改
  - 改到 `worker/**` → 部署 Worker
  - 改到 `worker/**`、`tests/**`、`docs/**`、`.github/**`、`.claude/**`、`*.md` 以外的文件 → 部署 Pages
  - 浏览器回归也会跑，但目前不挡部署
- 手动：`npm run deploy:worker` / `npm run deploy:pages`（Pages 按当前 git 分支决定环境：在 master 上是生产，其他分支是预览）
- 响应头改 `public/_headers`（只对 Pages 生效，`/api/*` 归 Worker）。CSP 的 `connect-src` 写死了线上域名，换域名要同步
- **不要给 `/assets/*` 加 immutable 或长 max-age**：Pages 对不存在的文件回退成 index.html（状态码 200），会带上同样的响应头，浏览器就把这份 HTML 当成那个 JS 缓存下来，回滚到同一个 hash 时刷新也加载不了。要加就先加 `404.html` 改掉回退，但房间链接 `/123456` 会变成 404，分享预览要先验证

---

## 六、修改某个区域时常用的入口

| 我想做… | 先看这里 |
|---------|---------|
| 加一种 WS 消息 | `src/types/protocol.ts` → `worker/src/validate.ts` → `worker/src/room.ts:webSocketMessage` → `src/pages/Room.tsx:addListener switch` |
| 改画板交互 | `src/hooks/useCanvas.ts`（事件）+ `src/components/Canvas.tsx`（DOM） |
| 改游戏阶段流转 | `worker/src/room.ts` 的 `onSetAnswer` / `onGuess` / `onContinueDrawing` / `executeTransfer` |
| 改断线 / 重连 | `useWebSocket.ts`（前端）+ `room.ts` 的 `onJoin` / `onDisconnect` / `alarm` |
| 改 UI 样式 | 组件里的 `tx(...)`；全局主题色在 `src/main.tsx` 的 Twind `install({theme:{extend:{colors}}})` |

---

## 七、未完成 / 待改进（Roadmap）

按优先级，详见分析报告：

- ~~**P0**~~：全部已处理 — WebSocket 重连 ✅ / 桌面端定位 ✅ / 房间码冲突 ✅ / 输入长度限制 ✅
- ~~**P1**~~：全部已处理 — WS 心跳 ✅ / 答案归一化 ✅ / draw RAF 批量 ✅ / strokes 分片存储 ✅
- **P2**：Origin 白名单 ✅ / rate limit ✅ / 错误 Toast ✅ / 文字点击空白 commit ✅ / ESLint + Prettier ✅ / 状态机回归 ✅（`tests/regression`）
- **P3**：协议版本号 ✅ / `room.ts` 拆文件 ✅ / ~~draw 二进制协议~~ ⏭ / 离屏 canvas 缓存 ✅ / Confetti 改 canvas 渲染 ✅

> **为什么跳过 draw 二进制协议**：permessage-deflate 已经压掉 JSON 的冗余，实际带宽 <40 KB/s 峰值。手写 binary 协议需要前后端双端 encode/decode + bump 协议版本 + 维持 JSON fallback，工程成本大但收益边际。如果某天带宽成了瓶颈再做，现在不值。

**输入长度硬限制（服务端常量 in `worker/src/constants.ts`）**：
- `MAX_NAME_LENGTH = 10`
- `MAX_ANSWER_LENGTH = 20`
- `MAX_CHAT_LENGTH = 200`（guess/chat 共用）
- `MAX_TEXT_STROKE_LENGTH = 100`

客户端各 input 的 `maxLength` 应与上述常量一致，改一边别忘另一边。

**心跳（ping/pong）**：客户端 `useWebSocket` 每 25s 发 `{type:"ping"}`，由 constructor 里的 `setWebSocketAutoResponse` 在运行时直接回 `{type:"pong"}`：不唤醒 DO、不进 `webSocketMessage`，也不算活动（否则 10 分钟 idle 定时器会被重置，auto-close 永远不触发）。请求串必须和客户端 `JSON.stringify({ type: "ping" })` 逐字相同，改一边要同步另一边；`case "ping"` 只是回退。pong 在 `useWebSocket.onmessage` 里就被吞掉，不经过 listener。ping 发出后 10 秒内什么消息都没收到，就当连接半开：解绑事件后按断线处理（半开时 `ws.close()` 等不到 `onclose`），重连走服务端的接管路径。**roomState 到达之前不计这个超时**：它可能很大，下载期间 pong 排在后面，慢网下会被误判成半开，关掉重下，永远完不成。握手另有 15 秒超时，卡住的握手不会很快失败，否则挡住所有重试。

**答案归一化**：`worker/src/helpers.ts` 的 `answerMatches()`，比较时两侧跑 `normalizeForCompare()`：NFKC + lowercase + 去空格 + 去 `\p{P}` 标点（保留 emoji / 数字 / 字母 / CJK 字）。答案只有标点时归一化后是空串，任何只含标点的猜测都会相等，所以这种情况保留标点比较。`this.answer` 存**原文**（画手面板展示用、`answerLength` 算用）。不要图方便直接存归一化后的，会让画手看到 "答案：你好！" → "你好"。

**聊天里的答案**：猜词阶段猜词方发的聊天和答案一致（`answerMatches`）时，`onChat` 按猜测处理（走 `onGuess`），不当聊天广播，否则答案明文发给了所有人（输入框停在聊天模式，或者旧版页面默认聊天）。只是包含答案的、画手发的、其他阶段的聊天照常。

**draw 消息 RAF 批量**：`C_Draw.points?: {x,y}[]` 为可选批量字段。客户端 `onMouseMove` 把点塞进 `pendingPointsRef`，每帧 `requestAnimationFrame(flushPendingMove)` 检查一次，距上次发送满 16ms 才合并发送（没到时间点留在队列里）；`onMouseUp` 前不受节流限制，先发完再发 `end`。服务端 `onDraw` 的 move 分支 `msg.points ?? [{x:msg.x,y:msg.y}]` 兼容单点。`replayDraw` 同样处理 `points` 数组。

**`end` 带整笔**：`draw end` 的 `stroke` 字段是这一笔的完整内容，服务端以它为准存盘，广播的 `end` 也带上存下的笔画，对端以它为准。start / move 只用于显示进行中的笔画，丢了不影响结果：DO 休眠会丢内存里的缓存，断线时 start 发不出去，中途加入的人也没有 start。`replayDraw` 处理 `end` 时不依赖可见画布：roomState 刚到时 Canvas 还没挂载，这时到的 `end` 不能丢。

旧客户端的 `end` 不带这个字段，服务端回退到缓存，颜色和线宽用 `end` 上的。缓存丢过 start（中途休眠）时内容不完整，广播就不带 `stroke`，对端用自己累积的点，别用残缺的覆盖掉。

**渲染成本**：蜡笔、喷枪的成本和路径长度成正比，所以校验里限制单笔路径（`MAX_STROKE_PATH`），`move` 超过累计上限后不再转发，房间总量有预算（`strokeCost`）。对端的 `move` 按帧合并，一帧最多重绘一次；进行中的喷枪、蜡笔只补新线段（见第十二章）。

**strokes 分片存储**：strokes 不再用单 key `"strokes"` 存，每条独立 key `stroke:0000000001` …，避免单值大小上限。关键点：
- 写入：新笔画一律走 `commitStroke()`：put 单条 + 清 redo，同一批原子提交。超出房间预算时它返回 false，调用方不要广播
- 撤销 / 重做：`onUndo` / `onRedo` 在 `stroke:` 和 `redo:` 之间搬一条，同样不在两次写之间 await
- 清空：重置 strokes 的地方调 `clearStrokeStorage()` + `clearRedoStack()`（onClear / onContinueDrawing / executeTransfer / drawer 离开）；销毁房间走 `resetRoom()`
- `saveState()` **不再** put strokes 字段
- `ensureLoaded()` 用 `list({prefix})` 恢复 `stroke:` 和 `redo:`
- batch delete 上限 128 key/次，`clearStrokeStorage` / `clearRedoStack` 内部已分批；`clearRedoStack` 空栈时不写存储

**Origin 白名单**：`worker/src/index.ts` 的 `isAllowedOrigin()` 是**所有** API 路由 + WebSocket upgrade 的入口闸门。接受 production 域名 + 任意 `localhost` / `127.0.0.1` 端口。**缺失 Origin header 一律 403**（不把无头请求当可信）。新增后端接口时记得它也会被闸门拦——如果故意要开放，在 if 前面开白。`corsHeaders(origin)` 始终回 echo 来的 origin，不再用 `*`。

**消息校验**：`webSocketMessage` 先过 `parseClientMessage()`（`worker/src/validate.ts`）：类型、范围都合法，只留认识的字段，不合法直接丢弃。handler 拿到的就是干净的消息，不要再把原始对象往下传。范围放得比前端能发出的值宽很多（坐标可以越界，编辑框能拖到画布外），因为合法消息被丢弃会造成分叉。前端渲染时每笔 try/catch（`renderStrokeSafely`），校验上线前存下的畸形笔画不影响其余内容。

**Rate limit（连接级）**：`takeToken` 在 `webSocketMessage` 最顶部调用，每连接一个令牌桶：持续 300 条/秒，突发上限 3000 条。正常流量峰值 ~60/s：`useCanvas` 的 `flushPendingMove` 按时间把 draw 节流到 ≤60Hz（rAF 频率等于屏幕刷新率，只靠 rAF 在高刷屏上会超限），点累积到下次发送不丢，视觉重绘仍每帧一次。持续速率留余量是因为旧 JS 每帧发一条，开着的标签页可能在线数小时。**不要改回固定窗口**：服务端按到达时间计数，TCP 卡几秒后积压的 draw 会一次到达，而被限流是终止态，正常画手会被踢出房间。桶耗尽则 send error + `ws.close(1008, "rate limited")`。前端 `TERMINAL_CLOSE_REASONS` 已把 `"rate limited"` 列入不重连清单——别去掉，否则会 ping-pong。桶在 WeakMap 里，hibernation 时自然丢失（可接受，相当于重新装满）。

写存储的消息（`writesStorage`：聊天、猜词、落笔等）另有一个桶：持续 20 条/秒，突发 600 条，防写入额度被刷光。新增会写存储的消息时不用改，默认算写操作。

**Rate limit（IP 级）**：`wrangler.toml` 的 `[[ratelimits]]` 绑定，`index.ts` 的 `withinLimit()` 调用：建房 30 次/分钟，WebSocket 升级和 quickleave 合计 240 次/分钟。按 `CF-Connecting-IP` 计数（IPv6 按 /64，否则换个地址就绕过了），各节点分开算、是近似值，防洪泛不防精确配额；NAT 后面可能有很多人，所以放得很宽。本机（127.0.0.1 / ::1）不限流，否则本地开发和回归测试没法跑。被拒绝的升级在客户端表现为连接失败，会按退避重试，不是终止态。

**未 join 的连接**：升级时接受连接并记 `unjoinedSince`（`getPlayer` 对它返回 null），30 秒没发 join 就关（`sweepUnjoined`，alarm 驱动），超过 16 条从最旧的开始关，所以挡不住新人进房。加入前只能发 join 和心跳，发别的（包括垃圾和二进制帧）直接关。close reason `join timeout` / `join required` **不在**客户端的终止态名单里，真有慢客户端被关它会自己重连。房间不存在时也要先接受再发 error + close：升级时直接拒绝的话前端读不到原因。

**attachment 为 null 表示这条连接已被服务端放弃**（接管、拒绝、超时、离开），`webSocketMessage` 开头直接忽略它的消息：close 帧还在路上时到达的 join 不能算数，否则会占座，甚至接管本人的新连接。新连接从接受起就有 attachment，不要在 `acceptWebSocket` 之后留空。

**没有 HTTP 查询房间状态的接口**：info 接口已删（前端不用，还能用来枚举房间），非升级请求到 DO 返回 426。房间号用 `crypto.getRandomValues` 生成，仍是 6 位数字（前端路由和输入校验都按这个格式）。

**Toast 错误提示**：`src/components/Toast.tsx` 是通用组件（error / info / success），右上角滑入、3s 自动消失、点击关闭。Room.tsx 里 `error` 消息改用 Toast，不再塞到聊天历史。同一时刻只有一个 toast；新 toast 会覆盖旧 toast（靠 `key={toast.id}` 强制 remount 动画）。计时器只跟 `duration` 走，`onClose` 放在 ref 里：调用方传的是内联函数，跟着它重启的话，有消息不停进来时提示永远不消失。

**文字工具点击空白 commit**：Room.tsx 里有 `useEffect` 监听全局 `mousedown`，editingText 存在时：
- `target.closest("[data-text-overlay]")` → 忽略（内部 UI 交互）
- `target.tagName === "CANVAS"` → 忽略（`onCanvasClick` 会 commit + 开新的）
- 其他 → commit

新增文字编辑相关 DOM 时记得挂 `data-text-overlay="true"` 以免被误 commit。

**协议版本号（PROTOCOL_VERSION）**：双写在 `src/types/protocol.ts` 和 `worker/src/constants.ts`，两边必须一致。客户端把 `v` 放进 `join` 消息，服务端 `onJoin` 校验，不匹配发 error 并 `close(1000, "version mismatch")`。前端 `TERMINAL_CLOSE_REASONS` 已把 `"version mismatch"` 纳入不重连——否则刷新前会死循环重连 + 被踢。

**画板比例 5:3**：visible canvas 是 **5:3**（width:height）。`Canvas.tsx` 的 `resizeCanvas` **高度驱动**：先取 `container.clientHeight` 作为高度，宽度 = 高度 × 5/3；如果宽度溢出 container 就回退成宽度驱动（高度 = 宽度 × 3/5）。`container` 的 CSS 最小尺寸改成 `min-w-[667px] min-h-[400px]`（667 = 400 × 5/3）。

**离屏 canvas 缓存**：`useCanvas.ts` 维护一个固定 **1600×960 (5:3，OFFSCREEN_WIDTH × OFFSCREEN_HEIGHT)** 的 `offscreenRef`，作为"已完成笔画"的单一来源。2× 线性分辨率，曲线 / 油漆桶在更高分辨率下渲染再 bilinear 下采样到 visible canvas，显著减少阶梯锯齿。所有完成的笔画（本地 onMouseUp / 远程 replayDraw 的 end / addTextStroke / addFill / addSelection / addShape）都走 `appendStroke` 画到 offscreen，可见画布只从 offscreen 同步（`syncVisibleFromOffscreen`）。resize 时 Room 的 `handleCanvasResize` 调 `repaintVisible`，一次 blit 再补画进行中的笔画，**O(1)** 而不是 O(总点数) full replay。

关键约束：
- offscreen 尺寸固定 1600×960（OFFSCREEN_WIDTH × OFFSCREEN_HEIGHT，比例 5:3）；REF_WIDTH=800 是用于 lineWidth/字号缩放的「逻辑参考」，与离屏物理尺寸**解耦**。`scaleLineWidth` clamp 范围 0.5~**2.0**（上限 2.0 是为了让 offscreen 的 1600/800 = 2× 倍率不被钳掉，否则 commit 后线突然变细）
- aspect ratio 必须与 visible 一致，否则图形会被拉伸；`Canvas.tsx` 的 `RATIO_W/RATIO_H = 5/3` 必须等于 `OFFSCREEN_WIDTH:OFFSCREEN_HEIGHT`
- **live drawing（mousemove 中）不写 offscreen**，只在 stroke end 时 flush —— 如果用户一边 resize 一边还在画，当前未完成的 in-progress stroke 的已绘像素会丢失。这种 edge case 不处理（用户几乎不会这样操作）
- canvas 无法"反绘"某条笔画，撤销、删除要回到更早的状态再往后画。怎么做到不从头画见第二十章
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
- Local: `handleUndo` / `handleRedo` / `handleClear` / `handleContinueDrawing` / `commitEditingText` / `commitEditingShape` / `handleLocalPenEnd`。`handleTransfer` 不清 redo：服务端可能拒绝，接受时广播的 clear 会清

**`onLocalPenEnd` callback 的存在**：useCanvas 内部 pen 笔画结束时直接 push strokesRef（不经过 Room）。Room 需要借此回调清空 redoStackRef + sync flags。Shape 工具走 `onShapeDrawn` 不经过这里。

---

## 九、⚠️ 追加坑点（本版功能相关）

1. **undo/redo broadcast 必须 `exclude sender`**（`this.broadcast({...}, ws)`）。否则 drawer 本地 pop 一次 + 收到自己的广播又 pop 一次 → **双步 bug**。其他消息（draw/textStroke/shape）都是 exclude 的，之前漏掉了 undo/redo。`onClear` 同样要排除：弱网下回声会擦掉点清除之后画的新笔画。但 `onContinueDrawing` / `executeTransfer` 的 clear **不能**排除，发送者靠它清画布。

2. ~~**服务端 redoStack 不持久化**~~ ✅ 已修复：DO 空闲约 10 秒就休眠，内存全丢，所以 redoStack 和 `pendingPromotionId` 都已持久化。新增“跨越几秒的状态”时别只放内存。redoStack 不要放进 `saveState()`（全字段写，单值有上限），分 key 存。

3. **画板 aspect ratio 联动**：`Canvas.tsx` 的 `RATIO_W/H = 5/3` 与 `useCanvas.ts` 的 `OFFSCREEN_WIDTH:OFFSCREEN_HEIGHT = 1600:960` 必须**比例一致**，否则离屏 drawImage 缩放会让图形变形。改画板比例时两处必须同步；`REF_WIDTH = 800` 是逻辑参考（不影响比例）但如果要改也要联动调整。

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

**色相单独存**：`CustomColorPanel` 自己存 hsva。黑、白、灰没有色相，从 hex 反推永远是 0，以前从它们起手拖色相条没反应。draft 从外面变了（hex 输入、吸色）才按它重算，换成黑白灰时保留当前色相。

**屏幕吸色**：浏览器原生 `window.EyeDropper` API（Chrome 95+ / Edge 95+）。Firefox / Safari 不支持时按钮自动隐藏（`"EyeDropper" in window` 检测）。返回 `{ sRGBHex: "#rrggbb" }`，写入 draft 不再走 alpha 合成。

**Twind 抑制告警**：`@uiw/react-color` 给内部 div 加的 `w-color-*` 类（`w-color-saturation` / `w-color-hue` / `w-color-alpha-*` 等）以 `w-` 开头，会被 Twind runtime 当 width 工具类解析失败 → `[TWIND_INVALID_CLASS]`。在 `src/main.tsx` 的 `install` 配置里加了 `ignorelist: [/^w-color-/]`。

**色行 outside click**：`ColorPalette` 用 capture 阶段的全局 `mousedown` 监听关闭二级浮层。`data-color-panel` / `data-color-trigger` 标记浮层和触发按钮，`closest()` 命中则不关。

---

## 十一、油漆桶（bucket flood fill）

**协议**：`C_Fill` / `S_Fill`：`{ x, y, color, tolerance }`。`SerializedStroke.fill = { tolerance }`，`stroke.points = [{x, y}]` 存种子。

**算法**（`src/utils/floodFill.ts` 的 `scanlineFill`，单测在 `tests/unit/floodFill.test.ts`）：标准 scanline flood fill（4-邻域 + span tracking + 早返检查 target == fill）。tolerance per-channel（默认 32）。

**边缘抗锯齿**（`antiAliasFillEdges`）：scanline 完成后做一遍 1px 边界 alpha 混合 pass：
- 只遍历填充区域的包围盒外扩 1px，写回画布时也只写这块（`floodFill` 返回脏矩形）
- 未填充像素若有任意 4 邻居是**这次涂到的**（看 visited，不看颜色，否则别处的同色块每填一次就外扩一圈），按「该像素离背景色的最大通道距离」算 α（FALLOFF=96）
- alpha-blend 填充色到该像素，消除填充与抗锯齿描边之间的 1~2px 白晕
- 双端确定性：纯整数运算 + Uint8ClampedArray clamp，A/B 两端跑出的像素完全一致，不需要传位图

**白底初始化**：offscreen 在所有"重置"路径都要 `fillStyle = "#ffffff"; fillRect(...)` —— 否则 flood fill 在未初始化（透明黑）的画布上会无限蔓延。

**桶不带 alpha**：fill 只用 `(fr, fg, fb)`，paint 时 `data[idx+3] = 255`。透明度反直觉（多次填充会叠加），永远不应用。

**空操作不提交**：种子点已经是填充色（或落在画布外）时画面不会变，本地点击直接返回，不进撤销栈也不发（`fillWouldChange`，条件和 `drawFillOnContext` / `floodFill` 的提前返回一致，先 `flushReplay` 保证离屏是完整的）。

**⚠️ visited 位图（关键修复，不可回退）**：scanlineFill 内部用 `Uint8Array(w * h)` 记录已 paint 的像素，`matches()` 优先检查 visited 返回 false。**这是必要的**：fill 色与 target 色在容差内但不**完全相等**时（吸管吸到画布反走样像素的经典场景），painted 像素的 RGB 仍落在 matches 容差里，**没有 visited 会反复 push 进 stack 导致死循环 (Array.push 抛 `RangeError: Invalid array length`) + 浏览器卡死崩溃**。matches/paint 的入参是像素索引 `px`（不是字节偏移 `idx`），内部 `idx = px * 4`。

**offscreen `willReadFrequently: true`**：offscreen canvas 创建时一定要用 `getContext("2d", { willReadFrequently: true })` —— bucket 每次 fill 都要 `getImageData` 整张 readback，不设此 flag 浏览器走 GPU readback 慢路径并发 console warning（`Multiple readback operations using getImageData are faster with willReadFrequently...`）。flag 一旦 context 创建就固定，所有后续 `offs.getContext("2d")` 返回同一个 context 忽略 flag，所以仅需在初始化处设置一次。

---

## 十二、画笔逐帧重绘（pen overdraw 修复）

**旧 bug**：`onMouseDown` 调 `ctx.beginPath() + ctx.moveTo(...)`，每次 `onMouseMove` 调 `ctx.lineTo(...) + ctx.stroke()`。后者 stroke 的是从 beginPath 起的**整条累积路径** → 每个像素被反复涂 → alpha < 1 时透明度叠加成不透明。在 alpha 还存在时这是用户报的 bug，移除 alpha 后是 dead code 路径但依然修了（行为更直观）。

**修法**（`tool === "pen"` 块）：
- `onMouseDown`：仅记录起点 + send `start`，不动 ctx
- `onMouseMove`：push 点到 `currentStrokeRef.points` + `pendingPointsRef`，scheduleFlush
- `flushPendingMove`（RAF 帧）：距上次发送满 16ms 才 send 网络批量 move（否则点留在队列，下一帧再试），然后 `paintLiveStroke()`：先 `syncVisibleFromOffscreen()` 恢复底图，再把当前 stroke 一次性 beginPath + 所有 lineTo + stroke。**每帧重画 = 每个像素只涂一次**
- `onMouseUp`：appendStroke + syncVisibleFromOffscreen + send end（end 带整笔）
- `replayDraw`（peer 端）同样改成「sync offscreen + 重绘 in-progress」

**代价**：每 RAF 帧多一次 `drawImage(offs, 0, 0, w, h)`（~0.5ms 量级 @ 1067px wide）+ 一次完整路径重绘。60fps 持续 ~30ms/sec，可忽略。

**喷枪、蜡笔例外**：它们的成本和路径长度成正比，整条重画一笔长了就卡（4000 点时观战端主线程占用 700~900 ms/s）。这两种笔的散点只取决于线段的绝对序号和坐标，所以只补新线段，结果和整条重画逐像素相同（`renderBrushSegments`）。上一帧的像素留在可见画布上，可见画布被整张覆盖（`showOffscreen`）时 `liveStrokeRef` 清空，下一帧从头补画。水彩有模糊和透明度，不能增量。

**对端按帧合并**：`replayDraw` 收到 `move` 只累积点，`requestAnimationFrame` 里才画，消息来得再快一帧也只重绘一次。`end` 取消挂起的帧。

**原地单击**：所有点重合的笔画，画笔、水彩、蜡笔都画不出东西（Chromium 不给零长度线段画圆头，蜡笔只沿线段铺颗粒），却会进撤销栈。`finishStroke` 这时往旁边补一个相距 1px 的点（`withClickDot`，点数到上限就不补），单击就是一个点。这是改笔画数据，不是改渲染，旧版页面画出来也一样。

**画布事件的 effect 只依赖 `locked`**（猜词、揭晓阶段），不依赖具体的 `phase`：waiting ⇄ drawing（等人时第二个人进来、对方离开）不重跑，进行中的笔画、拖到一半的形状和框选、按住的喷枪都不受影响。以前依赖 `phase`，重跑时闭包里的拖动状态被重置，松手什么都没有，喷枪也停了。进入猜词、失去画手身份时前面的 effect 会把进行中的笔画作废；拖到一半的框选被拆掉时清理函数会擦掉虚线预览。

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
任何路径 setJoinError 后，统一由一个 effect 在 1.5s 后调用 `onLeave`，cleanup 时取消 timer。`case "error"` / `case "roomClosed"` / join 超时 / 连接被服务端终止（`terminalReason`）都走这条路径。**不要在 case 内部各自 setTimeout**——会导致 timer 散落难追踪、且 onLeave 可能被多次调用。

### 连接被服务端终止
`useWebSocket` 判定 close reason 属于终止态后不再重连，把 reason 放进 `terminalReason`。Room 用 effect 映射成 `setJoinError`（文案在 `TERMINAL_CLOSE_REASONS` 里，已有 joinError 时不覆盖）。**不要静默 return**：否则 `connected` 永远是 false，界面一直显示“正在重连”。

例外是 `version mismatch`：不自动回首页，留在房间 URL 并显示“刷新页面”按钮。回首页会清掉 `playerId`，用户按提示刷新也回不了房间，协议 bump 的流程就断了。

### connected 从 roomState 算起
`connected` 和 `send` 都要等本连接的 `roomState` 到达才放开，socket 打开不算。服务端按 join、后续消息的顺序处理，发回来的 roomState 不含后续消息的效果，随后 roomState 又会覆盖本地状态，所以这个窗口内发出的操作会让两端分叉。窗口内的操作和断线期间一样被丢弃，两端都以服务端为准。**不要改回 onopen 就放开**，`clear` 不回发发送者之后这个窗口的后果更重。

### 自动晋升可重试
猜对者 6.5s 后发 `claimDrawer` 的 effect 依赖 `connected`：断线时 `send` 被静默丢弃，重连后重新计时再发一次。服务端只在挂起的晋升仍属于该玩家时才接受，重复发送无害。

### 重连不阻断 UI
渲染条件 `if (!myId || joinError)` 切错误屏（首次未加入 / 加入失败 / 房间被关）。已加入后 ws 断开（`!connected`）保留主 UI，顶部加黄色 banner「网络异常，正在重连…」。画板和聊天上下文不消失。

### roomState 到达时的本地状态
`roomState` 是服务端的全量状态，到达时本地只保留还成立的东西：
- **进行中的笔画**（`resetStrokeInProgress`）：对端的半截丢掉（重连期间漏了点，接着收到的 move 会连成错误的线，`end` 会带整笔）。自己按着鼠标且还是画手时保留，松手时 `end` 带整笔发出去
- **悬浮的框选**：取消。`replayAll` 已把来源区域的像素画回去，再提交就成了重影
- **未提交的文字、形状**：还是画手就留着（它们没发过任何消息），否则丢掉

失去编辑资格时统一由 `canEdit`（是画手且不在猜词、揭晓阶段，答案也没在途）驱动的 effect 清理未提交内容，提交函数和 `handleClear` / `handleUndo` / `handleRedo` 也先看 `canEdit`：服务端按同样的条件拒收，不清的话本地永久多一条；工具栏按钮能被键盘触发，只靠 pointer-events 挡不住。`useCanvas` 里同理，失去画手身份或进入猜词阶段时丢弃进行中的笔画，否则 `isDrawingRef` 留在 true，之后再当画手时鼠标一动就接着画。

### 卸载标记只在 pagehide 置位
`isUnloadingRef` 不要改回 beforeunload：刷新可能被取消，标记留在 true，之后断线就不重连了。`pageshow`（从往返缓存恢复）时复位并补一次连接。

### case "roomClosed" 走 joinError 路径
设置 `setJoinError("房间已关闭：" + reason)` 立即切错误屏。**不要回退到 `addSystemMessage + setTimeout(onLeave)`**——那条路径会让服务端紧接着的 ws.close 触发 setConnected(false)，主 UI 上闪一下重连 banner，体验上像 bug。

---

## 十八、服务端 storage 写入节流

### touchActivity 节流（关键性能优化）
`touchActivity` 在已 join 玩家的每条非 `join`/`ping` 消息上调用，`onJoin` 在通过满员检查后也调一次，原本每次都 `storage.put("lastActivityAt")` + `setAlarm`。画手 60Hz 画画时**每秒 60 次 storage 写**，1000 房间满载 = 6 万次/秒 = Cloudflare DO 计费黑洞。

现在改成节流：内存值 `this.lastActivityAt` 每次都更新（保证 inactivity 检查准确），但 `storage.put` + `scheduleNextAlarm` **仅当距离上次持久化超过 `ACTIVITY_PERSIST_MIN_INTERVAL_MS` (30s) 才执行**。新字段 `lastActivityPersistedAt` 仅内存维护，**不持久化**——DO 重启后回到 0，第一次 touchActivity 立即触发持久化（`now - 0 >> 30000`），状态自动同步回一致。

收益：storage 写入量降 ~1800 倍。代价：inactivity 触发精度从「立即」降到 ±30s，10 分钟阈值下完全可忽略。

关键约束：
- **`onDisconnect` / `/quickleave` 路径直接调 `scheduleNextAlarm`，不走节流** —— grace 期（30s 或 5s）的 alarm 时间需要精准。
- 节流跳过 alarm 重设可能让 alarm 比真实理想触发时间略早 30s，但 alarm 末尾的 `scheduleNextAlarm` 会重新基于内存里最新 `lastActivityAt` 推到下一次合适时间，最终销毁时刻仍准确。

### 房间销毁与闲置回收
销毁房间统一走 `resetRoom()`：重置内存 + `deleteAll()`（从兼容日期 2026-02-24 起连 alarm 一起删）。销毁后不要再调 `saveState`，否则会把 key 写回去。

闲置回收的约定：
- `/init` 就记 `lastActivityAt` 并设 alarm，从未有人加入的房间到期也会被回收
- 只有已 join 的连接发的消息才算活动，未 join 的连接和被拒绝的 join 都不能续命
- `/init` 遇到“没人且已过闲置期”的房间（早期版本漏掉的孤儿）直接复用，不返回 409；其他情况仍是 409


## 十九、视觉改造任务（Apple 风格 UI）

本项目正在向 Apple 设计语言迁移，**所有视觉相关代码**必须严格遵守根目录
`DESIGN.md`（37KB / 11 章节，已就位）。该文档来自
`VoltAgent/awesome-design-md` 的 `apple/DESIGN.md`，是 Google Stitch 规范的
纯文本设计系统，AI 编码代理可直接读取。

> **本次改造范围（已确认）**：批次 1-4。**不重构** Home / Room 页面布局，
> **不改** Canvas 绘画核心逻辑，**不动** Worker 端代码。

> **进度状态（2026-05-09，分支 `feat/apple-redesign`）**：批次 1 / 2 / 3 已完成；
> 批次 4（字重清洗 + `active:scale-95` 微交互 + 字号语义升级）**未做**。期间针对用户
> 反馈做了几处偏离 DESIGN.md 的调整，新接手的 AI 请按以下实际值，不要按 19.2/19.4
> 的字面值改回去：
>
> 1. `hairline` 实际取 `#ebebeb`（DESIGN.md 的 `#e0e0e0` 偏深一档，用户反馈调浅）
> 2. `shadow-product` 实际取 `rgba(0, 0, 0, 0.10) 2px 4px 20px`（轻于 DESIGN.md 的
>    `0.22 / 3px 5px 30px` 约 60%）
> 3. **保留背景图**：首页 + 模态框背景仍走 `src/assets/bg.webp`（19.3 的"删除背景图"
>    步骤被回退，2026-11 从 412 KB 的 bg.png 压成 30 KB 的 WebP）。`bg-canvas` / `bg-canvas-parchment` 不要再覆盖到这两处
> 4. **字体逻辑试做又整体撤销**：`@font-face` + `font-fun` / Douyin / Zcool 已 100%
>    移除；当前 `fontFamily` 只有 SF Pro Display / Text 系统栈。`src/assets/font/` 下
>    两份 ttf/otf 仍在仓库，需要再启用时直接接 `fonts.css` + Twind theme `fontFamily`
>    即可（之前用过 `font-fun` token 名）
> 5. **`Toolbar.tsx` 的 `FillToggle` 同期重写**：按 `shape: "rect" | "ellipse" | "triangle" | "star" | "heart"`
>    用 SVG 渲染对应真实几何（修复之前 triangle / star / heart 的"线框 / 填充"
>    预览全退化成圆角方块的歧义）。新增 file-level type `FillShape` 和组件
>    `FillShapeIcon`。调用处 cast 也从 `t as "rect" | "ellipse"` 改为 `t as FillShape`
> 6. **画板比例 4:3 → 5:3** 联动改造（详见 ch 三 6 / ch 九 3）

### 19.1 改造铁律（违反必须回滚）

1. **唯一主色** `primary` (#0066cc Action Blue)，禁用第二个 accent。
2. **正文必须** `text-body`（17px / weight 400 / line-height 1.47 / letter-spacing -0.374px），**不是 16px**。
3. **字重阶梯**：300 / 400 / 600 / 700，**禁用 500**（清除 `font-medium`）。
4. **阴影只给画布**（`shadow-product`）。卡片 / 按钮 / 模态框 / Toast / ChatPanel 一律无阴影。
5. **主 CTA 必须 pill**（`rounded-full`），其他卡片 `rounded-lg` (8px)。
6. **禁用装饰渐变**。背景纯色或明暗 full-bleed 交替。
7. **所有 `<button>`** 加 `active:scale-95 transition-transform` press 反馈。
8. **颜色用 token**（primary / ink / canvas / hairline），**禁止内联 hex**。

### 19.2 批次 1：Twind 主题层（src/main.tsx）

整体替换 `install({ ... })` 内的 `theme.extend`：

```ts
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
      hairline: "#e0e0e0",
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
      product: "rgba(0, 0, 0, 0.22) 3px 5px 30px",
    },
  },
},
```

并在 `index.html` 的 `<body>` 加：`class="font-text text-body text-ink"`，
让全局正文默认就是 Apple 规格（17px / SF Pro Text / 深墨色）。

### 19.3 批次 2：色值替换（全局 grep 批量）

| 旧类名 | 新类名 |
|--------|--------|
| `text-indigo-600` / `text-indigo-500` | `text-primary` |
| `text-indigo-700` | `text-primary-focus` |
| `bg-indigo-500` | `bg-primary` |
| `hover:bg-indigo-600` | `hover:bg-primary-focus` |
| `focus:ring-indigo-500` | `focus:ring-primary` |
| `bg-indigo-100` | `bg-canvas-parchment` |
| `border-indigo-300` | `border-primary` |
| `text-gray-500` / `text-gray-700` | `text-ink-muted` / `text-ink` |
| `border-gray-300` | `border-hairline` |

**特别处理（删除装饰渐变与背景图）**：

- `src/App.tsx:141` — `bg-gradient-to-br from-indigo-50 to-purple-50` → `bg-canvas`
- `src/pages/Home.tsx:51-56` — 移除 `style={{ backgroundImage: \`url(${bgUrl})\` }}` 与 `bg-cover bg-center bg-no-repeat`，改为 `bg-canvas`
- 同步删除 `import bgUrl from "./assets/bg.png"`（App.tsx + Home.tsx）。
- 模态框（App.tsx:89-94）的 `bg-cover bg-center bg-no-repeat + bgUrl` → `bg-canvas-parchment`

### 19.4 批次 3：圆角 + 阴影统一

**圆角统一**：

- 所有卡片 / 模态框 `rounded-2xl` → `rounded-lg`
- 所有 `<button>` 的 `rounded-lg` → `rounded-full`（pill）
- 输入框 `rounded-lg` 保留（utility 圆角合法）
- 错误提示 `rounded-lg` 保留

**阴影删除**：

- `src/App.tsx:96` 模态框 `shadow-xl` → 删除
- `src/pages/Home.tsx:58` 主卡片 `shadow-xl` → 删除
- `src/components/Toast.tsx`、`ChatPanel.tsx`、`PlayerBar.tsx` 内所有 `shadow-*` → 删除
- 改用 `border border-hairline` 提供分隔感

**阴影唯一例外**：

- `src/components/Canvas.tsx` 画布外层若有 box-shadow，改为 `shadow-product`（DESIGN.md 唯一允许的阴影）

### 19.5 批次 4：字重 + 微交互

**字重清洗（清除 500）**：

```
font-medium → font-normal（普通文字）
font-medium → font-semibold（语义上是强调的标签/小标题）
font-bold → font-semibold（除非是真正的 700 层级，比如 hero）
```

**全局 press 反馈**——每个 `<button>` 末尾追加：

```
"active:scale-95 transition-transform"
```

涉及文件清单：

- `src/App.tsx`：模态框两个按钮（约 115 / 124 行）
- `src/pages/Home.tsx`：菜单 / 创建房间 / 加入房间 / 人数选择 / 返回所有按钮
- `src/components/Toolbar.tsx`：所有工具按钮
- `src/components/PlayerBar.tsx`：离开房间按钮
- `src/components/Toast.tsx`：dismiss 按钮（如有）
- `src/components/ChatPanel.tsx`：发送按钮

**字号语义升级**：

- `text-4xl` 主标题 → `text-display-lg font-display font-semibold`
- `text-3xl` / `text-2xl` 次级标题 → `text-display-md font-display font-semibold`
- `text-xl` 卡片标题 → `text-lead font-display font-normal`
- 默认正文 → 显式标 `text-body`（继承自 body 也行，但显式更清晰）

### 19.6 改造工作流

1. 新建分支：`git checkout -b feat/apple-redesign`
2. 按批次顺序执行，**每批一次 commit**（中文 commit message）：
   - `feat(theme): 切换 Twind 主题为 Apple 设计 token`
   - `feat(colors): 全局替换 indigo → primary，移除装饰渐变与背景图`
   - `feat(shapes): 统一圆角与阴影规则`
   - `feat(motion): 字重清洗 + active:scale-95 press 微交互`
3. 每批改完执行：
   ```powershell
   npm run lint
   npm run dev   # 视觉检查 Home / Room / 模态框
   ```
4. 全部完成后：`npm run build` 确认 TS 编译通过。

### 19.7 验收 Checklist（标准批次完成的判定）

- [ ] 全工程 grep `indigo|purple|gradient|shadow-xl|shadow-md|font-medium`，应为 **0 命中**。
- [ ] grep `rounded-2xl`，应为 **0**；`rounded-full` 用在所有主 CTA 按钮上。
- [ ] DevTools 检查 `<body>` 计算样式：`font-size: 17px; line-height: 1.47; font-family: "SF Pro Text"...`。
- [ ] DevTools 检查任意主按钮：`background-color: rgb(0, 102, 204);` 且圆角 9999px。
- [ ] 点击任意按钮可见明显 scale 0.95 弹动。
- [ ] Home 页与模态框背景为纯白 / parchment，无紫色渐变、无 bg.png。
- [ ] Canvas 画布外有 `shadow-product` 柔和阴影（唯一例外）。
- [ ] 主标题字体回退能命中 SF Pro Display（macOS 上验证最准）。

### 19.8 改造期注意

- **不要碰 Worker 端**（`worker/` 目录），改造仅限 `src/`。
- **不要改绘画逻辑**（`useCanvas.ts` / `useWebSocket.ts`），只改外观。
- **保留 `@uiw/react-color` 的内部样式**（已在 ignorelist 配置）。
- **错误提示色** `bg-red-50 text-red-600` 保留不动（DESIGN.md 已知 gap，无规范）。
- **emoji** 🎨 / 🏠 等保留——Apple 系统也用平台 emoji，不必删。
- ~~改造完成前不要删除 `src/assets/bg.png`~~：2026-11 已换成 `bg.webp`（见上面的进度说明第 3 条）。
5. 改造任何组件前，先 grep 现有色值/字号，统一替换为 DESIGN.md 中的 token

---

## 二十、离屏重放（strokeReplay.ts）

`strokesRef` 是目标，`StrokeReplay` 记着离屏上实际画到了哪一笔，`sync()` 负责追上去。**所有改离屏的路径都走它**，不要绕过去直接画：

- 目标只是多了几笔（落笔、重做）：往后画
- 目标变短或中间变了（撤销、删除）：按对象引用找公共前缀，回到最近的检查点，只补后面的部分。`roomState` 的笔画都是新对象，公共前缀是 0，全量重放
- **检查点**：距上一个累计渲染超过 20ms 存一张快照（1600×960 约 6 MB），最多 6 张。到上限时淘汰“去掉后留下的空档相对离末尾的距离”最小的那张，所以离末尾近的密、远的疏
- **分片**：`pumpReplay` 每片最多 12ms，画不完用 MessageChannel 让出主线程（定时器在后台标签页会被限流）。画完之前**可见画布的底图是开始重放前冻结的那一帧**（`frozenFrameRef`），`syncVisibleFromOffscreen` 画的是它，进行中的笔画、形状预览、框选预览都画在它上面，不会露出半成品，也不会叠画。途中提交的笔画 push 进 `strokesRef` 排队，同时先画到冻结帧上，提交了马上看得到；油漆桶和框选要读像素，提交时直接 `flushReplay` 画完。要读离屏像素的 `beginSelection` 也先 `flushReplay`。**不要在别处直接把 offscreenRef 画到可见画布上**，统一走 `syncVisibleFromOffscreen`

**taint**：离屏上有 `rendered` 推不出来的像素（框选把来源涂白了），下一次 `sync` 必须先恢复。提交框选时粘贴的结果和重放相同，`noteRendered` + `untaint`。框选已经被作废（重连收到全量状态，来源像素画回去了）时 `commitLocalSelection` 返回 false，不粘贴也不发消息：Room 的全局 mousedown 监听在 React 卸载它之前还可能触发一次提交。删除框选内容是 `releaseLocalSelection` + `addShape`，sync 时恢复再画白矩形，结果也和重放相同。

**字体**：`refreshTextStrokes` 只重画第一条文字之后的部分（`invalidateFrom`），没有文字就不重画。一批字体接连到达时合并成一次（100ms）；没加载出任何字体的 `loadingdone` 不处理。样式表到达时只给已有文字补发字体下载，下载完再重画一次。框选悬空时字体到了，等框选结束再补（`fontRefreshPendingRef`）。

**坑**：
- 临时画布（框选的 patch）**必须** `willReadFrequently: true`。少了它离屏会走另一条光栅路径（边缘量化到 1/4 像素），后来者和实时观众的抗锯齿边缘不一致，以前的低分辨率比对看不出来
- 快照和恢复用 `copy` 合成，保证和全量重放逐像素相同。`browser-batch3` 的测试比的是离屏的完整 hash（`T.offHash`），改渲染路径时跑一下
- 单笔渲染不可分片，极长的一笔还是会有长任务

## 二十一、测试

```bash
npm test                # vitest 单测，1 秒
npm run test:protocol   # 协议回归：本地 workerd，约 5 分钟，会起停 8787
npm run test:browser    # 浏览器回归：本地 workerd + 无头 Chromium，约 25 分钟
node tests/regression/run.cjs browser batch3   # 只跑一个脚本；单个脚本还能带组名正则
```

- 回归脚本都是断言式，退出码 = 失败条数。产物在 `tests/regression/.tmp`（已忽略）
- 页面工具在 `harness.cjs` 的 `T` 里：`T.typeInto(选择器, 值)` 等元素出现再填（CI 机器慢，别用固定等待）、`T.mode(提交按钮文字)` 切输入模式、`T.confirmClear()` 两下确认清除
- 绝对耗时的阈值要给 CI 留余量：共享机器没有 GPU，整条重画要慢十倍左右。L3 的主线程占用在 CI 上超过阈值，所以只在本机断言（`GITHUB_ACTIONS` 时只记录），和机器快慢无关的那部分（同一个任务里到达的 60 条 move 只重绘一次）另外断言；其余耗时断言目前在 CI 上都有余量
- 本机 VC++ 运行库过旧时 workerd 会崩，设 `MINIFLARE_WORKERD_PATH` 指向带新版 DLL 的副本。浏览器路径用 `BROWSER_PATH` 指定
- 改 Worker 时别同时跑浏览器测试：`wrangler dev` 会热更新，正在跑的结果作废
- 测试只访问本机，不要对线上建房或连 WebSocket
- **修 bug 时先写测试，确认在旧代码上红灯；修完用变异核实测试真能抓到问题**（`build-client.mjs` 的插件写法可以在内存里改源码）。这个项目吃过测试不灵敏的亏：等待时间卡在边界上、比较的内容没变化

## 二十二、Worker 配置和日志

- `compatibility_date = "2026-07-15"`。再往后（2026-08-04）会默认打开 `nodejs_compat`，升级前读兼容标志的变更，再跑协议回归
- 这个日期之后 `deleteAll` 连 alarm 一起删，`close()` 的 reason 不能超过 123 字节
- `webSocketClose` 里的 `ws.close()` **不要删**：文档说兼容日期 2026-04-07 起运行时会自动回 close 帧，但本地 workerd（2026-11-03）的 Hibernation 下实测不回，对端要等 10 秒以上才算关闭
- `workers_dev = false`：只有 `/api/*` 路由一个入口
- 前端 `useWebSocket` 卸载时**不发 leave**，只关连接：主动离开由 Room 的 `handleLeave` 显式调 `leave()`。渲染出错时 ErrorBoundary 会卸掉 Room，这时按普通断线处理，席位有保留期，刷新能回到原身份
- **线上不记调用日志**（`invocation_logs = false`）：每条 WebSocket 消息都算一次调用，一局就能用完每天的日志额度。所以 DO 和 Worker 的入口都包了 `logFailure`，出错时 `console.error`（Workers Logs 能查到）。日志里不要写用户内容
