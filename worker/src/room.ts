import {
  ACTIVITY_PERSIST_MIN_INTERVAL_MS,
  DELETE_BATCH_SIZE,
  INACTIVITY_TIMEOUT_MS,
  MAX_ANSWER_LENGTH,
  MAX_CHAT_HISTORY,
  MAX_CHAT_LENGTH,
  MAX_MAX_PLAYERS,
  MAX_NAME_LENGTH,
  MAX_TEXT_STROKE_LENGTH,
  MIN_MAX_PLAYERS,
  PROTOCOL_VERSION,
  QUICK_LEAVE_GRACE_MS,
  RATE_LIMIT_MAX_MSGS,
  RATE_LIMIT_WINDOW_MS,
  RECONNECT_GRACE_MS,
  STROKE_KEY_PREFIX,
} from "./constants";
import { normalizeForCompare, strokeKey } from "./helpers";
import type {
  ChatHistoryEntry,
  DisconnectedPlayer,
  GamePhase,
  PlayerAttachment,
  PlayerInfo,
  SerializedStroke,
} from "./types";

// ============ GameRoom Durable Object ============

export class GameRoom implements DurableObject {
  // In-memory cache (restored from storage on wake)
  private loaded = false;
  private created = false;
  private drawerId: string | null = null;
  private phase: GamePhase = "waiting";
  private answer: string | null = null;
  private strokes: SerializedStroke[] = [];
  // Undone strokes, LIFO. Any new stroke invalidates this list. Not persisted —
  // redo only survives within one active DO session; hibernation resets it.
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
  // pendingPromotionId 不持久化；用于 3+ 人房 revealed 阶段的猜对者
  private pendingPromotionId: string | null = null;

  // Transient state (not persisted, OK to lose on hibernation)
  private currentStrokePoints: { x: number; y: number }[] = [];
  private currentStrokeColor = "#000000";
  private currentStrokeWidth = 3;
  // Pen 笔型缓存：start 时存下，move/end 透传到广播；end 写入持久化 stroke。
  private currentStrokeBrush: "pen" | "airbrush" | "crayon" | "watercolor" = "pen";
  // Per-ws rolling window counter for rate limiting. WeakMap ensures the
  // entry is GC'd when the ws is collected, and hibernation resets it naturally.
  private wsMessageCounts = new WeakMap<WebSocket, { windowStart: number; count: number }>();

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {}

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

    // One-time cleanup: drop the legacy single-key "strokes" blob. Idempotent.
    await this.state.storage.delete("strokes");

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
  }

  /** Rolling-window rate check. Returns false when over limit. */
  private checkRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    const info = this.wsMessageCounts.get(ws);
    if (!info || now - info.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.wsMessageCounts.set(ws, { windowStart: now, count: 1 });
      return true;
    }
    info.count++;
    return info.count <= RATE_LIMIT_MAX_MSGS;
  }

  /** Delete every per-stroke entry from storage. Safe at any point. */
  private async clearStrokeStorage() {
    const list = await this.state.storage.list({ prefix: STROKE_KEY_PREFIX });
    const keys = Array.from(list.keys());
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      await this.state.storage.delete(keys.slice(i, i + DELETE_BATCH_SIZE));
    }
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

    // Inactivity timeout
    if (this.lastActivityAt > 0 && this.getEffectivePlayerCount() > 0) {
      candidates.push(this.lastActivityAt + INACTIVITY_TIMEOUT_MS);
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
    return ws.deserializeAttachment() as PlayerAttachment | null;
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

  private isPlayerActive(id: string): boolean {
    if (this.disconnectedPlayers.has(id)) {
      return true;
    }
    return this.getJoinedWebSockets().some(({ player }) => player.id === id);
  }

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

  private canMutateCanvas(): boolean {
    return this.phase === "drawing" || this.phase === "waiting";
  }

  // ============ HTTP fetch handler ============

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    // Internal: POST /init - mark room as created
    // Returns 409 if already created, so the parent Worker can retry with a new code.
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

    // POST /quickleave — beacon from pagehide, shorten grace period
    if (url.pathname.endsWith("/quickleave") && request.method === "POST") {
      const playerId = url.searchParams.get("playerId");
      if (!playerId) {
        return new Response("Missing playerId", { status: 400 });
      }

      // Case 1: Player still connected (beacon arrived before WS close) — mark for short grace
      for (const { ws, player } of this.getJoinedWebSockets()) {
        if (player.id === playerId) {
          ws.serializeAttachment({ ...player, quickLeave: true });
          return new Response("OK");
        }
      }

      // Case 2: Already disconnected (WS closed before beacon) — shorten grace
      const dp = this.disconnectedPlayers.get(playerId);
      if (dp) {
        dp.disconnectedAt = Date.now();
        dp.graceMs = QUICK_LEAVE_GRACE_MS;
        await this.saveState();
        this.scheduleNextAlarm();
      }

      return new Response("OK");
    }

    // Room info endpoint (non-WebSocket)
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(
        JSON.stringify({
          playerCount: this.getEffectivePlayerCount(),
          closed: this.getEffectivePlayerCount() >= this.maxPlayers, // 满员才视为已关闭
          phase: this.phase,
          created: this.created,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // WebSocket upgrade — always accept; capacity is validated in onJoin
    // which can send a proper error message the client can display.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept WebSocket for hibernation; attachment will be set on "join"
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ============ Hibernatable WebSocket API handlers ============

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") {
      return;
    }
    await this.ensureLoaded();

    if (!this.checkRateLimit(ws)) {
      this.send(ws, { type: "error", message: "消息频率过高，连接已断开" });
      try {
        ws.close(1008, "rate limited");
      } catch {
        /* ignore */
      }
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    // Update activity on any player message (except join and ping heartbeat).
    // Ping would otherwise reset the inactivity timer and defeat auto-close.
    if (msg.type !== "join" && msg.type !== "ping") {
      await this.touchActivity();
    }

    switch (msg.type) {
      case "join":
        await this.onJoin(
          ws,
          msg.playerName as string,
          msg.playerId as string | undefined,
          typeof msg.v === "number" ? msg.v : undefined,
        );
        break;
      case "ping":
        this.send(ws, { type: "pong" });
        break;
      case "draw":
        await this.onDraw(
          ws,
          msg as {
            type: string;
            action: "start" | "move" | "end";
            x: number;
            y: number;
            color: string;
            lineWidth: number;
            brushType?: "pen" | "airbrush" | "crayon" | "watercolor";
            points?: { x: number; y: number }[];
          },
        );
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
        await this.onSetAnswer(ws, msg.answer as string);
        break;
      case "guess":
        await this.onGuess(ws, msg.text as string);
        break;
      case "chat":
        await this.onChat(ws, msg.text as string);
        break;
      case "transfer":
        await this.onTransfer(ws, msg as { type: string; targetId?: string });
        break;
      case "textStroke":
        await this.onTextStroke(
          ws,
          msg as {
            type: string;
            text: string;
            x: number;
            y: number;
            color: string;
            fontSize: number;
          },
        );
        break;
      case "shape":
        await this.onShape(
          ws,
          msg as {
            type: string;
            shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
            filled: boolean;
            x: number;
            y: number;
            width: number;
            height: number;
            color: string;
            lineWidth: number;
          },
        );
        break;
      case "fill":
        await this.onFill(
          ws,
          msg as {
            type: string;
            x: number;
            y: number;
            color: string;
            tolerance: number;
          },
        );
        break;
      case "selection":
        await this.onSelection(
          ws,
          msg as {
            type: string;
            srcX: number;
            srcY: number;
            w: number;
            h: number;
            dstX: number;
            dstY: number;
          },
        );
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

  async webSocketClose(ws: WebSocket) {
    await this.ensureLoaded();
    await this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.ensureLoaded();
    await this.onDisconnect(ws);
  }

  async alarm() {
    await this.ensureLoaded();

    const now = Date.now();

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
      this.lastActivityAt > 0 &&
      now - this.lastActivityAt >= INACTIVITY_TIMEOUT_MS &&
      this.getEffectivePlayerCount() > 0
    ) {
      // Notify all connected players and destroy the room
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

      // Reset room
      this.created = false;
      this.phase = "waiting";
      this.drawerId = null;
      this.answer = null;
      this.strokes = [];
      this.redoStack = [];
      this.chatHistory = [];
      this.disconnectedPlayers.clear();
      this.lastActivityAt = 0;
      this.joinOrder = [];
      this.maxPlayers = MIN_MAX_PLAYERS;
      this.pendingPromotionId = null;
      await this.saveState();
      await this.clearStrokeStorage();
      return;
    }

    // --- 3. Schedule next alarm if needed ---
    this.scheduleNextAlarm();
  }

  // ============ Message Handlers ============

  private async onJoin(
    ws: WebSocket,
    playerName: string,
    playerId?: string,
    clientVersion?: number,
  ) {
    // Protocol version check. `clientVersion == null` is a legacy-client grace
    // (see PROTOCOL_VERSION comment) — remove the null branch once pre-v1
    // clients are no longer expected in the wild.
    if (clientVersion != null && clientVersion !== PROTOCOL_VERSION) {
      this.send(ws, {
        type: "error",
        message: "客户端版本过旧，请刷新页面",
      });
      try {
        ws.close(1000, "version mismatch");
      } catch {
        /* ignore */
      }
      return;
    }

    // Reject joins to non-existent rooms
    if (!this.created) {
      this.send(ws, { type: "error", message: "房间不存在" });
      try {
        ws.close(1000, "room not found");
      } catch {
        /* ignore */
      }
      return;
    }

    await this.touchActivity();

    if (playerId) {
      // Check disconnectedPlayers first (normal reconnection after close was processed)
      const disconnected = this.disconnectedPlayers.get(playerId);

      if (disconnected) {
        // ---- Reconnection from disconnectedPlayers ----
        this.disconnectedPlayers.delete(playerId);

        const player: PlayerAttachment = {
          id: disconnected.id,
          name: disconnected.name,
        };

        ws.serializeAttachment(player);
        await this.saveState();

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
          ...(player.id === this.drawerId && this.answer
            ? { answer: this.answer, answerLength: this.answer.length }
            : this.answer
              ? { answerLength: this.answer.length }
              : {}),
        });

        return;
      }

      // Check active WebSockets — the old connection may not have closed yet (race condition)
      for (const { ws: oldWs, player: existing } of this.getJoinedWebSockets()) {
        if (existing.id === playerId && oldWs !== ws) {
          // Take over: close old WS, reuse identity on new WS
          oldWs.serializeAttachment(null);
          try {
            oldWs.close(1000, "reconnected");
          } catch {
            /* already closed */
          }

          const player: PlayerAttachment = {
            id: existing.id,
            name: existing.name,
          };

          ws.serializeAttachment(player);
          await this.saveState();

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
            ...(player.id === this.drawerId && this.answer
              ? { answer: this.answer, answerLength: this.answer.length }
              : this.answer
                ? { answerLength: this.answer.length }
                : {}),
          });

          return;
        }
      }
    }

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

    // Store player info as WebSocket attachment (survives hibernation)
    ws.serializeAttachment(player);
    this.joinOrder.push(player.id);

    if (isFirst) {
      this.drawerId = player.id;
      this.phase = "waiting";
    } else if (this.joinOrder.length === 2) {
      // 第 2 人加入：进入 drawing 阶段
      this.phase = "drawing";
    }
    // 第 3 人及之后：phase 不变（已是 drawing/guessing/revealed 之一）

    await this.saveState();

    // Send full state to the joining player
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
      ...(player.id === this.drawerId && this.answer
        ? { answer: this.answer, answerLength: this.answer.length }
        : this.answer
          ? { answerLength: this.answer.length }
          : {}),
    });

    // Notify other players about the new join
    this.broadcast(
      {
        type: "playerJoined",
        player: { id: player.id, name: player.name, isOwner: player.id === this.drawerId },
      },
      ws,
    );

    // If 2 players, notify first player about phase change
    if (this.getJoinedCount() === 2) {
      this.broadcast(
        {
          type: "phaseChange",
          phase: "drawing",
          drawerId: this.drawerId!,
        },
        ws, // Only send to the OTHER player; joining player already has it via roomState
      );
    }
  }

  private async onDraw(
    ws: WebSocket,
    msg: {
      type: string;
      action: "start" | "move" | "end";
      x: number;
      y: number;
      color: string;
      lineWidth: number;
      brushType?: "pen" | "airbrush" | "crayon" | "watercolor";
      points?: { x: number; y: number }[];
    },
  ) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    // Track stroke for replay
    if (msg.action === "start") {
      this.currentStrokePoints = [{ x: msg.x, y: msg.y }];
      this.currentStrokeColor = msg.color;
      this.currentStrokeWidth = msg.lineWidth;
      // brushType 只在 start 上发；缺值视作 "pen"（兼容旧客户端）
      const incomingBrush = msg.brushType;
      this.currentStrokeBrush =
        incomingBrush === "airbrush" ||
        incomingBrush === "crayon" ||
        incomingBrush === "watercolor"
          ? incomingBrush
          : "pen";
    } else if (msg.action === "move") {
      // 'move' may carry a batch of points (RAF-throttled) or a single x/y.
      const movePoints = msg.points ?? [{ x: msg.x, y: msg.y }];
      this.currentStrokePoints.push(...movePoints);
    } else if (msg.action === "end") {
      this.currentStrokePoints.push({ x: msg.x, y: msg.y });
      const stroke: SerializedStroke = {
        points: [...this.currentStrokePoints],
        color: this.currentStrokeColor,
        lineWidth: this.currentStrokeWidth,
        // 默认 pen 不写字段（保持 wire 紧凑、和老 stroke 一致）
        ...(this.currentStrokeBrush !== "pen" ? { brushType: this.currentStrokeBrush } : {}),
      };
      this.strokes.push(stroke);
      this.redoStack = []; // new stroke invalidates redo history
      this.currentStrokePoints = [];
      // Persist only the new stroke (not the whole list) to stay under value limits.
      await this.state.storage.put(strokeKey(this.strokes.length - 1), stroke);
    }

    // Forward to the other player — preserve points batch + brushType when present.
    // brushType 在每一帧都透传给对端，免得对端要缓存 start 时的笔型。
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
      },
      ws,
    );
  }

  private async onTextStroke(
    ws: WebSocket,
    msg: {
      type: string;
      text: string;
      x: number;
      y: number;
      color: string;
      fontSize: number;
    },
  ) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    const text = (msg.text || "").slice(0, MAX_TEXT_STROKE_LENGTH);
    if (!text) {
      return;
    }

    const stroke: SerializedStroke = {
      points: [{ x: msg.x, y: msg.y }],
      color: msg.color,
      lineWidth: 0,
      text,
      fontSize: msg.fontSize,
    };
    this.strokes.push(stroke);
    this.redoStack = []; // new stroke invalidates redo history
    await this.state.storage.put(strokeKey(this.strokes.length - 1), stroke);

    this.broadcast(
      {
        type: "textStroke",
        text,
        x: msg.x,
        y: msg.y,
        color: msg.color,
        fontSize: msg.fontSize,
      },
      ws,
    );
  }

  private async onShape(
    ws: WebSocket,
    msg: {
      type: string;
      shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
      filled: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      lineWidth: number;
    },
  ) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }
    if (
      msg.shape !== "rect" &&
      msg.shape !== "ellipse" &&
      msg.shape !== "arrow" &&
      msg.shape !== "line" &&
      msg.shape !== "triangle" &&
      msg.shape !== "star" &&
      msg.shape !== "heart"
    ) {
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
    this.strokes.push(stroke);
    this.redoStack = []; // new stroke invalidates redo history
    await this.state.storage.put(strokeKey(this.strokes.length - 1), stroke);

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

  private async onFill(
    ws: WebSocket,
    msg: {
      type: string;
      x: number;
      y: number;
      color: string;
      tolerance: number;
    },
  ) {
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
    this.strokes.push(stroke);
    this.redoStack = [];
    await this.state.storage.put(strokeKey(this.strokes.length - 1), stroke);

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

  private async onSelection(
    ws: WebSocket,
    msg: {
      type: string;
      srcX: number;
      srcY: number;
      w: number;
      h: number;
      dstX: number;
      dstY: number;
    },
  ) {
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
    this.strokes.push(stroke);
    this.redoStack = [];
    await this.state.storage.put(strokeKey(this.strokes.length - 1), stroke);

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

  private async onClear(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }
    if (!this.canMutateCanvas()) {
      return;
    }

    this.pendingPromotionId = null; // 防御：清空画布时顺带清除挂起的晋升
    this.strokes = [];
    this.redoStack = [];
    this.currentStrokePoints = [];
    await this.clearStrokeStorage();
    this.broadcast({ type: "clear" });
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
      await this.state.storage.delete(strokeKey(poppedIndex));
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
    await this.state.storage.put(strokeKey(this.strokes.length - 1), redone);
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
    const correct =
      this.answer !== null && normalizeForCompare(trimmed) === normalizeForCompare(this.answer);

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
    this.redoStack = [];
    this.currentStrokePoints = [];

    await this.saveState();
    await this.clearStrokeStorage();

    this.broadcast({ type: "clear" });
    this.broadcast({
      type: "phaseChange",
      phase: "drawing",
      drawerId: this.drawerId!,
    });
  }

  private async onTransfer(ws: WebSocket, msg: { type: string; targetId?: string }) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) {
      return;
    }

    let targetId: string | undefined =
      typeof msg.targetId === "string" && msg.targetId.length > 0
        ? msg.targetId
        : undefined;
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
    const targetOnline = this.getJoinedWebSockets().some(({ player: p }) => p.id === targetId);
    if (!targetOnline) {
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
    this.redoStack = [];
    this.currentStrokePoints = [];

    await this.saveState();
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

    // Use short grace if quickleave beacon was received (page unload — refresh/close/navigate)
    const graceMs = player.quickLeave ? QUICK_LEAVE_GRACE_MS : RECONNECT_GRACE_MS;

    // Store in disconnectedPlayers for reconnection grace period
    this.disconnectedPlayers.set(player.id, {
      id: player.id,
      name: player.name,
      disconnectedAt: Date.now(),
      graceMs,
    });

    await this.saveState();

    // Schedule alarm to clean up if they don't reconnect
    this.scheduleNextAlarm();
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

    const remaining = this.getJoinedWebSockets();
    // Also consider other disconnected players still in grace period
    const otherDisconnected = Array.from(this.disconnectedPlayers.values());

    const allRemaining = [...remaining.map((r) => r.player), ...otherDisconnected];

    if (allRemaining.length > 0) {
      // Notify connected players about the leave
      this.broadcast({
        type: "playerLeft",
        playerId: dp.id,
      });

      // 猜对者离线：保持 revealed 阶段，重发 phaseChange 但不含 pendingPromotionId，
      // 让前端回到"继续出题/转让画笔"按钮
      if (wasPendingPromotion && this.phase === "revealed") {
        await this.saveState(); // 持久化 joinOrder 的变动
        this.broadcast({
          type: "phaseChange",
          phase: "revealed",
          drawerId: this.drawerId!,
        });
        return;
      }

      const wasDrawer = dp.id === this.drawerId;

      if (wasDrawer) {
        // drawer 离开：切下家 + 清画板 + 重置 phase（旧画作对应已清的旧 answer，无意义）
        let newDrawer: string | null = null;
        for (const id of this.joinOrder) {
          if (this.isPlayerActive(id)) {
            newDrawer = id;
            break;
          }
        }
        if (!newDrawer) {
          newDrawer = allRemaining[0].id;
        }
        this.drawerId = newDrawer;

        this.strokes = [];
        this.redoStack = [];
        this.currentStrokePoints = [];
        await this.clearStrokeStorage();
        this.answer = null;
        this.pendingPromotionId = null;

        // phase 看当前连接数（不含 grace）：≥2 立即 drawing，否则等人 waiting
        const connectedCount = this.getJoinedWebSockets().length;
        this.phase = connectedCount >= 2 ? "drawing" : "waiting";

        await this.saveState();

        this.broadcast({ type: "clear" });
        this.broadcast({
          type: "phaseChange",
          phase: this.phase,
          drawerId: this.drawerId!,
        });
      } else {
        // 非 drawer 离开：phase / drawer / 画板尽量保持；仅当剩 drawer 自己时降级 waiting
        const connectedCount = this.getJoinedWebSockets().length;
        if (connectedCount < 2) {
          this.phase = "waiting";
          this.answer = null;
          this.pendingPromotionId = null;
          await this.saveState();
          this.broadcast({
            type: "phaseChange",
            phase: "waiting",
            drawerId: this.drawerId!,
          });
        } else {
          // ≥2 人在线：游戏继续，phase / drawer / answer / 画板都不变
          await this.saveState();
        }
      }
    } else {
      // Room is truly empty, reset everything
      this.created = false;
      this.phase = "waiting";
      this.drawerId = null;
      this.answer = null;
      this.strokes = [];
      this.redoStack = [];
      this.chatHistory = [];
      this.maxPlayers = MIN_MAX_PLAYERS;
      this.joinOrder = [];
      this.pendingPromotionId = null;
      // 与 inactivity 路径对齐：清空 idle 计时基准。否则下次 /init 复用此 DO
      // 时，scheduleNextAlarm 可能基于旧值算出已过期的 inactivity 时间点。
      this.lastActivityAt = 0;
      await this.saveState();
      await this.clearStrokeStorage();
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
