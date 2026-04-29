# 多人房间（2-6 人）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 2 人房间扩展到 2-6 人，加画板冻结、PlayerBar 折叠、转让下拉、自动升级房主。

**Architecture:** 全部以可选字段扩展协议（不 bump 版本号）。服务端 `room.ts` 加 `maxPlayers` / `joinOrder` / `pendingPromotionId` 字段，加 `canMutateCanvas()` 守卫和 `onClaimDrawer` handler。前端 `PlayerBar` 多人模式改用 `joinOrder` 显示前两人 + "+N" 折叠，`Home.tsx` 加人数选择器，`Room.tsx` 协调"猜对者本机倒计时 + claim"流程。`isOwner` 字段动态计算（id === drawerId），`PlayerAttachment` 内部不再持久化。

**Tech Stack:** React 18 + TypeScript + Vite + Twind / Cloudflare Workers + Durable Objects（Hibernatable WebSocket + SQLite）/ ESLint + Prettier

**Spec:** `docs/superpowers/specs/2026-04-29-multiplayer-room-design.md`

**约束：**
- 项目无单测；每个 task 提交前必须通过 `npx tsc --noEmit`（前后端各一次）+ `npm run lint`
- commit message 中文，结尾用 `合作对象：地表最强 Claude Opus`（**不**用 `Co-Authored-By` 英文格式）
- 所有 `if` 必须带 `{}`（项目 ESLint 已强制）
- 中文回复用户

**部署顺序：服务端先于前端**。每个改协议 / 服务端逻辑的 task 提交后，应可独立部署 worker；前端 task 在服务端就绪后才部署 pages。

---

## 文件结构

### 协议 / 类型
- 修改：`src/types/protocol.ts` — 加 `C_ClaimDrawer`、`C_Transfer.targetId?`、`S_RoomState.maxPlayers?` / `S_RoomState.pendingPromotionId?`、`S_PhaseChange.pendingPromotionId?`
- 修改：`worker/src/types.ts` — 服务端类型镜像（仅本地使用的字段）
- 修改：`worker/src/constants.ts` — 加 `MIN_MAX_PLAYERS = 2` / `MAX_MAX_PLAYERS = 6` / `AUTO_PROMOTE_DELAY_MS`（前端常量在 `src/constants.ts` 不存在，直接放 Room.tsx 内）

### 服务端
- 修改：`worker/src/index.ts` — `POST /api/rooms` 读取 `?max=N` 并传给 DO `/init`
- 修改：`worker/src/room.ts` —
  - `/init` 接受 `max` query
  - 字段：`maxPlayers` / `joinOrder` / `pendingPromotionId`
  - 改造：`onJoin` / `onTransfer` / `onGuess` / `onContinueDrawing` / `onClear` / `executeTransfer` / `processActualLeave` / `getPlayerInfoList`
  - 新增：`canMutateCanvas()` / `onClaimDrawer` / `isPlayerActive`
  - 8 处画板守卫：`onDraw` / `onTextStroke` / `onShape` / `onFill` / `onSelection` / `onClear` / `onUndo` / `onRedo`

### 前端
- 修改：`src/pages/Home.tsx` — 人数选择分段控件 + `onEnterRoom` 调用方传 maxPlayers
- 修改：`src/api.ts` — 不变（apiUrl 已支持任意 query）
- 修改：`src/App.tsx` — 透传 maxPlayers 到 Home / Room
- 修改：`src/pages/Room.tsx` — 接收 `maxPlayers` / `pendingPromotionId` state、自动升级 useEffect、把 phase 传给 Canvas/Toolbar
- 修改：`src/components/PlayerBar.tsx` — 多人显示规则 + 转让下拉 + 满员隐藏分享 + 自动升级提示
- 修改：`src/components/ChatPanel.tsx` — 多人文案 "其他玩家"
- 修改：`src/components/Toolbar.tsx` — 整体置灰（disabled prop）当 phase ≠ drawing
- 修改：`src/components/Canvas.tsx` — 鼠标事件 phase 门
- 修改：`src/hooks/useCanvas.ts` — `tool` handler 入口 phase 门

---

## Task 1：协议字段（前后端类型先行）

只动类型定义，**无运行时行为变化**。提交后前后端都能 type-check 通过；后续 task 才会真正用上这些字段。

**Files:**
- Modify: `src/types/protocol.ts`
- Modify: `worker/src/types.ts`
- Modify: `worker/src/constants.ts`

- [ ] **Step 1.1：在 `src/types/protocol.ts` 加 `C_ClaimDrawer`**

文件末尾"Client → Server Messages"组中插入（紧跟 `C_ContinueDrawing` 之后、`C_Leave` 之前）：

```ts
export interface C_ClaimDrawer {
  type: "claimDrawer";
}
```

并加入 `ClientMessage` 联合类型：

```ts
export type ClientMessage =
  | C_Join
  | C_Draw
  | C_Clear
  | C_Undo
  | C_Redo
  | C_SetAnswer
  | C_Guess
  | C_Chat
  | C_TextStroke
  | C_Shape
  | C_Fill
  | C_Selection
  | C_Transfer
  | C_ContinueDrawing
  | C_ClaimDrawer
  | C_Leave
  | C_Ping;
```

- [ ] **Step 1.2：在 `src/types/protocol.ts` 给 `C_Transfer` 加 `targetId?`**

```ts
export interface C_Transfer {
  type: "transfer";
  targetId?: string; // 3+ 人模式必须；缺省时服务端按"非自己第一个"处理
}
```

- [ ] **Step 1.3：在 `src/types/protocol.ts` 给 `S_RoomState` / `S_PhaseChange` 加可选字段**

`S_RoomState`：

```ts
export interface S_RoomState {
  type: "roomState";
  roomCode: string;
  players: PlayerInfo[];
  drawerId: string;
  phase: GamePhase;
  answerLength?: number;
  answer?: string;
  strokes: SerializedStroke[];
  chatHistory?: ChatHistoryEntry[];
  yourId: string;
  maxPlayers?: number;
  pendingPromotionId?: string;
}
```

`S_PhaseChange`：

```ts
export interface S_PhaseChange {
  type: "phaseChange";
  phase: GamePhase;
  drawerId: string;
  answerLength?: number;
  answer?: string;
  pendingPromotionId?: string;
}
```

- [ ] **Step 1.4：在 `worker/src/constants.ts` 加范围常量**

文件末尾追加：

```ts
// ---------- Multiplayer room capacity ----------
// Range for `?max=N` query on POST /api/rooms. Values outside this range fall back to MIN_MAX_PLAYERS.
export const MIN_MAX_PLAYERS = 2;
export const MAX_MAX_PLAYERS = 6;
```

- [ ] **Step 1.5：检查 `worker/src/types.ts` 不需要镜像**

`worker/src/types.ts` 当前只镜像了 `SerializedStroke` / `ChatHistoryEntry` / `PlayerInfo` / `PlayerAttachment` / `DisconnectedPlayer` / `GamePhase` / `BrushType`。本 task 加的 `C_ClaimDrawer` / `S_PhaseChange.pendingPromotionId` 不在镜像范围内（room.ts 都用 inline literal 类型），无需改动。

打开文件确认无改动需求。

- [ ] **Step 1.6：跑类型检查**

```bash
npx tsc --noEmit
cd worker && npx tsc --noEmit && cd ..
```

预期：两边都通过，无报错。

- [ ] **Step 1.7：跑 lint**

```bash
npm run lint
```

预期：通过（仅可能有原本就有的 3 个 exhaustive-deps warning）。

- [ ] **Step 1.8：提交**

```bash
git add src/types/protocol.ts worker/src/constants.ts
git commit -m "$(cat <<'EOF'
feat: 多人房协议字段（C_ClaimDrawer / targetId / maxPlayers / pendingPromotionId）

为多人房功能预留协议字段，全部可选，旧客户端无破坏。

合作对象：地表最强 Claude Opus
EOF
)"
```

---

## Task 2：服务端 maxPlayers + joinOrder + onJoin 改造

让服务端能接受房间人数，把 `isOwner` 退役改成动态计算，把 `getEffectivePlayerCount() >= 2` 的硬编码替换成 `>= maxPlayers`。**保 2 人模式行为不变**。

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/room.ts`
- Modify: `worker/src/types.ts`

- [ ] **Step 2.1：`worker/src/types.ts` 删除 PlayerAttachment / DisconnectedPlayer 的 isOwner**

```ts
export interface PlayerAttachment {
  id: string;
  name: string;
  quickLeave?: boolean;
}

export interface DisconnectedPlayer {
  id: string;
  name: string;
  disconnectedAt: number;
  graceMs: number;
}
```

注意：`PlayerInfo.isOwner` 字段保留（协议层面），仅服务端内部存储不再带这个字段。

- [ ] **Step 2.2：`worker/src/index.ts` `/api/rooms` 读取 max query**

替换原来的 `for (let i = 0; i < MAX_RETRIES; i++)` 块内：

```ts
const MAX_RETRIES = 5;
const maxRaw = parseInt(url.searchParams.get("max") || "2", 10);
const maxPlayers =
  Number.isFinite(maxRaw) && maxRaw >= 2 && maxRaw <= 6 ? maxRaw : 2;
for (let i = 0; i < MAX_RETRIES; i++) {
  const roomCode = generateRoomCode();
  const doId = env.GAME_ROOM.idFromName(roomCode);
  const stub = env.GAME_ROOM.get(doId);
  const initResp = await stub.fetch(
    new Request(
      "http://internal/init?code=" + roomCode + "&max=" + maxPlayers,
      { method: "POST" },
    ),
  );
  if (initResp.ok) {
    return new Response(JSON.stringify({ roomCode }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) },
    });
  }
}
```

- [ ] **Step 2.3：`worker/src/room.ts` 加新字段**

`import` 块追加：

```ts
import {
  // ... 已有
  MAX_MAX_PLAYERS,
  MIN_MAX_PLAYERS,
} from "./constants";
```

类成员（紧跟现有 in-memory cache 区）添加：

```ts
private maxPlayers = MIN_MAX_PLAYERS;
private joinOrder: string[] = [];
// pendingPromotionId 不持久化；用于 3+ 人房 revealed 阶段的猜对者
private pendingPromotionId: string | null = null;
```

- [ ] **Step 2.4：`ensureLoaded()` 反序列化新字段**

在原有 `data` get 调用增加 keys：

```ts
const data = await this.state.storage.get<unknown>([
  "created",
  "drawerId",
  "phase",
  "answer",
  "closed",
  "roomCode",
  "chatHistory",
  "disconnectedPlayers",
  "lastActivityAt",
  "maxPlayers",
  "joinOrder",
]);
```

并在赋值底部追加：

```ts
this.maxPlayers = (data.get("maxPlayers") as number) ?? MIN_MAX_PLAYERS;
this.joinOrder = (data.get("joinOrder") as string[]) ?? [];
```

- [ ] **Step 2.5：`saveState()` 写新字段**

```ts
await this.state.storage.put({
  created: this.created,
  drawerId: this.drawerId,
  phase: this.phase,
  answer: this.answer,
  closed: this.closed,
  roomCode: this.roomCode,
  chatHistory: this.chatHistory,
  disconnectedPlayers: Array.from(this.disconnectedPlayers.entries()),
  lastActivityAt: this.lastActivityAt,
  maxPlayers: this.maxPlayers,
  joinOrder: this.joinOrder,
});
```

注意 `pendingPromotionId` **不写**。

- [ ] **Step 2.6：`/init` handler 读 max query**

替换：

```ts
if (url.pathname === "/init" && request.method === "POST") {
  if (this.created) {
    return new Response(JSON.stringify({ error: "already created" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }
  const code = url.searchParams.get("code") || "";
  const maxRaw = parseInt(url.searchParams.get("max") || "2", 10);
  const maxPlayers =
    Number.isFinite(maxRaw) && maxRaw >= MIN_MAX_PLAYERS && maxRaw <= MAX_MAX_PLAYERS
      ? maxRaw
      : MIN_MAX_PLAYERS;
  this.created = true;
  this.roomCode = code;
  this.maxPlayers = maxPlayers;
  await this.state.storage.put({
    created: true,
    roomCode: code,
    maxPlayers,
  });
  return new Response("OK");
}
```

- [ ] **Step 2.7：`getPlayerInfoList()` 动态计算 isOwner**

```ts
private getPlayerInfoList(): PlayerInfo[] {
  return this.getJoinedWebSockets().map(({ player }) => ({
    id: player.id,
    name: player.name,
    isOwner: player.id === this.drawerId,
  }));
}
```

- [ ] **Step 2.8：`onJoin` 满员校验改用 maxPlayers**

把：

```ts
if (this.getEffectivePlayerCount() >= 2) {
  this.send(ws, { type: "error", message: "房间已满" });
  ...
}
```

改成：

```ts
if (this.getEffectivePlayerCount() >= this.maxPlayers) {
  this.send(ws, { type: "error", message: "房间已满" });
  try {
    ws.close(1000, "room full");
  } catch {
    /* ignore */
  }
  return;
}
```

- [ ] **Step 2.9：`onJoin` 改用 joinOrder 判首人 + 移除 isOwner attachment 字段 + 维护 joinOrder**

替换"---- New player join ----"以下到 `await this.saveState()` 之前的整段：

```ts
// ---- New player join ----
if (this.getEffectivePlayerCount() >= this.maxPlayers) {
  this.send(ws, { type: "error", message: "房间已满" });
  try {
    ws.close(1000, "room full");
  } catch {
    /* ignore */
  }
  return;
}

const isFirst = this.joinOrder.length === 0;
const player: PlayerAttachment = {
  id: crypto.randomUUID(),
  name: (
    playerName || `玩家${this.joinOrder.length + 1}`
  ).slice(0, MAX_NAME_LENGTH),
};

ws.serializeAttachment(player);
this.joinOrder.push(player.id);

if (isFirst) {
  this.drawerId = player.id;
  this.phase = "waiting";
} else if (this.joinOrder.length === 2) {
  // 第 2 人加入：和现在一样进 drawing
  this.phase = "drawing";
}
// 第 3 人及之后：phase 不变（已是 drawing/guessing/revealed 之一）

await this.saveState();
```

⚠️ 删掉了原来的 `this.closed = true` —— 满员靠 `getEffectivePlayerCount >= maxPlayers` 判断，不再用 closed。

- [ ] **Step 2.10：`onJoin` 已存在重连分支去除 isOwner**

`disconnectedPlayers` 重连分支：

```ts
const player: PlayerAttachment = {
  id: disconnected.id,
  name: disconnected.name,
};
```

active take-over 分支：

```ts
const player: PlayerAttachment = {
  id: existing.id,
  name: existing.name,
};
```

- [ ] **Step 2.11：`onDisconnect` 去除 isOwner attachment**

```ts
this.disconnectedPlayers.set(player.id, {
  id: player.id,
  name: player.name,
  disconnectedAt: Date.now(),
  graceMs,
});
```

- [ ] **Step 2.12：`onLeave` 去除 isOwner**

```ts
await this.processActualLeave({
  id: player.id,
  name: player.name,
  disconnectedAt: 0,
  graceMs: 0,
});
```

- [ ] **Step 2.13：`processActualLeave` 改用 joinOrder 选下一个 drawer + 维护 joinOrder**

新增 `isPlayerActive` 私有方法（紧跟 `getJoinedCount` 之后）：

```ts
private isPlayerActive(id: string): boolean {
  if (this.disconnectedPlayers.has(id)) {
    return true;
  }
  return this.getJoinedWebSockets().some(({ player }) => player.id === id);
}
```

`processActualLeave` 顶部追加 joinOrder 维护：

```ts
private async processActualLeave(dp: DisconnectedPlayer) {
  this.joinOrder = this.joinOrder.filter((id) => id !== dp.id);

  const remaining = this.getJoinedWebSockets();
  const otherDisconnected = Array.from(this.disconnectedPlayers.values());

  const allRemaining = [...remaining.map((r) => r.player), ...otherDisconnected];

  if (allRemaining.length > 0) {
    this.broadcast({
      type: "playerLeft",
      playerId: dp.id,
    });

    if (dp.id === this.drawerId) {
      let newDrawer: string | null = null;
      for (const id of this.joinOrder) {
        if (this.isPlayerActive(id)) {
          newDrawer = id;
          break;
        }
      }
      this.drawerId = newDrawer;
    }

    this.closed = false;
    this.phase = "waiting";
    this.answer = null;

    await this.saveState();

    this.broadcast({
      type: "phaseChange",
      phase: "waiting",
      drawerId: this.drawerId!,
    });
  } else {
    // Room is truly empty, reset everything
    this.created = false;
    this.closed = false;
    this.phase = "waiting";
    this.drawerId = null;
    this.answer = null;
    this.strokes = [];
    this.redoStack = [];
    this.chatHistory = [];
    this.maxPlayers = MIN_MAX_PLAYERS;
    this.joinOrder = [];
    this.pendingPromotionId = null;
    await this.saveState();
    await this.clearStrokeStorage();
  }
}
```

- [ ] **Step 2.14：`alarm()` 房间清空逻辑也重置 joinOrder / maxPlayers**

在 alarm() 的 `// Reset room` 块内追加：

```ts
this.joinOrder = [];
this.maxPlayers = MIN_MAX_PLAYERS;
this.pendingPromotionId = null;
```

并把 strokes/redoStack/chatHistory 重置那几行后面也加（已存在）。

- [ ] **Step 2.15：把 `S_RoomState` 加 `maxPlayers` / `pendingPromotionId` 字段（broadcast 时）**

`onJoin` 重连和新加入分支的 `this.send(ws, { type: "roomState", ... })` 三处都追加：

```ts
this.send(ws, {
  type: "roomState",
  roomCode: this.roomCode,
  players: this.getPlayerInfoList(),
  drawerId: this.drawerId,
  phase: this.phase,
  strokes: this.strokes,
  chatHistory: this.chatHistory,
  yourId: player.id,
  maxPlayers: this.maxPlayers,
  ...(this.pendingPromotionId ? { pendingPromotionId: this.pendingPromotionId } : {}),
  ...(player.id === this.drawerId && this.answer ? { answer: this.answer, answerLength: this.answer.length } : this.answer ? { answerLength: this.answer.length } : {}),
});
```

⚠️ 简化原来的 `answerLength` / `answer` 二个独立条件，合并成一个 spread。如果觉得太密可以保持原样另起两行——但要确保 `maxPlayers` 和 `pendingPromotionId` 都附上。

- [ ] **Step 2.16：跑类型检查**

```bash
cd worker && npx tsc --noEmit && cd ..
npx tsc --noEmit
```

预期：两边都通过。

- [ ] **Step 2.17：跑 lint**

```bash
npm run lint
```

预期：通过。

- [ ] **Step 2.18：提交**

```bash
git add worker/src/index.ts worker/src/room.ts worker/src/types.ts
git commit -m "$(cat <<'EOF'
feat: 服务端支持 maxPlayers 与 joinOrder

- /api/rooms 接受 ?max=N（2-6）
- DO 持久化 maxPlayers / joinOrder
- onJoin 满员判定改用 maxPlayers，首人判定改用 joinOrder.length===0
- isOwner 退役（attachment 内部不存），getPlayerInfoList 动态计算
- processActualLeave 用 joinOrder 顺序选下一个 drawer

合作对象：地表最强 Claude Opus
EOF
)"
```

⚠️ 此 commit 后**先部署 worker**（不要前端）。线上行为：
- 旧客户端创建房间不会带 `max=`，默认 2，行为完全不变
- 旧客户端加入新房间，看到 PlayerInfo 仍带 isOwner（动态算的，等于 drawer），UI 不变

---

## Task 3：创建房间 UI（人数选择控件）

**Files:**
- Modify: `src/pages/Home.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 3.1：`Home.tsx` 增 `maxPlayers` state 和分段控件**

`useState` 区追加：

```ts
const [maxPlayers, setMaxPlayers] = useState<number>(2);
```

在昵称 input 块后面、`error` 显示前面，新增：

```tsx
{/* Max players (only shown in menu mode) */}
{mode === "menu" && (
  <div className={tx("mb-6")}>
    <label className={tx("block text-sm font-medium text-gray-700 mb-1")}>房间人数</label>
    <div className={tx("flex gap-2")}>
      {[2, 3, 4, 5, 6].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => setMaxPlayers(n)}
          className={tx(
            "flex-1 py-2 text-sm rounded-lg transition border-2",
            maxPlayers === n
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300",
          )}
        >
          {n}人
        </button>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 3.2：`Home.tsx` `handleCreate` 携带 max query**

```ts
const handleCreate = async () => {
  if (!name.trim()) {
    setError("请输入昵称");
    return;
  }
  setLoading(true);
  setError("");
  try {
    const res = await fetch(apiUrl(`/api/rooms?max=${maxPlayers}`), { method: "POST" });
    const data = await res.json();
    onEnterRoom(data.roomCode, name.trim());
  } catch {
    setError("创建房间失败，请重试");
  } finally {
    setLoading(false);
  }
};
```

- [ ] **Step 3.3：`App.tsx` 不需要改**

`App.tsx` 的 `onEnterRoom(roomCode, playerName)` 签名仍然只传两个参数；maxPlayers 由服务端权威决定，前端从 `roomState.maxPlayers` 读，不需要在 App 层透传。打开文件确认无改动需求。

- [ ] **Step 3.4：跑类型检查 + lint**

```bash
npx tsc --noEmit
npm run lint
```

预期：通过。

- [ ] **Step 3.5：手动验证**

```bash
npm run dev
```

打开浏览器，验证：
- 默认页面"2人"按钮高亮
- 点 3/4/5/6 切换高亮
- "加入房间"模式下不显示人数选择控件
- 输昵称、选 4 人、点"创建房间" → 网络请求 URL 含 `?max=4`

- [ ] **Step 3.6：提交**

```bash
git add src/pages/Home.tsx
git commit -m "$(cat <<'EOF'
feat: Home 页加房间人数选择控件

- 分段按钮 2/3/4/5/6 默认 2，仅在"创建房间"模式显示
- handleCreate fetch 加 ?max=N

合作对象：地表最强 Claude Opus
EOF
)"
```

---

## Task 4：画板冻结（核心：guessing 阶段没人能改画板）

**Files:**
- Modify: `worker/src/room.ts`
- Modify: `src/hooks/useCanvas.ts`
- Modify: `src/components/Canvas.tsx`
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/pages/Room.tsx`

- [ ] **Step 4.1：`worker/src/room.ts` 新增 `canMutateCanvas` 助手**

紧跟 `getPlayerInfoList()` 之后插入：

```ts
private canMutateCanvas(): boolean {
  return this.phase === "drawing" || this.phase === "waiting";
}
```

- [ ] **Step 4.2：8 处 handler 加守卫**

每个 handler 在 `if (!player || player.id !== this.drawerId) return;` 之后加一行：

```ts
if (!this.canMutateCanvas()) return;
```

涉及（room.ts）：
- `onDraw`
- `onTextStroke`
- `onShape`
- `onFill`
- `onSelection`
- `onClear`
- `onUndo`
- `onRedo`

⚠️ `onSetAnswer` 不加（它需要在 phase=drawing 时被允许，已有逻辑会自然拒绝其他阶段：onSetAnswer 内部其实没检查 phase——但行为依赖 onGuess 也必须 phase=guessing 才生效，如果 drawer 在 guessing/revealed 阶段重新 setAnswer 会改 answer + 强制回 guessing。**为了防止跨阶段 setAnswer**，给 `onSetAnswer` 也加一行 `if (this.phase !== "drawing") return;` 在 drawerId 校验后）：

```ts
private async onSetAnswer(ws: WebSocket, answer: string) {
  const player = this.getPlayer(ws);
  if (!player || player.id !== this.drawerId) {
    return;
  }
  if (this.phase !== "drawing") {
    return;
  }
  if (!answer || answer.trim().length === 0) {
    return;
  }
  // ... 后续不变
}
```

- [ ] **Step 4.3：`src/hooks/useCanvas.ts` 加 phase 参数 + 鼠标事件 early-return**

useCanvas 当前 signature 大致：

```ts
export function useCanvas({
  canvasRef,
  tool,
  color,
  // ...
})
```

新增参数 `phase: GamePhase`（从 `protocol.ts` import）：

```ts
import type { BrushType, GamePhase } from "../types/protocol";

export function useCanvas({
  canvasRef,
  tool,
  color,
  // ...
  phase,
}: {
  // ... 已有
  phase: GamePhase;
})
```

在 `onMouseDown`、`onMouseMove`、`onMouseUp`、`onMouseLeave` 等所有事件 handler 顶部统一 early-return（如果当前是 drawer 才能画的角色判断已在外层做了，这里只看 phase）：

```ts
const onMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
  if (phase !== "drawing") {
    return;
  }
  // ... 现有逻辑
};
```

涉及的事件 handler 包含：`onMouseDown` / `onMouseMove` / `onMouseUp` / `onMouseLeave` / `onShapeDown` / `onShapeMove` / `onShapeUp` / `onShapeLeave` / `onTextClick` / `onFill` / `onSelectionDown` / `onSelectionMove` / `onSelectionUp`。每个顶部都加一句 `if (phase !== "drawing") return;`。

⚠️ 选择器：`tool === "selection"` 当前的 patch 提取不应在 guessing 期间执行。守卫覆盖 `onSelectionDown` 即可。

- [ ] **Step 4.4：`src/components/Canvas.tsx` 把 phase 传给 useCanvas**

Canvas.tsx 接收 `phase` prop（如果还没接收）：

打开文件查找 `interface Props` —— 如果没 phase 就加：

```ts
interface Props {
  // ... 已有
  phase: GamePhase;
}
```

并在 `useCanvas({...})` 调用里加 `phase`。

import：

```ts
import type { GamePhase } from "../types/protocol";
```

- [ ] **Step 4.5：`src/pages/Room.tsx` 把 phase 传给 Canvas**

找到 `<Canvas ... />` JSX 调用，确保有 `phase={phase}`。Room.tsx 已有 `phase` state，直接传即可。

- [ ] **Step 4.6：`src/components/Toolbar.tsx` 整体置灰当 phase ≠ drawing**

Toolbar 接收 `phase` 或 `disabled` prop。最简：加 `disabled?: boolean`，由 Room.tsx 传 `disabled={phase !== "drawing" || !isDrawer}`。

interface Props 追加：

```ts
disabled?: boolean;
```

最外层 wrapper className 增加 disabled 样式：

```tsx
<div
  className={tx(
    "flex gap-2 items-center bg-white p-2 rounded-xl shadow-sm",
    disabled && "opacity-50 pointer-events-none select-none",
  )}
>
```

⚠️ 已经有的 wrapper className 如不同，按现有结构插入 `disabled && "opacity-50 pointer-events-none select-none"`。

- [ ] **Step 4.7：`src/pages/Room.tsx` 给 Toolbar 传 disabled**

```tsx
<Toolbar
  // ... 已有
  disabled={!isDrawer || phase !== "drawing"}
/>
```

- [ ] **Step 4.8：跑类型检查 + lint**

```bash
cd worker && npx tsc --noEmit && cd ..
npx tsc --noEmit
npm run lint
```

预期：通过。

- [ ] **Step 4.9：手动验证（需要本地 worker）**

```bash
cd worker && npx wrangler dev
# 另一终端
npm run dev
```

把 `.env.development` 的 `VITE_API_BASE` 暂改 `http://localhost:8787`。

测试：
- 创建 2 人房，加入第二人
- drawer 画几笔，setAnswer "苹果"
- ✅ phase 变 guessing：drawer 工具栏置灰，鼠标点画板无反应；guesser 仍能输 guess
- guesser 输错的，drawer 不能动画板（页面冻结）
- guesser 输对，phase=revealed，画板仍冻结
- drawer 点"继续出题"或"转让画笔"——✅ 画板解冻

- [ ] **Step 4.10：提交**

```bash
git add worker/src/room.ts src/hooks/useCanvas.ts src/components/Canvas.tsx src/components/Toolbar.tsx src/pages/Room.tsx
git commit -m "$(cat <<'EOF'
feat: guessing/revealed 阶段画板冻结

服务端：8 处 mutator handler 加 canMutateCanvas() 守卫；onSetAnswer 显式拒非 drawing 阶段
前端：useCanvas 各鼠标 handler early-return；Toolbar 整体置灰

合作对象：地表最强 Claude Opus
EOF
)"
```

---

## Task 5：PlayerBar 多人显示

**Files:**
- Modify: `src/components/PlayerBar.tsx`
- Modify: `src/pages/Room.tsx`

- [ ] **Step 5.1：`src/pages/Room.tsx` 维护 maxPlayers state**

`useState` 区追加：

```ts
const [maxPlayers, setMaxPlayers] = useState<number>(2);
```

在 WebSocket switch 的 `case "roomState":` 里：

```ts
case "roomState":
  setRoomCode(msg.roomCode);
  setPlayers(msg.players);
  setDrawerId(msg.drawerId);
  setPhase(msg.phase);
  if (typeof msg.maxPlayers === "number") {
    setMaxPlayers(msg.maxPlayers);
  }
  // ... 其余不变
```

- [ ] **Step 5.2：`PlayerBar.tsx` 接收 `maxPlayers` 和按 joinOrder 渲染**

interface Props 追加：

```ts
maxPlayers: number;
```

⚠️ 没有 joinOrder：前端只有 `players: PlayerInfo[]`，顺序就是 server `getPlayerInfoList()` 返回顺序，而 server 那边的顺序来自 `getJoinedWebSockets()`（不是 joinOrder）。这是一个隐藏的不一致——服务端返回的 players 顺序可能与 joinOrder 不一致。

修复：服务端 `getPlayerInfoList()` 改用 `joinOrder` 排序：

```ts
private getPlayerInfoList(): PlayerInfo[] {
  const joined = new Map(
    this.getJoinedWebSockets().map(({ player }) => [player.id, player]),
  );
  return this.joinOrder
    .map((id) => joined.get(id))
    .filter((p): p is PlayerAttachment => p !== undefined)
    .map((player) => ({
      id: player.id,
      name: player.name,
      isOwner: player.id === this.drawerId,
    }));
}
```

⚠️ 这要改 `worker/src/room.ts`，不在 Step 5.1 范围内。先去改它。

回到 PlayerBar.tsx：现在可以直接信任 `players` 数组顺序 = joinOrder 中的在线者。

- [ ] **Step 5.3：`worker/src/room.ts` `getPlayerInfoList()` 按 joinOrder 排序**

替换原方法：

```ts
private getPlayerInfoList(): PlayerInfo[] {
  const joined = new Map(
    this.getJoinedWebSockets().map(({ player }) => [player.id, player]),
  );
  const result: PlayerInfo[] = [];
  for (const id of this.joinOrder) {
    const player = joined.get(id);
    if (player) {
      result.push({
        id: player.id,
        name: player.name,
        isOwner: player.id === this.drawerId,
      });
    }
  }
  return result;
}
```

- [ ] **Step 5.4：`PlayerBar.tsx` 多人显示规则 + 满员隐藏分享 + 显示 +N 按钮**

interface Props 完整版：

```ts
interface Props {
  roomCode: string;
  players: PlayerInfo[];
  drawerId: string | null;
  myId: string | null;
  phase: GamePhase;
  maxPlayers: number;
  onTransfer: () => void;
  onContinueDrawing: () => void;
  onLeave: () => void;
}
```

⚠️ Task 6 才完整改 onTransfer 接受 targetId，本 task 先保持现签名。

替换中段"Players"区为：

```tsx
{/* Players */}
<div className={tx("flex items-center gap-3")}>
  {(() => {
    const drawerPlayer = players.find((p) => p.id === drawerId);
    const others = players.filter((p) => p.id !== drawerId);
    const visible: PlayerInfo[] = [];
    if (drawerPlayer) {
      visible.push(drawerPlayer);
    }
    if (others.length > 0) {
      visible.push(others[0]);
    }
    const overflow = others.slice(1);
    return (
      <>
        {visible.map((p) => (
          <div
            key={p.id}
            className={tx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm",
              p.id === drawerId
                ? "bg-indigo-50 text-indigo-700"
                : "bg-gray-50 text-gray-700",
              p.id === myId && "font-semibold",
            )}
          >
            <span>{p.id === drawerId ? "🎨" : "🤔"}</span>
            <span>{p.name}</span>
            {p.id === myId && <span className={tx("text-xs text-gray-400")}>(你)</span>}
          </div>
        ))}
        {overflow.length > 0 && <PlayerOverflow players={overflow} myId={myId} />}
        {players.length < 2 && (
          <div className={tx("text-sm text-gray-400 animate-pulse")}>等待玩家加入...</div>
        )}
      </>
    );
  })()}
</div>
```

文件上方新增 `PlayerOverflow` 子组件：

```tsx
function PlayerOverflow({ players, myId }: { players: PlayerInfo[]; myId: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className={tx("relative")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={tx(
          "flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm bg-gray-100 text-gray-600 hover:bg-gray-200 transition",
        )}
      >
        <span>+{players.length}</span>
        <span className={tx("text-xs")}>▼</span>
      </button>
      {open && (
        <div
          className={tx(
            "absolute left-1/2 -translate-x-1/2 top-full mt-1 z-30",
            "bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[140px]",
          )}
        >
          {players.map((p) => (
            <div
              key={p.id}
              className={tx(
                "px-3 py-1.5 text-sm text-gray-700 flex items-center gap-1.5",
              )}
            >
              <span>🤔</span>
              <span>{p.name}</span>
              {p.id === myId && <span className={tx("text-xs text-gray-400")}>(你)</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

import 顶部追加：

```ts
import { useState, useRef, useEffect } from "react";
```

⚠️ 文件原本只用 `useState`，加上 `useRef` 和 `useEffect`。

- [ ] **Step 5.5：分享房间按钮：满员隐藏**

替换："`{players.length === 1 && (`" 那行的条件为：

```tsx
{players.length < maxPlayers && (
  <button
    onClick={handleCopyLink}
    // ...
  >
    {copied ? "已复制" : "分享房间"}
  </button>
)}
```

- [ ] **Step 5.6：`Room.tsx` 把 maxPlayers 传给 PlayerBar**

```tsx
<PlayerBar
  // ... 已有
  maxPlayers={maxPlayers}
/>
```

- [ ] **Step 5.7：跑类型检查 + lint**

```bash
cd worker && npx tsc --noEmit && cd ..
npx tsc --noEmit
npm run lint
```

预期：通过。

- [ ] **Step 5.8：手动验证**

```bash
# 重启 wrangler dev + npm run dev
```

测试：
- 创建 4 人房 → 1 人显示"等待玩家加入..."
- 第二人加入：显示俩人
- 第三人加入：显示俩人 + "+1 ▼"
- 第四人加入：显示俩人 + "+2 ▼"，分享按钮**消失**
- 点 "+N ▼" → 弹下拉显示其余玩家

- [ ] **Step 5.9：提交**

```bash
git add worker/src/room.ts src/components/PlayerBar.tsx src/pages/Room.tsx
git commit -m "$(cat <<'EOF'
feat: PlayerBar 多人显示规则与满员隐藏分享

- getPlayerInfoList 按 joinOrder 顺序返回
- PlayerBar 3+ 人时显示 [drawer] [P2] [+N ▼] 折叠下拉
- 房间满员（players >= maxPlayers）时隐藏分享按钮

合作对象：地表最强 Claude Opus
EOF
)"
```

---

## Task 6：转让画笔加 targetId + 多人下拉 UI

**Files:**
- Modify: `worker/src/room.ts`
- Modify: `src/components/PlayerBar.tsx`
- Modify: `src/pages/Room.tsx`

- [ ] **Step 6.1：`worker/src/room.ts` `webSocketMessage` 透传 msg 给 onTransfer**

把：

```ts
case "transfer":
  await this.onTransfer(ws);
  break;
```

改成：

```ts
case "transfer":
  await this.onTransfer(ws, msg as { type: string; targetId?: string });
  break;
```

- [ ] **Step 6.2：`onTransfer` 接受 targetId**

替换：

```ts
private async onTransfer(
  ws: WebSocket,
  msg: { type: string; targetId?: string },
) {
  const player = this.getPlayer(ws);
  if (!player || player.id !== this.drawerId) {
    return;
  }

  let targetId = msg.targetId;
  if (!targetId) {
    // 兼容 2 人 / 旧客户端：转给非自己的第一个
    for (const { player: other } of this.getJoinedWebSockets()) {
      if (other.id !== player.id) {
        targetId = other.id;
        break;
      }
    }
  }
  if (!targetId) {
    return;
  }

  // 验证 targetId 是当前在线玩家且不是自己
  const targetOnline = this.getJoinedWebSockets().some(
    ({ player: p }) => p.id === targetId,
  );
  if (!targetOnline) {
    return;
  }
  if (targetId === player.id) {
    return;
  }

  await this.executeTransfer(targetId);
}
```

- [ ] **Step 6.3：`PlayerBar.tsx` 改 onTransfer 签名**

interface Props：

```ts
onTransfer: (targetId?: string) => void;
```

- [ ] **Step 6.4：`Room.tsx` `handleTransfer` 加 targetId 参数**

```ts
const handleTransfer = (targetId?: string) => {
  if (targetId) {
    send({ type: "transfer", targetId });
  } else {
    send({ type: "transfer" });
  }
};
```

- [ ] **Step 6.5：`PlayerBar.tsx` 转让按钮 2 人/3+ 人分支**

替换 actions 区里现有"转让画笔"按钮的 JSX。先在文件顶部加子组件 `TransferDropdown`：

```tsx
function TransferDropdown({
  candidates,
  onPick,
}: {
  candidates: PlayerInfo[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className={tx("relative")} data-transfer-popover>
      <button
        onClick={() => setOpen((v) => !v)}
        className={tx(
          "px-3 py-1.5 text-sm bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-lg transition flex items-center gap-1",
        )}
      >
        <span>转让画笔</span>
        <span className={tx("text-xs")}>▼</span>
      </button>
      {open && (
        <div
          className={tx(
            "absolute right-0 top-full mt-1 z-30",
            "bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[160px]",
          )}
        >
          {candidates.length === 0 && (
            <div className={tx("px-3 py-1.5 text-sm text-gray-400")}>无可转让玩家</div>
          )}
          {candidates.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setOpen(false);
                onPick(p.id);
              }}
              className={tx(
                "w-full px-3 py-1.5 text-sm text-left text-gray-700 hover:bg-amber-50 flex items-center gap-1.5",
              )}
            >
              <span>🤔</span>
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

actions 块替换原"转让画笔"按钮：

```tsx
{isDrawer && players.length === 2 && (
  <button
    onClick={() => onTransfer()}
    className={tx(
      "px-3 py-1.5 text-sm bg-amber-50 text-amber-700",
      "hover:bg-amber-100 rounded-lg transition",
    )}
  >
    转让画笔
  </button>
)}
{isDrawer && players.length >= 3 && (
  <TransferDropdown
    candidates={players.filter((p) => p.id !== myId)}
    onPick={(id) => onTransfer(id)}
  />
)}
```

⚠️ "继续出题"按钮的"`players.length === 2`"条件**保持不变**（Task 7 才会因为自动升级在 3+ 人 revealed 阶段隐藏它）。

- [ ] **Step 6.6：跑类型检查 + lint**

```bash
cd worker && npx tsc --noEmit && cd ..
npx tsc --noEmit
npm run lint
```

预期：通过。

- [ ] **Step 6.7：手动验证**

3 人房：drawer 看到"转让画笔 ▼"，点开下拉有 2 个候选，选一个 → drawer 切到该玩家，画板清空进 drawing。
2 人房：drawer 看到"转让画笔"（无 ▼），点了直接转给对方。

- [ ] **Step 6.8：提交**

```bash
git add worker/src/room.ts src/components/PlayerBar.tsx src/pages/Room.tsx
git commit -m "$(cat <<'EOF'
feat: 转让画笔在 3+ 人房显示下拉选择

- C_Transfer 加可选 targetId（旧客户端无变化）
- 服务端 onTransfer 校验 targetId 在线、非自己
- PlayerBar 3+ 人模式下"转让画笔 ▼"展开下拉，列出非自己玩家

合作对象：地表最强 Claude Opus
EOF
)"
```

---

## Task 7：自动升级（pendingPromotionId + claim 流程）

**Files:**
- Modify: `worker/src/room.ts`
- Modify: `src/pages/Room.tsx`
- Modify: `src/components/PlayerBar.tsx`

- [ ] **Step 7.1：`worker/src/room.ts` `webSocketMessage` 加 claimDrawer 分支**

switch case 区追加：

```ts
case "claimDrawer":
  await this.onClaimDrawer(ws);
  break;
```

- [ ] **Step 7.2：`worker/src/room.ts` 实现 onClaimDrawer**

紧跟 onTransfer 之后：

```ts
private async onClaimDrawer(ws: WebSocket) {
  const player = this.getPlayer(ws);
  if (!player) {
    return;
  }
  if (this.phase !== "revealed") {
    return;
  }
  if (!this.pendingPromotionId || this.pendingPromotionId !== player.id) {
    return;
  }
  await this.executeTransfer(player.id);
}
```

- [ ] **Step 7.3：`onGuess` 猜对时设置 pendingPromotionId**

替换 `if (correct)` 块：

```ts
if (correct) {
  this.phase = "revealed";

  if (this.getJoinedCount() >= 3) {
    this.pendingPromotionId = player.id;
  } else {
    this.pendingPromotionId = null;
  }

  await this.saveState();

  this.broadcast({
    type: "phaseChange",
    phase: "revealed",
    drawerId: this.drawerId!,
    ...(this.pendingPromotionId
      ? { pendingPromotionId: this.pendingPromotionId }
      : {}),
  });
}
```

- [ ] **Step 7.4：`executeTransfer` / `onContinueDrawing` / `onClear` / `processActualLeave` 都清 pendingPromotionId**

每个方法在改 phase 离开 revealed 的地方都加 `this.pendingPromotionId = null;`。

`executeTransfer` 顶部追加：

```ts
private async executeTransfer(newDrawerId: string) {
  this.pendingPromotionId = null;
  this.drawerId = newDrawerId;
  // ... 其余不变
}
```

`onContinueDrawing` 在 `this.phase = "drawing";` 之前/之后追加：

```ts
this.pendingPromotionId = null;
```

`onClear` 不切 phase，但保险起见也加（防御性）：

```ts
private async onClear(ws: WebSocket) {
  const player = this.getPlayer(ws);
  if (!player || player.id !== this.drawerId) {
    return;
  }
  if (!this.canMutateCanvas()) {
    return;
  }
  this.pendingPromotionId = null;  // ← 新增（防御）
  this.strokes = [];
  // ...
}
```

- [ ] **Step 7.5：`processActualLeave` 处理猜对者离开**

在方法顶部 `this.joinOrder = this.joinOrder.filter(...)` 之前/之后插入：

```ts
const wasPendingPromotion =
  this.pendingPromotionId !== null && dp.id === this.pendingPromotionId;
if (wasPendingPromotion) {
  this.pendingPromotionId = null;
}
```

并在 `if (allRemaining.length > 0) {` 块**末尾**（broadcast playerLeft 之后、phase reset 之前）插入：

```ts
if (wasPendingPromotion && this.phase === "revealed") {
  // 猜对者掉线，给当前 drawer 重发一次 phaseChange(revealed)
  // 但不带 pendingPromotionId，让前端重新显示"继续出题/转让画笔"
  await this.saveState();  // 持久化 joinOrder 的变动
  this.broadcast({
    type: "phaseChange",
    phase: "revealed",
    drawerId: this.drawerId!,
  });
  // 退出，不再走下面的"phase = waiting"重置
  return;
}
```

⚠️ 现在 `processActualLeave` 在所有非空场景都把 phase 重置为 waiting。猜对者掉线场景需要保留 phase=revealed 让 drawer 看到按钮。所以加这个 early return。但这意味着：drawer 离开时 phase 仍然 reset 到 waiting（保持现行为）；猜对者离开时 phase 保留 revealed。

⚠️ 注意 `await this.saveState()` 必须在 return 前调，否则 `this.joinOrder.filter` 的更新不会持久化。

- [ ] **Step 7.6：前端 `Room.tsx` 维护 pendingPromotionId state**

useState 区：

```ts
const [pendingPromotionId, setPendingPromotionId] = useState<string | null>(null);
```

WebSocket switch `case "roomState":`：

```ts
case "roomState":
  // ... 已有
  setPendingPromotionId(msg.pendingPromotionId ?? null);
  // ... 已有
```

WebSocket switch `case "phaseChange":`：

```ts
case "phaseChange":
  setPhase(msg.phase);
  setDrawerId(msg.drawerId);
  if (msg.phase === "revealed") {
    setPendingPromotionId(msg.pendingPromotionId ?? null);
  } else {
    setPendingPromotionId(null);
  }
  // ... 其余原有逻辑
```

⚠️ 任何非 revealed 的 phase 切换都清 pendingPromotionId（包括 drawing / guessing / waiting）。

- [ ] **Step 7.7：`Room.tsx` 自动升级 useEffect**

紧跟其他 useEffect 之后：

```ts
useEffect(() => {
  if (phase !== "revealed") {
    return;
  }
  if (pendingPromotionId === null) {
    return;
  }
  if (pendingPromotionId !== myId) {
    return;
  }

  const AUTO_PROMOTE_DELAY_MS = 6500;
  const timer = window.setTimeout(() => {
    send({ type: "claimDrawer" });
  }, AUTO_PROMOTE_DELAY_MS);

  return () => {
    window.clearTimeout(timer);
  };
}, [phase, pendingPromotionId, myId, send]);
```

- [ ] **Step 7.8：`Room.tsx` 把 pendingPromotionId 传给 PlayerBar**

```tsx
<PlayerBar
  // ... 已有
  pendingPromotionId={pendingPromotionId}
/>
```

- [ ] **Step 7.9：`PlayerBar.tsx` 接收 pendingPromotionId + revealed 阶段提示与隐藏按钮**

interface Props 加：

```ts
pendingPromotionId?: string | null;
```

actions 区里两段按钮的条件改为：

```tsx
{isDrawer && players.length === 2 && phase === "revealed" && (
  <button onClick={onContinueDrawing} ...>继续出题</button>
)}
{isDrawer && players.length === 2 && (
  <button onClick={() => onTransfer()} ...>转让画笔</button>
)}
{isDrawer && players.length >= 3 && phase !== "revealed" && (
  <TransferDropdown ... />
)}
```

⚠️ 3+ 人 + revealed 阶段：所有 drawer 操作按钮都隐藏（自动升级在跑）。

中段"Players"区 / "Phase indicator"右侧或下方追加自动升级提示。最简单：在 `Phase indicator` 同一行后面增加：

```tsx
{phase === "revealed" && pendingPromotionId && (() => {
  const winner = players.find((p) => p.id === pendingPromotionId);
  if (!winner) {
    return null;
  }
  return (
    <div className={tx("text-xs text-purple-700 ml-2")}>
      🏆 {winner.name} 即将获得画笔...
    </div>
  );
})()}
```

- [ ] **Step 7.10：跑类型检查 + lint**

```bash
cd worker && npx tsc --noEmit && cd ..
npx tsc --noEmit
npm run lint
```

预期：通过。

- [ ] **Step 7.11：手动验证（3 人房）**

```
1. 创建 3 人房，3 个浏览器 tab 分别加入
2. drawer 画几笔，setAnswer "苹果"
3. P2 输 "苹果" 猜对
4. ✅ 三人画板上都触发 confetti
5. ✅ 顶栏显示 "🏆 P2 即将获得画笔..."
6. ✅ drawer 看不到"继续出题/转让画笔"按钮
7. ⏱ 约 6.5 秒后自动 transfer：drawer 切到 P2，画板清空，phase=drawing
8. ✅ P2 现在能画
```

2 人房验证：
```
1. 2 人房，drawer setAnswer + 猜对者猜对
2. ✅ 没有 "🏆 即将获得画笔" 提示
3. ✅ drawer 看到"继续出题/转让画笔"按钮（与之前完全一致）
```

- [ ] **Step 7.12：提交**

```bash
git add worker/src/room.ts src/pages/Room.tsx src/components/PlayerBar.tsx
git commit -m "$(cat <<'EOF'
feat: 3+ 人房猜对者自动升级为房主

- 服务端 onGuess 在 3+ 人房猜对时设 pendingPromotionId 并附带于 phaseChange
- 新增 onClaimDrawer：校验 sender == pendingPromotionId 触发 executeTransfer
- 前端猜对者本机 6.5s 倒计时后自动 send claimDrawer
- PlayerBar 在 3+ 人 revealed 阶段隐藏 drawer 操作按钮，顶栏显示"X 即将获得画笔"
- processActualLeave 处理猜对者离线：清 pendingPromotionId 并重发 phaseChange(revealed)

合作对象：地表最强 Claude Opus
EOF
)"
```

---

## Task 8：ChatPanel 文案微调（多人时改"其他玩家"）

**Files:**
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/pages/Room.tsx`

- [ ] **Step 8.1：`ChatPanel.tsx` 接收 players.length 信号**

interface Props 增：

```ts
playerCount: number;
```

文案部分：

```tsx
{mode === "setAnswer" && (
  <div className={tx("text-xs text-indigo-600 mb-1.5")}>
    {playerCount > 2 ? "设置答案后其他玩家才能开始猜" : "设置答案后对方才能开始猜"}
  </div>
)}
```

- [ ] **Step 8.2：`Room.tsx` 传 playerCount**

```tsx
<ChatPanel
  // ... 已有
  playerCount={players.length}
/>
```

- [ ] **Step 8.3：跑类型检查 + lint**

```bash
npx tsc --noEmit
npm run lint
```

预期：通过。

- [ ] **Step 8.4：手动验证**

2 人房：drawer 切 setAnswer 模式 → 提示"设置答案后**对方**才能开始猜"
3+ 人房：drawer 切 setAnswer 模式 → 提示"设置答案后**其他玩家**才能开始猜"

- [ ] **Step 8.5：提交**

```bash
git add src/components/ChatPanel.tsx src/pages/Room.tsx
git commit -m "$(cat <<'EOF'
style: 设答案提示在多人房改用"其他玩家"

合作对象：地表最强 Claude Opus
EOF
)"
```

---

## 部署

每个 task 提交后都可独立部署。完整顺序：

1. 推 master → CI 自动部署 worker（涉及 worker/** 改动的 commit）+ Pages（前端改动 commit）
2. 部署完成后跑一次完整 e2e（4 人房）：
   - P1 创建 4 人房（选 4 人）
   - P2/P3/P4 加入 → PlayerBar 显示 P1+P2+`+2 ▼`，P4 加入后分享按钮消失
   - P1 画图 + setAnswer → 工具栏置灰，画板冻结
   - P3 猜对 → 6.5 秒后 P3 自动获得画笔
   - 看 P1 顶栏的"🏆 P3 即将获得画笔..."提示是否在
3. 回归 2 人房：所有原有行为不变（继续出题/转让画笔按钮、文案、自动升级**不**触发）

## 风险点（执行时盯一下）

- **`onJoin` 重连分支**：roomState 必须包含 maxPlayers / pendingPromotionId 字段，否则前端重连后 maxPlayers 会被 reset 为默认 2。Step 2.15 已覆盖。
- **`saveState()` 的 `joinOrder` 写入频率**：每次 join/disconnect 都会写。可接受，但值得 grep 一下确认没在循环里调。
- **isOwner 字段的旧 attachment 兼容**：DO 升级时如果有 ws 还连着，旧 attachment 仍带 isOwner 字段——TypeScript 类型读取缺字段返回 undefined，新代码不读 isOwner，不会出错。
- **6 人房 Toolbar 置灰** 在 guessing 阶段是否所有 6 个 client 都能看到？逻辑上 phase 是 broadcast 的全员状态，所有 6 人 phase 一致，Toolbar 都置灰。✓
- **`processActualLeave` early return 的 phase=waiting reset**：原有逻辑无条件把 phase 设回 waiting + answer 清空。Step 7.5 加了"猜对者离开 → return 早退"分支后，drawer 离开仍然走原路径 reset phase=waiting，行为正确。✓

## 验收标准（done definition）

- 类型检查通过（前后端各一次 `npx tsc --noEmit`）
- ESLint 通过（`npm run lint`，原有 3 个 exhaustive-deps warning 不计）
- 4 人房 e2e 全过（创建 / 加入 / 画 / 设答案 / 猜对 / 自动升级 / 转让 / 满员隐藏分享）
- 2 人房 e2e 完全等价于改动前行为
- 旧客户端进入新房间不崩（PlayerBar 渲染前 2 个，看不到 P3+，但功能不报错）
