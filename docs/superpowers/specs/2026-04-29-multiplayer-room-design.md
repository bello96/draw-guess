# 多人房间设计（2-6 人）

**日期**：2026-04-29
**目标**：把当前 2 人房间扩展到 2-6 人，并收紧 guessing 阶段的画板写入权限。

---

## 1. 需求总览

源自用户 8 条需求：

1. 创建房间时增加"房间人数"选择（2-6，默认 2）
2. 加入房间需要校验"是否已满"，满了提示并不可加入
3. PlayerBar 顶部玩家展示：1 人保留"等待玩家加入..."占位；2 人显示俩人；3+ 人显示前两人 + "更多" 折叠下拉
4. 转让画笔：3+ 人时点按钮弹下拉气泡，让房主选转给谁；2 人保持点了直接转给对方
5. 3+ 人房，玩家猜对后**自动升级为房主**（拥有画笔权），不立刻执行，等彩带结束后再切
6. "分享房间"按钮：人数已满隐藏
7. ChatPanel 设答案提示："设置答案后对方才能开始猜"——多人时改成"其他玩家"
8. **房主设答案后，画板冻结**——任何人（包括房主自己）都不能修改画板内容，只能聊天/猜词

## 2. 关键术语对齐

- **房主 = 当前持画笔的玩家**（drawer），与"创建房间的人"无关
- 现有代码里 `isOwner` 字段冗余，本设计将其退役（动态计算 `isOwner = id === drawerId`）

## 3. 状态模型变更

### 3.1 退役 `isOwner` 字段

分两层：

- **服务端内部**（DO 持久化）：`PlayerAttachment` / `DisconnectedPlayer` 移除 `isOwner` 字段。不再持久化"谁创建了房"这个语义。
- **协议表面**（`PlayerInfo` 类型）：仍保留 `isOwner: boolean`，但**值由服务端动态计算** `isOwner = (id === drawerId)`，不读取持久化字段。

新前端**不再读** `isOwner`，统一用 `playerId === drawerId` 判断。

旧客户端读到的 `isOwner` 仍是合法布尔，仅语义从"创建者"变成"持笔者"——而旧 2 人模式下两者本来就一致，UI 着色不变。

**不 bump 协议版本**。

### 3.2 新增 `maxPlayers`

- DO 持久化 `maxPlayers: number`，范围 2-6，缺省 2
- `S_RoomState` 新增可选字段 `maxPlayers?: number`
- `POST /api/rooms` 接受 query `?max=N`，验证范围；不在范围内或缺失时按 2 处理

### 3.3 新增"加入顺序"列表

- DO 持久化 `joinOrder: string[]`（player.id）
- `onJoin` 新玩家末尾追加；重连不动顺序
- `processActualLeave` / `onLeave` 删除对应项
- PlayerBar 第二格固定显示"`joinOrder` 中第一个非 drawer 的人"

### 3.4 新增"待升级猜对者"

- DO 内存字段 `pendingPromotionId: string | null`，**不持久化**（hibernation 后丢失即"取消升级"，可接受）
- 仅在 `phase === "revealed"` 期间有意义
- `executeTransfer` / `onContinueDrawing` / `onClear` 等任何切换到非 revealed 阶段的路径都置 null

## 4. 状态机收窄（核心：画板冻结）

### 4.1 服务端守卫

新增辅助：

```ts
private canMutateCanvas(): boolean {
  return this.phase === "drawing" || this.phase === "waiting";
}
```

在以下 8 个 handler 顶部统一拦截（紧跟 drawer 校验后）：
- `onDraw`
- `onTextStroke`
- `onShape`
- `onFill`
- `onSelection`
- `onClear`
- `onUndo`
- `onRedo`

```ts
if (!player || player.id !== this.drawerId) return;
if (!this.canMutateCanvas()) return;
```

`onSetAnswer` / `onContinueDrawing` / `onTransfer` 不属于"改画板内容"，沿用现有阶段判断。

### 4.2 前端配套

- `useCanvas` 在 `phase !== "drawing"` 时所有鼠标 handler early-return
- `Toolbar` 整体置灰（透明度 50% + pointer-events: none）当 `!isDrawer || phase !== "drawing"`
- `PlayerBar` 的 undo/redo/clear（如果未来挪到这）以及"撤销/重做/清除"按钮 disabled

| 阶段 | 谁能改画板 |
|------|------------|
| waiting | 房主可画（保持现状，没人在等的时候也能先涂鸦） |
| drawing | 房主可画 |
| **guessing** | **没人能改** |
| revealed | 没人能改 |

## 5. 协议变更（全部可选字段，不 bump 版本）

### 5.1 `S_RoomState` 加字段

```ts
maxPlayers?: number;
pendingPromotionId?: string;  // revealed 阶段的待升级猜对者
```

### 5.2 `S_PhaseChange` 加字段

```ts
pendingPromotionId?: string;  // 进入 revealed 时附带
```

### 5.3 `C_Transfer` 加字段

```ts
targetId?: string;  // 3+ 人模式必须；缺省时服务端按"非自己第一个"处理（兼容 2 人）
```

### 5.4 新增 `C_ClaimDrawer`

```ts
interface C_ClaimDrawer {
  type: "claimDrawer";
}
```

加入 `ClientMessage` 联合类型；`webSocketMessage` switch 加 `case "claimDrawer"`。

服务端 `onClaimDrawer`：
- 校验 `phase === "revealed"`
- 校验 sender.id `=== pendingPromotionId`
- 通过 → `await this.executeTransfer(sender.id)`（内部清 `pendingPromotionId`）

## 6. UI 改动

### 6.1 Home.tsx（创建房间）

昵称下方新增分段选择控件：

```
房间人数：[ 2人 ][ 3人 ][ 4人 ][ 5人 ][ 6人 ]
```

仅在"菜单"模式下显示（"加入房间"模式人数已由房主决定）。`useState<number>(2)` 默认 2。`handleCreate` fetch 加 `?max=${maxPlayers}`。

### 6.2 PlayerBar.tsx

#### 显示规则

| 玩家数 | 中段渲染 |
|--------|----------|
| 1 | `[房主]` + `等待玩家加入...` |
| 2 | `[房主] [玩家2]` |
| 3+ | `[房主] [P2] [+N ▼]` |

第二格"P2"= `joinOrder` 数组中第一个非 drawer 的玩家。

`+N ▼` 点击展开下拉气泡，列出剩余玩家：仅显示名字（不区分在线/离线灰态——见本节末"玩家在线/离线状态"）。

#### 转让画笔按钮

- 2 人房：保持现有"转让画笔"按钮，点击直接 `send({type:"transfer"})`
- 3+ 人房：按钮文案改为"转让画笔 ▼"，点击展开下方 popover，列出**所有非自己玩家**（前端无"在线"信号，包含可能断线但仍在 grace 中的）。点其中一个 → `send({type:"transfer", targetId})`，关闭 popover。若 target 已断线 → 服务端拒绝（`getJoinedWebSockets()` 校验未通过）→ 静默忽略；不弹 Toast 以免对正常情况产生噪声。更稳的做法是服务端发 error，但此优化留作 follow-up

popover 复用 Toolbar 的 outside-click 逻辑（`useEffect` 监听全局 mousedown，`closest("[data-transfer-popover]")` 判定）。

#### 分享房间按钮

显示条件：`players.length < maxPlayers`（满员隐藏）。

#### revealed 阶段（3+ 人）

- 隐藏 `继续出题` / `转让画笔` 按钮
- 顶栏中间显示提示："`{猜对者名}` 即将获得画笔（约 6 秒后…）"
- 实际"切 drawer"由猜对者本机倒计时触发（见 6.5）

#### 玩家在线/离线状态

**沿用现有 2 人模式行为**：断线（onDisconnect）服务端**不广播** `playerLeft`，PlayerBar 仍显示该玩家；只有 grace 期满（processActualLeave）才广播 `playerLeft`，前端才从 `players` 移除。

后果：玩家断线 30s 内（normal grace）或 5s 内（quickleave grace），下拉气泡里依然能看到他的名字。但**转让画笔时**只能转给在 `players` 数组里**且当前 ws 仍连着**的玩家——这一点服务端 `onTransfer` 用 `getJoinedWebSockets()` 校验已经覆盖。

**取舍**：不引入"在线/离线灰态"UI，PlayerBar 把断线玩家当作"还在"显示。简化优先，与现状一致。

### 6.3 Room.tsx（自动升级 claim 流程）

```
phaseChange (revealed, pendingPromotionId)
  ↓
所有人触发 Confetti
  ↓ 5 秒后（仅 myId === pendingPromotionId 的客户端）
  ↓
send({type: "claimDrawer"})
  ↓
服务端校验 + executeTransfer → broadcast transferDone + clear + phaseChange(drawing)
```

`useEffect` 监听 `[phase, pendingPromotionId, myId]`：
- 进入 `phase === "revealed" && pendingPromotionId === myId` 时启动 setTimeout
- 离开此条件（phase 变 / pendingPromotionId 变）时 clearTimeout
- 倒计时长度 `AUTO_PROMOTE_DELAY_MS = 6500` 抽常量（见 6.5）

### 6.4 ChatPanel.tsx

文案：

- 当前："设置答案后对方才能开始猜"
- 多人（`maxPlayers > 2 || players.length > 2`）："设置答案后其他玩家才能开始猜"

具体判断条件：实际玩家数（`players.length`）> 2 即用"其他玩家"，否则"对方"。这样 4 人房瞬间只有 2 人时也显示"对方"，更自然。

### 6.5 Confetti

- 不动 `Confetti.tsx` 内部参数（PIECE_COUNT=250, MAX_DELAY_MS=2000, DURATION_MAX_MS=4000）
- 彩带最晚一片落地约 2000+4000=6000ms。`AUTO_PROMOTE_DELAY_MS = 6500` 稍宽裕一点，让礼花完整结束后再切

## 7. 服务端改动

### 7.1 `index.ts` 创建房间

```ts
const max = parseInt(url.searchParams.get("max") || "2", 10);
const maxPlayers = (max >= 2 && max <= 6) ? max : 2;
// /init 调用时传过去
await stub.fetch(new Request("http://internal/init?code=" + roomCode + "&max=" + maxPlayers, { method: "POST" }));
```

### 7.2 `room.ts` 新字段持久化

```ts
private maxPlayers = 2;
private joinOrder: string[] = [];
private pendingPromotionId: string | null = null;  // 不持久化
```

`saveState()` 多写 `maxPlayers`、`joinOrder`（注意 `pendingPromotionId` **不写**）。`ensureLoaded()` 反序列化。

`getPlayerInfoList()` 改造：

```ts
private getPlayerInfoList(): PlayerInfo[] {
  return this.getJoinedWebSockets().map(({ player }) => ({
    id: player.id,
    name: player.name,
    isOwner: player.id === this.drawerId,  // 动态计算
  }));
}
```

老的 attachment 里如果还有遗留的 `isOwner` 字段（DO 升级时 ws 还连着的情况），ignore 即可，不会读到。

### 7.3 onJoin 改造

```ts
// 现在的 "if (this.getEffectivePlayerCount() >= 2)" 改成：
if (this.getEffectivePlayerCount() >= this.maxPlayers) { ... room full ... }

// 不再用 isOwner 判 "首人"；用 joinOrder.length === 0 判：
const isFirst = this.joinOrder.length === 0;
const player: PlayerAttachment = {
  id: crypto.randomUUID(),
  name: (playerName || `玩家${this.joinOrder.length + 1}`).slice(0, MAX_NAME_LENGTH),
};

if (isFirst) {
  this.drawerId = player.id;
  this.phase = "waiting";
} else if (this.joinOrder.length === 1) {
  // 第 2 人加入：和现在一样进 drawing
  this.closed = false;  // 多人房不再 lock
  this.phase = "drawing";
}
// 第 3 人及之后：phase 不变，已经是 drawing/guessing/revealed 之一

this.joinOrder.push(player.id);
```

⚠️ `closed` 字段在多人模式下意义减弱：以前 2 人就标 closed=true。多人模式改为永远 false（直到 maxPlayers 满，靠 `getEffectivePlayerCount` 拦），不再在 onJoin 里写 closed=true。

### 7.4 onGuess 改造

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
    ...(this.pendingPromotionId ? { pendingPromotionId: this.pendingPromotionId } : {}),
  });
}
```

### 7.5 onTransfer 改造

```ts
private async onTransfer(ws: WebSocket, msg: { targetId?: string }) {
  const player = this.getPlayer(ws);
  if (!player || player.id !== this.drawerId) return;

  let targetId = msg.targetId;
  if (!targetId) {
    // 兼容 2 人模式：转给非自己的第一个
    for (const { player: other } of this.getJoinedWebSockets()) {
      if (other.id !== player.id) { targetId = other.id; break; }
    }
  }
  if (!targetId) return;

  // 验证 targetId 是当前在线玩家
  const targetOnline = this.getJoinedWebSockets().some(({ player: p }) => p.id === targetId);
  if (!targetOnline) return;
  if (targetId === player.id) return;

  await this.executeTransfer(targetId);
}
```

### 7.6 新增 onClaimDrawer

```ts
private async onClaimDrawer(ws: WebSocket) {
  const player = this.getPlayer(ws);
  if (!player) return;
  if (this.phase !== "revealed") return;
  if (!this.pendingPromotionId || this.pendingPromotionId !== player.id) return;

  await this.executeTransfer(player.id);
  // executeTransfer 内部会清 pendingPromotionId（见 7.7）
}
```

### 7.7 executeTransfer / onContinueDrawing / onClear 等清理

每个改 phase 离开 revealed 的路径都加 `this.pendingPromotionId = null;`。

### 7.8 processActualLeave 改造

drawer 离开后选下一个 drawer 的逻辑用 `joinOrder` 排序：

```ts
if (dp.id === this.drawerId) {
  // 从 joinOrder 中找第一个仍在线/在 grace 的玩家
  for (const id of this.joinOrder) {
    if (id === dp.id) continue;
    if (this.isPlayerActive(id)) {
      this.drawerId = id;
      break;
    }
  }
}
```

`isPlayerActive(id)` = `getJoinedWebSockets().some(p => p.id === id) || this.disconnectedPlayers.has(id)`。

同时维护 `joinOrder = joinOrder.filter(id => id !== dp.id)`。

### 7.9 猜对者离开（避免房间僵死）

`processActualLeave` 顶部新增：

```ts
if (dp.id === this.pendingPromotionId) {
  this.pendingPromotionId = null;
  // phase 仍然是 revealed，但前端要重新显示 drawer 的"继续出题/转让画笔"按钮。
  // 简单做法：再发一次 phaseChange 让前端 reset pendingPromotionId 状态。
  this.broadcast({
    type: "phaseChange",
    phase: "revealed",
    drawerId: this.drawerId!,
    // 不带 pendingPromotionId 字段，前端把本地 state 清掉
  });
}
```

⚠️ 前端 `phaseChange` 处理需要识别"`pendingPromotionId` 字段缺省"和"字段为 null"——统一处理为"清空本地待升级状态"。

## 8. 边界情况

| # | 场景 | 处理 |
|---|------|------|
| 1 | 3+ 人，drawer 画到一半断线 | grace 期保留身份；过期则按 `joinOrder` 顺序换 drawer，画板清空进 drawing |
| 2 | 3+ 人，猜对者断线，未 claim | 倒计时随客户端消失；猜对者重连后**不会**自动启动倒计时（重连走 `roomState`，前端要在 `roomState` 中识别 `phase === "revealed" && pendingPromotionId === myId` 并启动倒计时）。如果 grace 过期未重连 → `processActualLeave` 检测到离开者 == `pendingPromotionId` 时，把它清空 + 显式给当前 drawer 推送 `phaseChange(revealed)`（不带 pendingPromotionId），让 drawer 看到 `继续出题/转让画笔` 按钮，避免房间僵死 |
| 3 | 自动升级 5 秒倒计时中，drawer 主动按"离开" | drawer 进 grace；猜对者 5s 后 claim → 服务端校验通过，executeTransfer 切到他 |
| 4 | 房间 maxPlayers=6 但当前只 2 人 | 完全沿用 2 人行为，仅 PlayerBar 显示和 ChatPanel 提示文案动态判断 |
| 5 | 旧客户端进入 maxPlayers=4 的房 | 旧客户端不读 maxPlayers，PlayerBar 仍展示 2 格；功能上无破坏（只是没法看到 P3+）。建议先部署服务端再前端，让用户刷新 |
| 6 | guessing 阶段 drawer 想反悔 | 不行（画板冻结）。无 "撤销 setAnswer" 入口；如未来需要再加 |
| 7 | 3+ 人房 drawer 没画就 setAnswer | 服务端不阻止；其他玩家会看到空画板。**默认不防呆** |
| 8 | drawer 主动 transfer 与自动升级竞争 | drawer 的 `transfer` 立即生效 + 清 pendingPromotionId；自动 claim 因 phase 变 drawing 被服务端拒 |
| 9 | DO 在 5 秒倒计时中 hibernate | `pendingPromotionId` 不持久化，唤醒后丢；猜对者发 claim 被拒；drawer 不变。**功能上等于"取消了一次升级"，可接受** |
| 10 | 6 人房广播量 | drawer 一个发，其他 5 人收 ≈ 300 msg/s 总量，远低于 rate limit per-ws |

## 9. 非目标

显式不做：

- 分数追踪 / 多轮历史
- 房间内昵称重命名
- 玩家踢人 / ban
- waiting 阶段画板冻结（保持房主可涂鸦）
- "撤销 setAnswer"
- "至少画一笔才能 setAnswer" 防呆

## 10. 实施顺序

每步独立可部署、可回滚：

1. **协议 / 类型 / 常量加字段**（无运行时影响）
2. **服务端 maxPlayers + joinOrder + onJoin 改造**（保 2 人模式行为不变）
3. **创建房间 UI**（人数选择控件 + 服务端读取 query）
4. **画板冻结**（服务端 8 处守卫 + 前端工具栏置灰）
5. **PlayerBar 多人显示**（"+N ▼" + 满员隐藏分享）
6. **transfer targetId + 多人转让下拉 UI**
7. **自动升级**（pendingPromotionId + claim 流程 + 倒计时 UI）
8. **ChatPanel 文案微调**

## 11. 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| 旧客户端进新房间 | 看不到 P3+ | 部署顺序：服务端先，前端后；线上窗口期建议提示用户刷新 |
| `pendingPromotionId` 不持久化 | hibernate 时丢失，自动升级失败 | 接受。fallback 是 drawer 不变 |
| 6 人房并发量 | 广播放大 | 评估为 300 msg/s 上限，远低于 rate limit |
| `joinOrder` 持久化写入频率 | 每次 join/leave 多一次 saveState | 频率低（人少且不频繁加入），可接受 |
| isOwner 字段语义改变 | 旧前端的 UI 着色变化 | 由于旧前端 isOwner 实际就是用来标 drawer，新动态计算后行为一致 |
