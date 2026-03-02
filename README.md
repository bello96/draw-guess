# 🎨 我画你猜

一个实时在线的双人画画猜词小游戏。一人画、一人猜，通过 WebSocket 实时同步画板与聊天消息。

**在线体验：** https://draw-guess.dengjiabei.cn

## 功能特性

- 无需注册，输入昵称即可开始游戏
- 创建 / 加入房间（6 位房间号），每个房间限 2 人
- 实时画板同步：支持多色画笔、调整粗细、撤销、清空
- 画手设定答案后，猜词方可输入猜测，答对即揭晓
- 画笔权限可在两人之间转移，轮流画画
- 右侧实时聊天面板

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript |
| 样式方案 | Twind (Tailwind CSS-in-JS) |
| 构建工具 | Vite |
| 后端运行时 | Cloudflare Workers |
| 状态管理 | Durable Objects (Hibernatable WebSocket) |
| 实时通信 | WebSocket |
| 前端部署 | Cloudflare Pages |

## 项目结构

```
├── src/                    # 前端源码
│   ├── main.tsx            # 入口，Twind 初始化
│   ├── App.tsx             # 路由（首页 / 房间页）
│   ├── api.ts              # API / WebSocket 地址管理
│   ├── pages/
│   │   ├── Home.tsx        # 创建 / 加入房间
│   │   └── Room.tsx        # 游戏房间主页面
│   ├── components/
│   │   ├── Canvas.tsx      # 画板组件
│   │   ├── Toolbar.tsx     # 颜色 / 画笔工具栏
│   │   ├── PlayerBar.tsx   # 房间信息 / 玩家状态栏
│   │   └── ChatPanel.tsx   # 聊天 / 猜词面板
│   ├── hooks/
│   │   ├── useWebSocket.ts # WebSocket 连接管理
│   │   └── useCanvas.ts    # 画板绘制逻辑
│   └── types/
│       └── protocol.ts     # 消息协议类型定义
├── worker/                 # Cloudflare Worker 后端
│   ├── src/
│   │   ├── index.ts        # Worker 入口，HTTP 路由
│   │   └── room.ts         # GameRoom Durable Object
│   ├── wrangler.toml       # Worker 部署配置
│   └── package.json
├── .github/workflows/      # CI/CD
│   ├── deploy-pages.yml    # 前端自动部署到 Pages
│   └── deploy-worker.yml   # Worker 自动部署
└── .env.development        # 本地开发环境变量
```

## 游戏流程

```
首页 → 创建房间 → 等待对方加入
       加入房间 → 输入6位房间号

两人就绪 → 画手绘画 → 设定答案 → 猜词方猜测
                                    ├── 猜对 → 本轮结束
                                    └── 猜错 → 继续猜

画手可随时「转移画笔」→ 角色互换，新一轮开始
```

## 本地开发

```bash
# 安装依赖
npm install
cd worker && npm install && cd ..

# 启动前端（连接线上 Worker）
npm run dev

# 如需本地运行 Worker（需要 wrangler 登录）
npm run dev:worker
```

本地开发时，前端通过 `.env.development` 中的 `VITE_API_BASE` 直接请求已部署的 Worker，无需本地启动后端。

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

客户端与服务端通过 WebSocket JSON 消息通信，主要消息类型：

| 方向 | 消息类型 | 说明 |
|------|---------|------|
| C → S | `join` | 加入房间 |
| C → S | `draw` | 绘画轨迹 (start/move/end) |
| C → S | `clear` / `undo` | 清空 / 撤销 |
| C → S | `setAnswer` | 画手设定答案 |
| C → S | `guess` | 猜词方提交猜测 |
| C → S | `chat` | 发送聊天消息 |
| C → S | `transfer` | 转移画笔权限 |
| S → C | `roomState` | 房间完整状态（加入时下发） |
| S → C | `phaseChange` | 游戏阶段变更 |
| S → C | `guessResult` | 猜测结果（对/错） |

## License

MIT
