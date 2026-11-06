import {
  ACTIVITY_PERSIST_MIN_INTERVAL_MS,
  DELETE_BATCH_SIZE,
  INACTIVITY_TIMEOUT_MS,
  MAX_ANSWER_LENGTH,
  MAX_CHAT_HISTORY,
  MAX_CHAT_LENGTH,
  MAX_MAX_PLAYERS,
  MAX_NAME_LENGTH,
  MAX_ROOM_STROKE_COST,
  MAX_STROKE_PATH,
  MAX_STROKE_POINTS,
  MAX_UNJOINED_CONNECTIONS,
  MIN_MAX_PLAYERS,
  PLAYER_TOKEN_HEADER,
  PROTOCOL_VERSION,
  QUICK_LEAVE_GRACE_MS,
  QUICK_LEAVE_MARK_TTL_MS,
  RATE_LIMIT_BURST,
  RATE_LIMIT_PER_SECOND,
  RECONNECT_GRACE_MS,
  REDO_KEY_PREFIX,
  STROKE_KEY_PREFIX,
  UNJOINED_TIMEOUT_MS,
  UNKNOWN_PLAYER_NAME,
  WRITE_RATE_LIMIT_BURST,
  WRITE_RATE_LIMIT_PER_SECOND,
} from "./constants";
import { answerMatches, logFailure, pathLength, redoKey, strokeCost, strokeKey } from "./helpers";
import type {
  BrushType,
  ChatHistoryEntry,
  DisconnectedPlayer,
  GamePhase,
  PlayerAttachment,
  PlayerInfo,
  RosterEntry,
  SerializedStroke,
  UnjoinedAttachment,
} from "./types";
import { parseClientMessage, writesStorage } from "./validate";
import type {
  DrawMessage,
  FillMessage,
  JoinMessage,
  SelectionMessage,
  ShapeMessage,
  TextStrokeMessage,
} from "./validate";

type RateBuckets = WeakMap<WebSocket, { tokens: number; refilledAt: number }>;

// ============ GameRoom Durable Object ============

export class GameRoom implements DurableObject {
  // In-memory cache (restored from storage on wake)
  private loaded = false;
  private created = false;
  private drawerId: string | null = null;
  private phase: GamePhase = "waiting";
  private answer: string | null = null;
  private strokes: SerializedStroke[] = [];
  // Undone strokes, LIFO. Any new stroke invalidates this list. Persisted per
  // entry under REDO_KEY_PREFIX: the DO hibernates after ~10s idle, which would
  // otherwise make the drawer's redo silently diverge from everyone else.
  private redoStack: SerializedStroke[] = [];
  private chatHistory: ChatHistoryEntry[] = [];
  private roomCode = "";
  private disconnectedPlayers: Map<string, DisconnectedPlayer> = new Map();
  private lastActivityAt = 0;
  // touchActivity 节流：高频 draw 消息下避免每条都 storage.put + setAlarm。
  // 仅当距离上次持久化超过 ACTIVITY_PERSIST_MIN_INTERVAL_MS 时才同步到 storage。
  // 不需要持久化此字段——DO 重启后从 0 开始，下次 touchActivity 会立即同步。
  private lastActivityPersistedAt = 0;
  private maxPlayers = MIN_MAX_PLAYERS;
  private joinOrder: string[] = [];
  // joinOrder 里每个玩家的名字和 token，见 reconcilePlayers
  private roster = new Map<string, RosterEntry>();
  // 3+ 人房 revealed 阶段的猜对者，自动晋升前要等几秒，期间 DO 可能休眠，所以要持久化
  private pendingPromotionId: string | null = null;

  // Transient state (not persisted, OK to lose on hibernation)
  // 进行中的笔画缓存：给旧客户端的 end 回退用，也用来限制 move 的累计量。
  private currentStrokePoints: { x: number; y: number }[] = [];
  private currentStrokePath = 0;
  // 这一笔的 start 还在缓存里（休眠或断线后就没了，缓存只剩后半截）
  private currentStrokeStarted = false;
  // Pen 笔型缓存：start 时存下，move/end 透传到广播；end 写入持久化 stroke。
  private currentStrokeBrush: BrushType = "pen";
  // Per-ws token buckets for rate limiting. WeakMap ensures the entry is GC'd when
  // the ws is collected, and hibernation resets it naturally (back to a full bucket).
  private wsRateBuckets: RateBuckets = new WeakMap();
  private wsWriteBuckets: RateBuckets = new WeakMap();

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {
    // Heartbeats are answered by the runtime without waking the DO, so an idle
    // room doesn't reload its whole state every 25s. The request must match the
    // client's JSON.stringify({ type: "ping" }) exactly; `case "ping"` below is
    // only a fallback for messages that arrive in a different form.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  // ============ Restore state from storage after hibernation ============

  private async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    const data = await this.state.storage.get<unknown>([
      "created",
      "drawerId",
      "phase",
      "answer",
      "roomCode",
      "chatHistory",
      "disconnectedPlayers",
      "lastActivityAt",
      "maxPlayers",
      "joinOrder",
      "roster",
      "pendingPromotionId",
    ]);

    this.created = (data.get("created") as boolean) ?? false;
    this.drawerId = (data.get("drawerId") as string | null) ?? null;
    this.phase = (data.get("phase") as GamePhase) ?? "waiting";
    this.answer = (data.get("answer") as string | null) ?? null;
    this.roomCode = (data.get("roomCode") as string) ?? "";
    this.chatHistory = (data.get("chatHistory") as ChatHistoryEntry[]) ?? [];

    // Strokes live in per-key entries under STROKE_KEY_PREFIX; list() returns
    // them lexicographically sorted, which matches zero-padded insertion order.
    const strokeList = await this.state.storage.list<SerializedStroke>({
      prefix: STROKE_KEY_PREFIX,
    });
    this.strokes = Array.from(strokeList.values());

    const redoList = await this.state.storage.list<SerializedStroke>({
      prefix: REDO_KEY_PREFIX,
    });
    this.redoStack = Array.from(redoList.values());

    const dcRaw = data.get("disconnectedPlayers") as [string, DisconnectedPlayer][] | null;
    this.disconnectedPlayers = dcRaw
      ? new Map(dcRaw.map(([id, dp]) => [id, { ...dp, graceMs: dp.graceMs ?? RECONNECT_GRACE_MS }]))
      : new Map();
    this.lastActivityAt = (data.get("lastActivityAt") as number) ?? 0;
    this.maxPlayers = (data.get("maxPlayers") as number) ?? MIN_MAX_PLAYERS;
    this.joinOrder = (data.get("joinOrder") as string[]) ?? [];
    // Backfill: 旧房间无 joinOrder 字段时，至少把当前 drawer 放进去，避免下一位被误判为 isFirst
    if (this.joinOrder.length === 0 && this.drawerId) {
      this.joinOrder = [this.drawerId];
    }
    this.roster = new Map((data.get("roster") as [string, RosterEntry][] | undefined) ?? []);
    this.pendingPromotionId = (data.get("pendingPromotionId") as string | null) ?? null;

    await this.reconcilePlayers();
  }

  /**
   * 实例崩溃或强制更新时，连接消失了但 close 事件没有运行：玩家还在 joinOrder 里，却既没有
   * 连接，也不在保留期。不处理的话他们回来只能当新玩家，留在 drawerId 里的旧 id 变成幽灵，
   * 房间再也动不了。这里把他们转入保留期，和普通断线走同一条路。
   */
  private async reconcilePlayers() {
    const online = new Map(this.getJoinedWebSockets().map(({ player }) => [player.id, player]));
    let changed = false;
    for (const id of this.joinOrder) {
      const player = online.get(id);
      if (player) {
        // 这个字段上线前就在线的玩家：名册里没有，趁现在补上
        if (!this.roster.has(id)) {
          this.roster.set(id, {
            name: player.name,
            ...(player.token ? { token: player.token } : {}),
          });
          changed = true;
        }
        continue;
      }
      if (this.disconnectedPlayers.has(id)) {
        continue;
      }
      const known = this.roster.get(id);
      this.disconnectedPlayers.set(id, {
        id,
        // 名册字段上线前的房间可能查不到名字：先留空，重连时用他带来的昵称
        name: known?.name ?? "",
        ...(known?.token ? { token: known.token } : {}),
        disconnectedAt: Date.now(),
        graceMs: RECONNECT_GRACE_MS,
      });
      changed = true;
    }
    if (changed) {
      await this.saveState();
      this.scheduleNextAlarm();
      this.broadcastPlayerList();
    }
  }

  /** Token-bucket rate check. Returns false when the bucket is exhausted. */
  private takeToken(
    buckets: RateBuckets,
    ws: WebSocket,
    perSecond: number,
    burst: number,
  ): boolean {
    const now = Date.now();
    const bucket = buckets.get(ws) ?? { tokens: burst, refilledAt: now };
    const refill = ((now - bucket.refilledAt) / 1000) * perSecond;
    bucket.tokens = Math.min(burst, bucket.tokens + refill) - 1;
    bucket.refilledAt = now;
    buckets.set(ws, bucket);
    return bucket.tokens >= 0;
  }

  private closeForRateLimit(ws: WebSocket) {
    this.send(ws, { type: "error", message: "消息频率过高，连接已断开" });
    try {
      ws.close(1008, "rate limited");
    } catch {
      /* ignore */
    }
  }

  /** Storage caps batch deletes at DELETE_BATCH_SIZE keys per call. */
  private async deleteKeys(keys: string[]) {
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      await this.state.storage.delete(keys.slice(i, i + DELETE_BATCH_SIZE));
    }
  }

  /** Delete every per-stroke entry from storage. Safe at any point. */
  private async clearStrokeStorage() {
    const list = await this.state.storage.list({ prefix: STROKE_KEY_PREFIX });
    await this.deleteKeys(Array.from(list.keys()));
  }

  /**
   * Drop redo history, in memory and in storage. An empty stack costs no write,
   * which is the common case: every finished stroke passes through here.
   */
  private async clearRedoStack() {
    const count = this.redoStack.length;
    if (count === 0) {
      return;
    }
    this.redoStack = [];
    await this.deleteKeys(Array.from({ length: count }, (_, i) => redoKey(i)));
  }

  /**
   * Append a finished stroke and invalidate redo history. Both writes are issued
   * before the first await, so storage commits them as one atomic batch.
   *
   * 房间超出笔画预算时拒收并返回 false，调用方不要广播。全部笔画都常驻内存，每次唤醒和每个
   * 新人都要全量处理，所以总量要有上限。正常一局到不了（见 MAX_ROOM_STROKE_COST）。
   * redoStack 不算：新笔画会把它清空。
   */
  private async commitStroke(ws: WebSocket, stroke: SerializedStroke): Promise<boolean> {
    const used = this.strokes.reduce((sum, s) => sum + strokeCost(s), 0);
    if (used + strokeCost(stroke) > MAX_ROOM_STROKE_COST) {
      this.send(ws, { type: "error", message: "画板内容太多了，清除后才能继续画" });
      return false;
    }
    this.strokes.push(stroke);
    await Promise.all([
      this.state.storage.put(strokeKey(this.strokes.length - 1), stroke),
      this.clearRedoStack(),
    ]);
    return true;
  }

  private resetCurrentStroke() {
    this.currentStrokePoints = [];
    this.currentStrokePath = 0;
    this.currentStrokeStarted = false;
  }

  /** 累积 move 的点。超过单笔上限时返回 false，这一批既不累积也不转发。 */
  private extendCurrentStroke(points: { x: number; y: number }[]): boolean {
    const last = this.currentStrokePoints[this.currentStrokePoints.length - 1];
    const path = this.currentStrokePath + pathLength(last ? [last, ...points] : points);
    if (
      this.currentStrokePoints.length + points.length > MAX_STROKE_POINTS ||
      path > MAX_STROKE_PATH
    ) {
      return false;
    }
    for (const point of points) {
      this.currentStrokePoints.push(point);
    }
    this.currentStrokePath = path;
    return true;
  }

  /**
   * Destroy the room: memory, storage and alarm (deleteAll() removes the alarm too
   * since compatibility date 2026-02-24). /init can reuse the DO afterwards.
   */
  private async resetRoom() {
    this.created = false;
    this.phase = "waiting";
    this.drawerId = null;
    this.answer = null;
    this.strokes = [];
    this.redoStack = [];
    this.chatHistory = [];
    this.roomCode = "";
    this.disconnectedPlayers.clear();
    this.lastActivityAt = 0;
    this.lastActivityPersistedAt = 0;
    this.maxPlayers = MIN_MAX_PLAYERS;
    this.joinOrder = [];
    this.roster.clear();
    this.pendingPromotionId = null;
    this.resetCurrentStroke();
    // 房间没了，还没 join 的连接也没有留着的必要
    for (const { ws } of this.getUnjoinedWebSockets()) {
      this.closeUnjoined(ws, 1000, "room not found");
    }
    await this.state.storage.deleteAll();
  }

  private async saveState() {
    // Note: strokes are NOT saved here — each stroke lives in its own key under
    // STROKE_KEY_PREFIX, managed by onDraw / onTextStroke / clearStrokeStorage.
    await this.state.storage.put({
      created: this.created,
      drawerId: this.drawerId,
      phase: this.phase,
      answer: this.answer,
      roomCode: this.roomCode,
      chatHistory: this.chatHistory,
      disconnectedPlayers: Array.from(this.disconnectedPlayers.entries()),
      lastActivityAt: this.lastActivityAt,
      maxPlayers: this.maxPlayers,
      joinOrder: this.joinOrder,
      roster: Array.from(this.roster.entries()),
      pendingPromotionId: this.pendingPromotionId,
    });
  }

  /** Update last activity timestamp and schedule inactivity alarm */
  private async touchActivity() {
    const now = Date.now();
    this.lastActivityAt = now;

    // 节流：内存值每次都更新，但 storage.put + setAlarm 是高代价操作，限频。
    // 高频 draw 60Hz 下，原本每秒 60 次 storage 写 → 改为每 30s 一次。
    // inactivity 阈值是 10 分钟，±30s 误差完全可忽略。
    if (now - this.lastActivityPersistedAt < ACTIVITY_PERSIST_MIN_INTERVAL_MS) {
      return;
    }
    this.lastActivityPersistedAt = now;
    await this.state.storage.put("lastActivityAt", this.lastActivityAt);
    this.scheduleNextAlarm();
  }

  /** Schedule the earliest needed alarm (reconnect grace or inactivity timeout) */
  private scheduleNextAlarm() {
    const candidates: number[] = [];

    // Reconnect grace deadlines
    for (const dp of this.disconnectedPlayers.values()) {
      candidates.push(dp.disconnectedAt + dp.graceMs);
    }

    // Inactivity timeout. Applies to every live room, including one nobody has
    // joined yet: it would otherwise hold its room code forever.
    if (this.created && this.lastActivityAt > 0) {
      candidates.push(this.lastActivityAt + INACTIVITY_TIMEOUT_MS);
    }

    // Connections that never sent join
    const oldestUnjoined = this.getUnjoinedWebSockets()[0];
    if (oldestUnjoined) {
      candidates.push(oldestUnjoined.since + UNJOINED_TIMEOUT_MS);
    }

    if (candidates.length > 0) {
      this.state.storage.setAlarm(Math.min(...candidates));
    }
  }

  /** Total player count including those in reconnection grace period */
  private getEffectivePlayerCount(): number {
    return this.getJoinedCount() + this.disconnectedPlayers.size;
  }

  // ============ Player helpers using WebSocket attachments ============

  private getPlayer(ws: WebSocket): PlayerAttachment | null {
    const attachment = ws.deserializeAttachment() as PlayerAttachment | UnjoinedAttachment | null;
    return attachment && "id" in attachment ? attachment : null;
  }

  /** 连上了但还没发 join 的连接，最旧的在前。 */
  private getUnjoinedWebSockets(): { ws: WebSocket; since: number }[] {
    const result: { ws: WebSocket; since: number }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as PlayerAttachment | UnjoinedAttachment | null;
      if (attachment && "unjoinedSince" in attachment) {
        result.push({ ws, since: attachment.unjoinedSince });
      }
    }
    return result.sort((a, b) => a.since - b.since);
  }

  private closeUnjoined(ws: WebSocket, code: number, reason: string) {
    try {
      ws.serializeAttachment(null);
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  /** 关掉超时的未加入连接；数量超限时从最旧的开始关，新连接总能留下。 */
  private sweepUnjoined() {
    const unjoined = this.getUnjoinedWebSockets();
    const overflow = unjoined.length - MAX_UNJOINED_CONNECTIONS;
    const now = Date.now();
    unjoined.forEach(({ ws, since }, i) => {
      if (i < overflow || now - since >= UNJOINED_TIMEOUT_MS) {
        this.closeUnjoined(ws, 1008, "join timeout");
      }
    });
  }

  private getJoinedWebSockets(): { ws: WebSocket; player: PlayerAttachment }[] {
    const result: { ws: WebSocket; player: PlayerAttachment }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const player = this.getPlayer(ws);
      if (player) {
        result.push({ ws, player });
      }
    }
    return result;
  }

  private getJoinedCount(): number {
    return this.getJoinedWebSockets().length;
  }

  private getPlayerInfoList(): PlayerInfo[] {
    const joined = new Map(this.getJoinedWebSockets().map(({ player }) => [player.id, player]));
    const result: PlayerInfo[] = [];
    for (const id of this.joinOrder) {
      // 保留期内的玩家仍在房间里：列出来并标记离线，否则先重连的人永远看不到后回来的人
      const player = joined.get(id) ?? this.disconnectedPlayers.get(id);
      if (player) {
        result.push({
          id: player.id,
          name: player.name || UNKNOWN_PLAYER_NAME,
          isOwner: player.id === this.drawerId,
          connected: joined.has(id),
        });
      }
    }
    return result;
  }

  private canMutateCanvas(): boolean {
    return this.phase === "drawing" || this.phase === "waiting";
  }

  /**
   * waiting ⇄ drawing 的唯一判定。保留期内的玩家算在人数里，网络抖动不会结束这一局。
   * 只改内存并返回 phase 是否变化，持久化和广播由调用方负责。
   */
  private recomputePhase(): boolean {
    if (this.getEffectivePlayerCount() < 2) {
      if (this.phase === "waiting") {
        return false;
      }
      this.phase = "waiting";
      this.answer = null;
      this.pendingPromotionId = null;
      return true;
    }
    if (this.phase === "waiting") {
      this.phase = "drawing";
      return true;
    }
    return false;
  }

  // ============ HTTP fetch handler ============

  fetch(request: Request): Promise<Response> {
    return logFailure("GameRoom.fetch", () => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    // Internal: POST /init - mark room as created
    // Returns 409 if already created, so the parent Worker can retry with a new code.
    if (url.pathname === "/init" && request.method === "POST") {
      if (this.created) {
        // 没人、又已过闲置期的房间是漏掉的孤儿：早期 /init 不设 alarm，这种房间不会
        // 自己醒来，只能在这里回收，否则房间号永久被占。
        const leaked =
          this.getEffectivePlayerCount() === 0 &&
          Date.now() - this.lastActivityAt >= INACTIVITY_TIMEOUT_MS;
        if (!leaked) {
          return new Response(JSON.stringify({ error: "already created" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        await this.resetRoom();
      }
      const code = url.searchParams.get("code") || "";
      const maxRaw = parseInt(url.searchParams.get("max") || "2", 10);
      const maxPlayers =
        Number.isFinite(maxRaw) && maxRaw >= MIN_MAX_PLAYERS && maxRaw <= MAX_MAX_PLAYERS
          ? maxRaw
          : MIN_MAX_PLAYERS;
      const now = Date.now();
      this.created = true;
      this.roomCode = code;
      this.maxPlayers = maxPlayers;
      this.lastActivityAt = now;
      this.lastActivityPersistedAt = now;
      await this.state.storage.put({
        created: true,
        roomCode: code,
        maxPlayers,
        lastActivityAt: now,
      });
      // 建了房却没人加入也要能回收
      this.scheduleNextAlarm();
      return new Response("OK");
    }

    // POST /quickleave — beacon from pagehide, shorten grace period
    if (url.pathname.endsWith("/quickleave") && request.method === "POST") {
      const playerId = url.searchParams.get("playerId");
      if (!playerId) {
        return new Response("Missing playerId", { status: 400 });
      }
      // 只有本人能缩短自己的保留期。凭证不对时和“查无此人”一样直接返回。
      const token = request.headers.get(PLAYER_TOKEN_HEADER) || undefined;

      // Case 1: Player still connected (beacon arrived before WS close) — mark for short grace
      for (const { ws, player } of this.getJoinedWebSockets()) {
        if (player.id === playerId) {
          if (this.ownsIdentity(player, playerId, token)) {
            ws.serializeAttachment({ ...player, quickLeaveAt: Date.now() });
          }
          return new Response("OK");
        }
      }

      // Case 2: Already disconnected (WS closed before beacon) — shorten grace
      const dp = this.disconnectedPlayers.get(playerId);
      if (dp && this.ownsIdentity(dp, playerId, token)) {
        dp.disconnectedAt = Date.now();
        dp.graceMs = QUICK_LEAVE_GRACE_MS;
        await this.saveState();
        this.scheduleNextAlarm();
      }

      return new Response("OK");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    // WebSocket upgrade — always accept; capacity is validated in onJoin
    // which can send a proper error message the client can display.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept WebSocket for hibernation; attachment will be set on "join"
    this.state.acceptWebSocket(server);

    // 房间不存在也要先接受再关：升级时直接拒绝的话，前端读不到错误消息和 close reason
    if (!this.created) {
      this.rejectJoin(server, "房间不存在", "room not found");
      return new Response(null, { status: 101, webSocket: client });
    }

    const unjoined: UnjoinedAttachment = { unjoinedSince: Date.now() };
    server.serializeAttachment(unjoined);
    this.sweepUnjoined();
    this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ============ Hibernatable WebSocket API handlers ============

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return logFailure("webSocketMessage", () => this.handleMessage(ws, message));
  }

  private async handleMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.ensureLoaded();

    // 服务端已经关掉这条连接（接管、拒绝、超时）：close 帧还在路上时到达的消息一律不算数，
    // 否则迟到的 join 会占座，甚至接管本人的新连接。新连接从接受起就有 attachment，见 fetch。
    if (ws.deserializeAttachment() === null) {
      return;
    }

    if (!this.takeToken(this.wsRateBuckets, ws, RATE_LIMIT_PER_SECOND, RATE_LIMIT_BURST)) {
      this.closeForRateLimit(ws);
      return;
    }

    // 入口统一校验：之后的 handler 拿到的都是类型和范围合法的消息
    const msg = typeof message === "string" ? parseClientMessage(message) : null;

    // 加入之前只能发 join 和心跳。合法客户端不会这样，不留着这条连接。
    if (!this.getPlayer(ws) && msg?.type !== "join" && msg?.type !== "ping") {
      this.closeUnjoined(ws, 1008, "join required");
      return;
    }
    if (!msg) {
      return;
    }

    if (
      writesStorage(msg) &&
      !this.takeToken(this.wsWriteBuckets, ws, WRITE_RATE_LIMIT_PER_SECOND, WRITE_RATE_LIMIT_BURST)
    ) {
      this.closeForRateLimit(ws);
      return;
    }

    // Update activity on any joined player's message (except join and ping
    // heartbeat). Ping would otherwise reset the inactivity timer and defeat
    // auto-close; so would a connection that never joined.
    if (msg.type !== "join" && msg.type !== "ping") {
      await this.touchActivity();
    }

    switch (msg.type) {
      case "join":
        await this.onJoin(ws, msg);
        break;
      case "ping":
        this.send(ws, { type: "pong" });
        break;
      case "draw":
        await this.onDraw(ws, msg);
        break;
      case "clear":
        await this.onClear(ws);
        break;
      case "undo":
        await this.onUndo(ws);
        break;
      case "redo":
        await this.onRedo(ws);
        break;
      case "setAnswer":
        await this.onSetAnswer(ws, msg.answer);
        break;
      case "guess":
        await this.onGuess(ws, msg.text);
        break;
      case "chat":
        await this.onChat(ws, msg.text);
        break;
      case "transfer":
        await this.onTransfer(ws, msg.targetId);
        break;
      case "textStroke":
        await this.onTextStroke(ws, msg);
        break;
      case "shape":
        await this.onShape(ws, msg);
        break;
      case "fill":
        await this.onFill(ws, msg);
        break;
      case "selection":
        await this.onSelection(ws, msg);
        break;
      case "deleteStrokes":
        await this.onDeleteStrokes(ws, msg.indices);
        break;
      case "claimDrawer":
        await this.onClaimDrawer(ws);
        break;
      case "continueDrawing":
        await this.onContinueDrawing(ws);
        break;
      case "leave":
        await this.onLeave(ws);
        break;
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    return logFailure("webSocketClose", async () => {
      // 回一个 close 帧完成握手，不回的话对端要等 10 秒才算关闭。1005 / 1006 不能写进 close 帧。
      try {
        ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
      } catch {
        /* already closed */
      }
      await this.ensureLoaded();
      await this.onDisconnect(ws);
    });
  }

  webSocketError(ws: WebSocket) {
    return logFailure("webSocketError", async () => {
      await this.ensureLoaded();
      await this.onDisconnect(ws);
    });
  }

  alarm() {
    return logFailure("alarm", () => this.handleAlarm());
  }

  private async handleAlarm() {
    await this.ensureLoaded();

    const now = Date.now();

    this.sweepUnjoined();

    // --- 1. Process expired disconnected players ---
    const expired: DisconnectedPlayer[] = [];
    for (const [id, dp] of this.disconnectedPlayers) {
      if (now - dp.disconnectedAt >= dp.graceMs) {
        expired.push(dp);
        this.disconnectedPlayers.delete(id);
      }
    }
    for (const dp of expired) {
      await this.processActualLeave(dp);
    }

    // --- 2. Check inactivity timeout ---
    if (
      this.created &&
      this.lastActivityAt > 0 &&
      now - this.lastActivityAt >= INACTIVITY_TIMEOUT_MS
    ) {
      // Notify all connected players (if any) and destroy the room
      this.broadcast({
        type: "roomClosed",
        reason: "房间超过10分钟无活动，已自动关闭",
      });

      // Close all WebSockets
      for (const { ws } of this.getJoinedWebSockets()) {
        ws.serializeAttachment(null);
        try {
          ws.close(1000, "inactivity");
        } catch {
          /* ignore */
        }
      }

      await this.resetRoom();
      return;
    }

    // --- 3. Schedule next alarm if needed ---
    this.scheduleNextAlarm();
  }

  // ============ Message Handlers ============

  private async onJoin(ws: WebSocket, msg: JoinMessage) {
    const { playerName, playerId, v: clientVersion } = msg;

    // 同一条连接只能加入一次。否则第二次 join 会拿到新身份，旧身份变成没有连接的幽灵。
    if (this.getPlayer(ws)) {
      return;
    }

    // Protocol version check. `clientVersion == null` is a legacy-client grace
    // (see PROTOCOL_VERSION comment) — remove the null branch once pre-v1
    // clients are no longer expected in the wild.
    if (clientVersion != null && clientVersion !== PROTOCOL_VERSION) {
      this.rejectJoin(ws, "客户端版本过旧，请刷新页面", "version mismatch");
      return;
    }

    // Reject joins to non-existent rooms
    if (!this.created) {
      this.rejectJoin(ws, "房间不存在", "room not found");
      return;
    }

    // 凭证校验不通过的统一当新玩家：不提示原因，也不影响身份的真正主人。
    // Check disconnectedPlayers first (normal reconnection after close was processed)
    for (const disconnected of this.disconnectedPlayers.values()) {
      if (this.ownsIdentity(disconnected, playerId, msg.playerToken)) {
        // ---- Reconnection from disconnectedPlayers ----
        this.disconnectedPlayers.delete(disconnected.id);

        const player = this.reclaimIdentity(disconnected, msg);
        ws.serializeAttachment(player);
        await this.finishRejoin(ws, player);
        return;
      }
    }

    // Check active WebSockets — the old connection may not have closed yet (race condition)
    for (const { ws: oldWs, player: existing } of this.getJoinedWebSockets()) {
      if (this.ownsIdentity(existing, playerId, msg.playerToken)) {
        // Take over: close old WS, reuse identity on new WS
        oldWs.serializeAttachment(null);
        try {
          oldWs.close(1000, "reconnected");
        } catch {
          /* already closed */
        }

        const player = this.reclaimIdentity(existing, msg);
        ws.serializeAttachment(player);
        await this.finishRejoin(ws, player);
        return;
      }
    }

    // ---- New player join ----
    if (this.getEffectivePlayerCount() >= this.maxPlayers) {
      this.rejectJoin(ws, "房间已满", "room full");
      return;
    }

    // 放在满员检查之后：被拒绝的 join 不算活动，否则不断尝试加入就能让闲置房间永不回收
    await this.touchActivity();

    const isFirst = this.joinOrder.length === 0;
    const player: PlayerAttachment = {
      id: crypto.randomUUID(),
      name: (playerName || `玩家${this.joinOrder.length + 1}`).slice(0, MAX_NAME_LENGTH),
      ...(msg.playerToken ? { token: msg.playerToken } : {}),
    };

    // Store player info as WebSocket attachment (survives hibernation)
    ws.serializeAttachment(player);
    this.joinOrder.push(player.id);
    this.rememberPlayer(player);

    if (isFirst) {
      this.drawerId = player.id;
    }
    const phaseChanged = this.recomputePhase();

    await this.saveState();

    // Send full state to the joining player
    this.sendRoomState(ws, player);

    // Notify other players about the new join
    this.broadcast(
      {
        type: "playerJoined",
        player: {
          id: player.id,
          name: player.name,
          isOwner: player.id === this.drawerId,
          connected: true,
        },
      },
      ws,
    );

    // Only when the phase really moved; the joining player has it via roomState.
    if (phaseChanged) {
      this.broadcast({ type: "phaseChange", phase: this.phase, drawerId: this.drawerId! }, ws);
    }

    this.scheduleNextAlarm();
  }

  /** 更新名册。只改内存，调用方负责 saveState。 */
  private rememberPlayer(player: PlayerAttachment) {
    this.roster.set(player.id, {
      name: player.name,
      ...(player.token ? { token: player.token } : {}),
    });
  }

  /** 拒绝加入：先发错误消息（前端靠它显示原因），再带着客户端认识的 reason 关闭。 */
  private rejectJoin(ws: WebSocket, message: string, reason: string) {
    this.send(ws, { type: "error", message });
    this.closeUnjoined(ws, 1000, reason);
  }

  /**
   * 这个请求是不是身份的主人。id 是公开的，只有 token 能证明是本人。token 由客户端生成，
   * 只有它自己知道，能直接定位身份：roomState 没送到就断线时，客户端还不知道自己的 id。
   *
   * 过渡期：旧客户端（不认识 token 的 JS）的身份没有 token，只能凭 id，开着的旧标签页还要能
   * 重连。线上不再有旧客户端后，去掉 stored.id === playerId 这个分支。
   */
  private ownsIdentity(
    stored: { id: string; token?: string },
    playerId?: string,
    token?: string,
  ): boolean {
    return stored.token !== undefined ? stored.token === token : stored.id === playerId;
  }

  /** 取回身份后的 attachment。旧身份遇到认识 token 的客户端（刷新拿到了新 JS）时记下它的 token。 */
  private reclaimIdentity(
    stored: { id: string; name: string; token?: string },
    msg: JoinMessage,
  ): PlayerAttachment {
    const token = stored.token ?? msg.playerToken;
    return {
      id: stored.id,
      // 名册里没有的玩家（见 reconcilePlayers）名字是空的，用他这次带来的
      name: stored.name || msg.playerName.slice(0, MAX_NAME_LENGTH) || UNKNOWN_PLAYER_NAME,
      ...(token ? { token } : {}),
    };
  }

  /** Shared tail of both rejoin paths (back from grace, or taking over a live connection). */
  private async finishRejoin(ws: WebSocket, player: PlayerAttachment) {
    await this.touchActivity();
    this.rememberPlayer(player); // 可能刚记下 token 或真实昵称

    const phaseChanged = this.recomputePhase();

    await this.saveState();

    this.sendRoomState(ws, player);
    this.broadcastPlayerList(ws);
    if (phaseChanged) {
      this.broadcast({ type: "phaseChange", phase: this.phase, drawerId: this.drawerId! }, ws);
    }

    this.scheduleNextAlarm();
  }

  private sendRoomState(ws: WebSocket, player: PlayerAttachment) {
    this.send(ws, {
      type: "roomState",
      roomCode: this.roomCode,
      players: this.getPlayerInfoList(),
      drawerId: this.drawerId,
      phase: this.phase,
      strokes: this.strokes,
      ...(this.redoStack.length > 0 ? { redoStack: this.redoStack } : {}),
      chatHistory: this.chatHistory,
      yourId: player.id,
      maxPlayers: this.maxPlayers,
      ...(this.pendingPromotionId ? { pendingPromotionId: this.pendingPromotionId } : {}),
      ...(player.id === this.drawerId && this.answer
        ? { answer: this.answer, answerLength: this.answer.length }
        : this.answer
          ? { answerLength: this.answer.length }
          : {}),
    });
  }

  /**
   * Full roster, sent when someone drops or comes back. A new message type rather
   * than playerJoined: that one is incremental, and old clients would add a duplicate.
   */
  private broadcastPlayerList(exclude?: WebSocket) {
    this.broadcast({ type: "playerList", players: this.getPlayerInfoList() }, exclude);
  }

  private async onDraw(ws: WebSocket, msg: DrawMessage) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    // 要告诉对端的整笔，只有内容完整时才有
    let authoritative: SerializedStroke | null = null;

    // Track stroke for replay
    if (msg.action === "start") {
      this.currentStrokePoints = [{ x: msg.x, y: msg.y }];
      this.currentStrokePath = 0;
      this.currentStrokeStarted = true;
      // brushType 只在 start 上发；缺值视作 "pen"（兼容旧客户端）
      this.currentStrokeBrush = msg.brushType ?? "pen";
    } else if (msg.action === "move") {
      // 'move' may carry a batch of points (RAF-throttled) or a single x/y.
      if (!this.extendCurrentStroke(msg.points ?? [{ x: msg.x, y: msg.y }])) {
        return;
      }
    } else if (msg.action === "end") {
      // end 带整笔时以它为准：缓存在内存里，DO 休眠就没了，断线时 start 也可能发不出去。
      // 旧客户端不带，只能用缓存。缓存丢过 start 时内容不完整（颜色和线宽 end 上有，点只剩后半截），
      // 这时不告诉对端：它们累积的点是全的，别用残缺的覆盖掉。
      const finished: SerializedStroke = msg.stroke ?? {
        points: [...this.currentStrokePoints, { x: msg.x, y: msg.y }],
        color: msg.color,
        lineWidth: msg.lineWidth,
        // 默认 pen 不写字段（保持 wire 紧凑、和老 stroke 一致）
        ...(this.currentStrokeBrush !== "pen" ? { brushType: this.currentStrokeBrush } : {}),
      };
      const complete = msg.stroke !== undefined || this.currentStrokeStarted;
      this.resetCurrentStroke();
      // Persist only the new stroke (not the whole list) to stay under value limits.
      if (!(await this.commitStroke(ws, finished))) {
        return;
      }
      authoritative = complete ? finished : null;
    }

    // Forward to the other player — preserve points batch + brushType when present.
    // brushType 在每一帧都透传给对端，免得对端要缓存 start 时的笔型。
    // end 带上存下的整笔：对端以它为准，中途加入或漏了 start 也能补全，各端数组不会错位。
    this.broadcast(
      {
        type: "draw",
        action: msg.action,
        x: msg.x,
        y: msg.y,
        color: msg.color,
        lineWidth: msg.lineWidth,
        ...(this.currentStrokeBrush !== "pen" ? { brushType: this.currentStrokeBrush } : {}),
        ...(msg.points ? { points: msg.points } : {}),
        ...(authoritative ? { stroke: authoritative } : {}),
      },
      ws,
    );
  }

  private async onTextStroke(ws: WebSocket, msg: TextStrokeMessage) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    const { text, colorRanges } = msg;
    const stroke: SerializedStroke = {
      points: [{ x: msg.x, y: msg.y }],
      color: msg.color,
      lineWidth: 0,
      text,
      fontSize: msg.fontSize,
    };
    if (colorRanges) {
      stroke.colorRanges = colorRanges;
    }
    if (!(await this.commitStroke(ws, stroke))) {
      return;
    }

    this.broadcast(
      {
        type: "textStroke",
        text,
        x: msg.x,
        y: msg.y,
        color: msg.color,
        fontSize: msg.fontSize,
        colorRanges,
      },
      ws,
    );
  }

  private async onShape(ws: WebSocket, msg: ShapeMessage) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    const stroke: SerializedStroke = {
      points: [
        { x: msg.x, y: msg.y },
        { x: msg.x + msg.width, y: msg.y + msg.height },
      ],
      color: msg.color,
      lineWidth: msg.lineWidth,
      shape: msg.shape,
      filled: msg.filled,
    };
    if (!(await this.commitStroke(ws, stroke))) {
      return;
    }

    this.broadcast(
      {
        type: "shape",
        shape: msg.shape,
        filled: msg.filled,
        x: msg.x,
        y: msg.y,
        width: msg.width,
        height: msg.height,
        color: msg.color,
        lineWidth: msg.lineWidth,
      },
      ws,
    );
  }

  private async onFill(ws: WebSocket, msg: FillMessage) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    const stroke: SerializedStroke = {
      points: [{ x: msg.x, y: msg.y }],
      color: msg.color,
      lineWidth: 0,
      fill: { tolerance: msg.tolerance },
    };
    if (!(await this.commitStroke(ws, stroke))) {
      return;
    }

    this.broadcast(
      {
        type: "fill",
        x: msg.x,
        y: msg.y,
        color: msg.color,
        tolerance: msg.tolerance,
      },
      ws,
    );
  }

  private async onSelection(ws: WebSocket, msg: SelectionMessage) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    const stroke: SerializedStroke = {
      points: [],
      color: "",
      lineWidth: 0,
      selection: {
        srcX: msg.srcX,
        srcY: msg.srcY,
        w: msg.w,
        h: msg.h,
        dstX: msg.dstX,
        dstY: msg.dstY,
      },
    };
    if (!(await this.commitStroke(ws, stroke))) {
      return;
    }

    this.broadcast(
      {
        type: "selection",
        srcX: msg.srcX,
        srcY: msg.srcY,
        w: msg.w,
        h: msg.h,
        dstX: msg.dstX,
        dstY: msg.dstY,
      },
      ws,
    );
  }

  /**
   * 选择删除：按索引删除若干笔画（含客户端算好的级联依赖填充）。
   * indices 约定降序排列，依次 splice 不会移位。
   */
  private async onDeleteStrokes(ws: WebSocket, raw: number[]) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }
    // 校验：范围内、无重复。任何一项不合法则整条丢弃（保守失败，
    // 不做部分应用 —— 部分应用会造成两端 strokes 数组错位）。
    const seen = new Set<number>();
    for (const i of raw) {
      if (i < 0 || i >= this.strokes.length || seen.has(i)) {
        return;
      }
      seen.add(i);
    }
    const indices = [...raw].sort((a, b) => b - a);
    const oldLength = this.strokes.length;
    for (const i of indices) {
      this.strokes.splice(i, 1);
    }
    await this.clearRedoStack();

    // 分片存储重排：删除让 minIdx 之后的条目整体左移 —— 重写受影响区间，
    // 再删除尾部残留的旧 key。put / delete 都按 DELETE_BATCH_SIZE 分批。
    const minIdx = indices[indices.length - 1];
    let batch: Record<string, SerializedStroke> = {};
    let batchCount = 0;
    for (let i = minIdx; i < this.strokes.length; i++) {
      batch[strokeKey(i)] = this.strokes[i];
      batchCount++;
      if (batchCount >= DELETE_BATCH_SIZE) {
        await this.state.storage.put(batch);
        batch = {};
        batchCount = 0;
      }
    }
    if (batchCount > 0) {
      await this.state.storage.put(batch);
    }
    const staleKeys: string[] = [];
    for (let i = this.strokes.length; i < oldLength; i++) {
      staleKeys.push(strokeKey(i));
    }
    await this.deleteKeys(staleKeys);

    // Exclude sender — drawer 本地已删除，回传会二次 splice。
    this.broadcast({ type: "deleteStrokes", indices }, ws);
  }

  private async onClear(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    // 防御：清空画布时顺带清除挂起的晋升
    if (this.pendingPromotionId !== null) {
      this.pendingPromotionId = null;
      await this.state.storage.put("pendingPromotionId", null);
    }
    this.strokes = [];
    this.resetCurrentStroke();
    await this.clearRedoStack();
    await this.clearStrokeStorage();
    // Exclude sender — drawer already cleared locally; on a slow link the echo
    // would also wipe whatever was drawn after the click. Only onClear may do this:
    // onContinueDrawing / executeTransfer rely on the sender receiving their clear.
    this.broadcast({ type: "clear" }, ws);
  }

  private async onUndo(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    if (this.strokes.length > 0) {
      const poppedIndex = this.strokes.length - 1;
      const popped = this.strokes[poppedIndex];
      this.strokes.pop();
      this.redoStack.push(popped);
      // Both writes are issued before the first await: one atomic commit.
      await Promise.all([
        this.state.storage.delete(strokeKey(poppedIndex)),
        this.state.storage.put(redoKey(this.redoStack.length - 1), popped),
      ]);
      // Exclude sender — drawer already updated locally, a round-trip would pop twice.
      this.broadcast({ type: "undo" }, ws);
    }
  }

  private async onRedo(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }
    if (this.redoStack.length === 0) {
      return;
    }
    const redone = this.redoStack.pop();
    if (!redone) {
      return;
    }
    this.strokes.push(redone);
    // Both writes are issued before the first await: one atomic commit.
    await Promise.all([
      this.state.storage.delete(redoKey(this.redoStack.length)),
      this.state.storage.put(strokeKey(this.strokes.length - 1), redone),
    ]);
    // Exclude sender — drawer already updated locally, a round-trip would push twice.
    this.broadcast({ type: "redo" }, ws);
  }

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

    // Store original text (drawer sees this on "answer: ..." panel and
    // answerLength is the visible length). Normalization happens at compare-time.
    this.answer = answer.trim().slice(0, MAX_ANSWER_LENGTH);
    this.phase = "guessing";

    await this.saveState();

    this.broadcast({
      type: "phaseChange",
      phase: "guessing",
      drawerId: this.drawerId!,
      answerLength: this.answer.length,
    });
  }

  private async onGuess(ws: WebSocket, text: string) {
    const player = this.getPlayer(ws);
    if (!player || player.id === this.drawerId) {
      return;
    }
    if (this.phase !== "guessing") {
      return;
    }
    if (!text || text.trim().length === 0) {
      return;
    }

    const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH);
    const correct = this.answer !== null && answerMatches(trimmed, this.answer);

    this.chatHistory.push({
      kind: "guess",
      playerId: player.id,
      playerName: player.name,
      text: trimmed,
      timestamp: Date.now(),
      correct,
    });
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY);
    }
    await this.state.storage.put("chatHistory", this.chatHistory);

    this.broadcast({
      type: "guessResult",
      playerId: player.id,
      playerName: player.name,
      text: trimmed,
      correct,
    });

    if (correct) {
      this.phase = "revealed";

      // 算上保留期内的玩家：房间的玩法不该随某人短暂掉线而变（画手此刻可能正好离线）
      if (this.getEffectivePlayerCount() >= 3) {
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
  }

  private async onChat(ws: WebSocket, text: string) {
    const player = this.getPlayer(ws);
    if (!player) {
      return;
    }
    if (!text || text.trim().length === 0) {
      return;
    }

    const timestamp = Date.now();
    const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH);

    this.chatHistory.push({
      kind: "chat",
      playerId: player.id,
      playerName: player.name,
      text: trimmed,
      timestamp,
    });
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY);
    }
    await this.state.storage.put("chatHistory", this.chatHistory);

    this.broadcast({
      type: "chat",
      playerId: player.id,
      playerName: player.name,
      text: trimmed,
      timestamp,
    });
  }

  private async onContinueDrawing(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (this.phase !== "revealed") {
      return;
    }

    this.pendingPromotionId = null;
    this.phase = "drawing";
    this.answer = null;
    this.strokes = [];
    this.resetCurrentStroke();

    await this.saveState();
    await this.clearRedoStack();
    await this.clearStrokeStorage();

    this.broadcast({ type: "clear" });
    this.broadcast({
      type: "phaseChange",
      phase: "drawing",
      drawerId: this.drawerId!,
    });
  }

  private async onTransfer(ws: WebSocket, requestedTargetId?: string) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }

    let targetId = requestedTargetId;
    if (!targetId) {
      // 兼容 2 人 / 旧客户端：转给非自己的第一个
      for (const { player: other } of this.getJoinedWebSockets()) {
        if (other.id !== player.id) {
          targetId = other.id;
          break;
        }
      }
    }
    // 验证 targetId 是当前在线玩家且不是自己。前端已禁用离线候选，走到这里说明对方
    // 刚好掉线（列表还没更新），要告诉发送者，否则点了没反应。
    const targetOnline = this.getJoinedWebSockets().some(({ player: p }) => p.id === targetId);
    if (!targetId || !targetOnline) {
      this.send(ws, { type: "error", message: "对方已离线，暂时无法转让" });
      return;
    }
    if (targetId === player.id) {
      return;
    }

    await this.executeTransfer(targetId);
  }

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

  private async executeTransfer(newDrawerId: string) {
    this.pendingPromotionId = null;
    this.drawerId = newDrawerId;
    this.phase = "drawing";
    this.answer = null;
    this.strokes = [];
    this.resetCurrentStroke();

    await this.saveState();
    await this.clearRedoStack();
    await this.clearStrokeStorage();

    this.broadcast({
      type: "transferDone",
      newDrawerId: this.drawerId,
    });
    this.broadcast({ type: "clear" });
    this.broadcast({
      type: "phaseChange",
      phase: "drawing",
      drawerId: this.drawerId,
    });
  }

  /** Intentional leave — immediate removal, no grace period */
  private async onLeave(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player) {
      return;
    }

    ws.serializeAttachment(null);

    // Process as actual leave immediately
    await this.processActualLeave({
      id: player.id,
      name: player.name,
      disconnectedAt: 0,
      graceMs: 0,
    });

    try {
      ws.close(1000, "left");
    } catch {
      /* ignore */
    }
  }

  /** Unintentional disconnect — grace period for reconnection */
  private async onDisconnect(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player) {
      return;
    }

    // Clear attachment so this ws is no longer counted as a joined player
    ws.serializeAttachment(null);

    // Use short grace if quickleave beacon was received (page unload — refresh/close/navigate).
    // 标记要是新鲜的：刷新时 beacon 可能比新页面的 join 晚到，落在已接管的新连接上，
    // 不能让这条连接之后的普通断线也只有短保留期。
    const graceMs =
      player.quickLeaveAt !== undefined &&
      Date.now() - player.quickLeaveAt < QUICK_LEAVE_MARK_TTL_MS
        ? QUICK_LEAVE_GRACE_MS
        : RECONNECT_GRACE_MS;

    // Store in disconnectedPlayers for reconnection grace period
    this.disconnectedPlayers.set(player.id, {
      id: player.id,
      name: player.name,
      ...(player.token ? { token: player.token } : {}),
      disconnectedAt: Date.now(),
      graceMs,
    });

    await this.saveState();

    // Schedule alarm to clean up if they don't reconnect
    this.scheduleNextAlarm();

    this.broadcastPlayerList();
  }

  /** Called when a disconnected player's grace period expires without reconnecting */
  private async processActualLeave(dp: DisconnectedPlayer) {
    // 记录该玩家是否是待晋升的猜对者
    const wasPendingPromotion =
      this.pendingPromotionId !== null && dp.id === this.pendingPromotionId;
    if (wasPendingPromotion) {
      this.pendingPromotionId = null;
    }

    this.joinOrder = this.joinOrder.filter((id) => id !== dp.id);
    this.roster.delete(dp.id);

    const remaining = this.getJoinedWebSockets();
    // Also consider other disconnected players still in grace period
    const otherDisconnected = Array.from(this.disconnectedPlayers.values());

    const allRemaining = [...remaining.map((r) => r.player), ...otherDisconnected];

    if (allRemaining.length === 0) {
      // Room is truly empty
      await this.resetRoom();
      return;
    }

    // Notify connected players about the leave
    this.broadcast({
      type: "playerLeft",
      playerId: dp.id,
    });

    if (dp.id === this.drawerId) {
      // drawer 离开：切下家 + 清画板 + 重置 phase（旧画作对应已清的旧 answer，无意义）
      // 优先选在线的玩家，否则大家要白等对方的保留期；都不在线才退到保留期玩家。
      const online = new Set(remaining.map((r) => r.player.id));
      this.drawerId =
        this.joinOrder.find((id) => online.has(id)) ??
        this.joinOrder.find((id) => this.disconnectedPlayers.has(id)) ??
        allRemaining[0].id;

      this.strokes = [];
      this.resetCurrentStroke();
      await this.clearRedoStack();
      await this.clearStrokeStorage();
      this.answer = null;
      this.pendingPromotionId = null;

      // 新一轮：够人就 drawing，只剩新 drawer 自己就回 waiting
      this.phase = "drawing";
      this.recomputePhase();

      await this.saveState();

      this.broadcast({ type: "clear" });
      this.broadcast({
        type: "phaseChange",
        phase: this.phase,
        drawerId: this.drawerId!,
      });
      return;
    }

    // 非 drawer 离开：phase / drawer / 答案 / 画板尽量保持；只剩 drawer 自己时才降级 waiting
    const phaseChanged = this.recomputePhase();
    await this.saveState();
    if (phaseChanged) {
      this.broadcast({
        type: "phaseChange",
        phase: this.phase,
        drawerId: this.drawerId!,
      });
    } else if (wasPendingPromotion && this.phase === "revealed") {
      // 猜对者走了：保持 revealed，重发 phaseChange 但不含 pendingPromotionId，
      // 让前端回到"继续出题/转让画笔"按钮
      this.broadcast({
        type: "phaseChange",
        phase: "revealed",
        drawerId: this.drawerId!,
      });
    }
  }

  // ============ Helpers ============

  private send(ws: WebSocket, msg: Record<string, unknown>) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // WebSocket may already be closed
    }
  }

  private broadcast(msg: Record<string, unknown>, exclude?: WebSocket) {
    for (const ws of this.state.getWebSockets()) {
      if (ws !== exclude) {
        const player = this.getPlayer(ws);
        if (player) {
          this.send(ws, msg);
        }
      }
    }
  }
}
