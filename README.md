# 🎨 我画你猜

一个实时在线的双人画画猜词小游戏。一人画、一人猜，通过 WebSocket 实时同步画板与聊天消息。

**在线体验：** https://draw-guess.dengjiabei.cn

![工具栏预览](./src/assets/rectangle-icon.svg)

## 功能特性

- 无需注册，输入昵称即可开始游戏
- 创建 / 加入房间（6 位房间号），每个房间限 2 人，支持一键复制分享链接
- 4:3 画板，实时同步每一笔
- **多种绘图工具**（8 种）：
  - ✏️ 画笔（4 档线宽，逐帧重绘避免 overdraw）
  - T 文本（小/中/大字号，画完可拖动位置、角点调字号）
  - 🪣 油漆桶（封闭区域填充，scanline flood fill + 边缘抗锯齿后处理消除白晕）
  - □ 矩形（线框 / 填充切换；越界自动钳到边界）
  - ○ 椭圆（同上）
  - ╱ 直线
  - ↗ 箭头（自动渲染锥形填充三角头，taper from 0 → body → head）
  - ▢ 框选（拉框移动一片像素到新位置）
- **颜色选择**：7 个固定预设色 + 自定义颜色拾取器
  - 自定义面板：SV 方块 + 竖向 Hue 条 + hex 输入 + 屏幕吸色（EyeDropper API）+ 清空 / 确定
  - 自定义色块右下角彩虹三角标识
- **编辑态统一失焦即确定**：矩形 / 椭圆 / 箭头 / 直线 / 文本 / 框选画完后出现虚线框，可拖动整体位置；点虚线框外任意地方即确认
- **撤销 / 重做**：两端状态同步，新笔画自动失效重做栈
- 画手设定答案后，猜词方可输入猜测；答对自动揭晓并撒彩带
- 画笔权限可在两人之间转移，一键转让进入下一轮
- 右侧实时聊天面板
- 断线自动重连（指数退避 1s→30s）+ 心跳保活 + 页面刷新 5s 内可恢复身份

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript |
| 样式方案 | Twind (Tailwind CSS-in-JS) |
| 颜色拾取器 | @uiw/react-color（Saturation / Hue / Alpha 原子组件） |
| 构建工具 | Vite 6 |
| 后端运行时 | Cloudflare Workers |
| 状态管理 | Durable Objects（Hibernatable WebSocket + SQLite backend） |
| 实时通信 | WebSocket JSON |
| 前端部署 | Cloudflare Pages |
| Lint / Format | ESLint 9（flat config）+ Prettier |

## 项目结构

```
├── src/                          # 前端
│   ├── main.tsx                  # 入口，Twind install
│   ├── App.tsx                   # 顶层路由（首页 / 昵称弹窗 / 房间）
│   ├── api.ts                    # apiUrl / wsUrl 工具
│   ├── pages/
│   │   ├── Home.tsx              # 创建 / 加入房间
│   │   └── Room.tsx              # 主游戏页，消息分发 + 撤销/重做栈
│   ├── components/
│   │   ├── Canvas.tsx            # 画板 + 文字/形状/框选编辑 overlay
│   │   ├── Toolbar.tsx           # 8 工具 + 颜色拾取器（含自定义面板）+ undo/redo/clear
│   │   ├── PlayerBar.tsx         # 顶栏房间号 / 玩家 / 操作按钮
│   │   ├── ChatPanel.tsx         # 聊天 / 设答案 / 猜词三合一输入
│   │   ├── Confetti.tsx          # 彩带雨（canvas + RAF）
│   │   └── Toast.tsx             # 右上角错误提示
│   ├── hooks/
│   │   ├── useWebSocket.ts       # WS 连接、重连、心跳
│   │   └── useCanvas.ts          # 画布事件、笔画、离屏缓存、flood fill
│   ├── utils/
│   │   └── color.ts              # normalizeColor 颜色字符串规范化
│   ├── assets/                   # SVG 图标源文件
│   └── types/protocol.ts         # ⭐ 前后端共享的消息类型契约
├── worker/                       # Cloudflare Worker 后端
│   ├── src/
│   │   ├── index.ts              # HTTP 入口 + Origin 白名单 + 路由到 DO
│   │   ├── room.ts               # ⭐ GameRoom Durable Object
│   │   ├── types.ts              # DO 内部类型
│   │   ├── constants.ts          # 可调参数 + PROTOCOL_VERSION
│   │   └── helpers.ts            # 纯函数 helpers
│   ├── wrangler.toml             # durable_objects + routes
│   └── package.json
├── .github/workflows/            # CI/CD
│   ├── deploy-pages.yml          # 前端自动部署到 Pages
│   └── deploy-worker.yml         # Worker 自动部署
├── eslint.config.js              # ESLint flat config
├── .prettierrc.json              # Prettier 配置
└── CLAUDE.md                     # AI 助手 / 深入开发文档
```

## 游戏流程

```
首页 → 创建房间 → 等待对方加入
       加入房间 → 输入 6 位房间号（或扫描分享链接）

两人就绪 → 画手选工具 → 画 / 写字 / 画形状 → 设定答案 → 猜词方开始猜
                                                    ├── 猜对 → 撒彩带 + 本轮结束
                                                    └── 猜错 → 继续猜

画手可随时「转让画笔」→ 角色互换，新一轮开始
画手可随时「继续出题」→ 重新开画同一轮
```

## 本地开发

```bash
# 安装依赖（@twind/core peer range 较老，需加 --legacy-peer-deps）
npm install
cd worker && npm install && cd ..

# 启动前端（默认连线上 Worker）
npm run dev

# 本地启动 Worker（需 wrangler 登录；同时改 .env.development 里 VITE_API_BASE=http://localhost:8787）
npm run dev:worker
```

### 代码质量

```bash
npm run lint            # ESLint 检查
npm run lint:fix        # 自动修复（含 curly: all）
npm run format          # Prettier 格式化
npm run format:check    # CI 友好的只读检查
```

ESLint 规则里 `curly: ["error", "all"]` 强制所有 `if` 加花括号；3 个已知的 `exhaustive-deps` warnings 是有意保留的。

## 部署

项目通过 GitHub Actions 自动部署：

- **前端**：推送到 `master` 分支后自动构建并部署到 Cloudflare Pages
- **Worker**：`worker/` 目录有变更时自动部署到 Cloudflare Workers

### 需要配置的 GitHub Secrets

| Secret | 说明 |
|--------|------|
| `CF_API_TOKEN` | Cloudflare API Token（需 Workers + Pages 编辑权限） |
| `CF_ACCOUNT_ID` | Cloudflare Account ID |

### 手动部署

```bash
# 部署 Worker
cd worker && npx wrangler deploy

# 构建并部署前端
npm run build
npx wrangler pages deploy dist --project-name=draw-guess
```

## 协议与消息

客户端与服务端通过 WebSocket JSON 消息通信。主要消息类型（完整列表见 `src/types/protocol.ts`）：

### Client → Server

| 消息 | 说明 |
|------|------|
| `join` | 加入房间，带 `v: PROTOCOL_VERSION` 做版本校验 |
| `ping` | 心跳保活（每 25s） |
| `draw` | 自由笔画（`start` / `move` / `end`，`move` 支持 RAF 批量 `points[]`） |
| `textStroke` | 文字笔画 |
| `shape` | 形状笔画（矩形 / 椭圆 / 直线 / 箭头） |
| `fill` | 油漆桶填充（seed 点 + color + tolerance） |
| `selection` | 框选移动（src rect → dst rect 的像素 patch） |
| `clear` | 清空画板 |
| `undo` / `redo` | 撤销 / 重做 |
| `setAnswer` | 画手设定答案 |
| `guess` | 猜词方提交猜测 |
| `chat` | 发送聊天消息 |
| `transfer` | 转移画笔权限 |
| `continueDrawing` | 猜对后继续出题（同一画手） |
| `leave` | 主动离开 |

### Server → Client

| 消息 | 说明 |
|------|------|
| `roomState` | 房间完整状态（加入时下发，含 strokes 和 chatHistory） |
| `pong` | 心跳响应（前端吞掉不分发 listener） |
| `playerJoined` / `playerLeft` | 玩家进出 |
| `draw` / `textStroke` / `shape` / `fill` / `selection` / `clear` / `undo` / `redo` | 绘图同步 |
| `phaseChange` | 游戏阶段变更 |
| `guessResult` | 猜测结果（对 / 错） |
| `chat` | 聊天广播 |
| `transferDone` | 画笔权限转移完成 |
| `error` | 错误（版本不匹配 / 房间不存在 / 房间已满 / rate limit 等） |
| `roomClosed` | 房间已关闭（如 10 分钟无活动） |

### 坐标 / 尺寸归一化

- 所有 `{x, y}` 在协议和存储里都是 `[0, 1]` 归一化值，跟画板实际像素解耦
- 线宽 / 字号按 `REF_WIDTH = 800` 做 `scaleLineWidth`（clamp 0.5~2.0x）
- 画板实际比例 **4:3**：visible canvas 4:3，离屏缓存 `OFFSCREEN_WIDTH × OFFSCREEN_HEIGHT = 1600×1200`（2× 线性分辨率，曲线/油漆桶在更高分辨率下渲染再 bilinear 下采样到可见画布，显著减少阶梯锯齿）

## 架构亮点

- **Hibernatable WebSocket**：DO 闲置时可被回收，玩家身份存在 WebSocket attachment 里，醒来自动恢复
- **两级断线 grace**：正常断线 30s，页面刷新 5s（靠 `pagehide` beacon 识别）
- **离屏 canvas 缓存**：已完成笔画全部画到固定 1600×1200 的 offscreen canvas，resize 只需 `drawImage` blit 一次（O(1)）；2× 线性分辨率显著减少曲线锯齿
- **油漆桶边缘抗锯齿**：scanline flood fill 后做一遍 1px 边界 alpha 混合，消除填充与抗锯齿描边之间的白晕
- **画笔逐帧重绘**：mousemove 不在累积路径上反复 stroke（避免 alpha overdraw），改为每 RAF 帧 sync offscreen + 单次重绘当前 in-progress stroke
- **strokes 分片存储**：每条 stroke 独立 storage key（`stroke:0000000001`），避开 DO 单值 128KB 上限
- **协议版本号**：`join` 消息带 `v`，服务端拒绝不匹配并提示刷新
- **Origin 白名单 + rate limit**：所有 API 和 WS upgrade 都校验 Origin；每 WS 1s/150 条消息上限
- **中文答案归一化**：NFKC + lowercase + 去空格 + 去 Unicode 标点，全角半角 / "你好！" vs "你好" 都能对上

详细实现见 [`CLAUDE.md`](./CLAUDE.md)。

## License

MIT
