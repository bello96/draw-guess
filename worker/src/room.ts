// ============ Types ============

type GamePhase = "waiting" | "drawing" | "guessing" | "revealed";

interface PlayerInfo {
  id: string;
  name: string;
  isOwner: boolean;
}

interface SerializedStroke {
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  text?: string;
  fontSize?: number;
}

// Data stored as WebSocket attachment (survives hibernation)
interface PlayerAttachment {
  id: string;
  name: string;
  isOwner: boolean;
}

// Player info stored during reconnection grace period
interface DisconnectedPlayer {
  id: string;
  name: string;
  isOwner: boolean;
  disconnectedAt: number;
}

const RECONNECT_GRACE_MS = 30_000; // 30 seconds
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ============ GameRoom Durable Object ============

export class GameRoom implements DurableObject {
  // In-memory cache (restored from storage on wake)
  private loaded = false;
  private created = false;
  private drawerId: string | null = null;
  private phase: GamePhase = "waiting";
  private answer: string | null = null;
  private strokes: SerializedStroke[] = [];
  private closed = false;
  private roomCode = "";
  private disconnectedPlayers: Map<string, DisconnectedPlayer> = new Map();
  private lastActivityAt = 0;

  // Transient state (not persisted, OK to lose on hibernation)
  private currentStrokePoints: { x: number; y: number }[] = [];
  private currentStrokeColor = "#000000";
  private currentStrokeWidth = 3;

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {}

  // ============ Restore state from storage after hibernation ============

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;

    const data = await this.state.storage.get<unknown>([
      "created", "drawerId", "phase", "answer", "closed", "roomCode", "strokes",
      "disconnectedPlayers", "lastActivityAt",
    ]);

    this.created = (data.get("created") as boolean) ?? false;
    this.drawerId = (data.get("drawerId") as string | null) ?? null;
    this.phase = (data.get("phase") as GamePhase) ?? "waiting";
    this.answer = (data.get("answer") as string | null) ?? null;
    this.closed = (data.get("closed") as boolean) ?? false;
    this.roomCode = (data.get("roomCode") as string) ?? "";
    this.strokes = (data.get("strokes") as SerializedStroke[]) ?? [];

    const dcRaw = data.get("disconnectedPlayers") as [string, DisconnectedPlayer][] | null;
    this.disconnectedPlayers = dcRaw ? new Map(dcRaw) : new Map();
    this.lastActivityAt = (data.get("lastActivityAt") as number) ?? 0;
  }

  private async saveState() {
    await this.state.storage.put({
      created: this.created,
      drawerId: this.drawerId,
      phase: this.phase,
      answer: this.answer,
      closed: this.closed,
      roomCode: this.roomCode,
      strokes: this.strokes,
      disconnectedPlayers: Array.from(this.disconnectedPlayers.entries()),
      lastActivityAt: this.lastActivityAt,
    });
  }

  /** Update last activity timestamp and schedule inactivity alarm */
  private async touchActivity() {
    this.lastActivityAt = Date.now();
    await this.state.storage.put("lastActivityAt", this.lastActivityAt);
    this.scheduleNextAlarm();
  }

  /** Schedule the earliest needed alarm (reconnect grace or inactivity timeout) */
  private scheduleNextAlarm() {
    const candidates: number[] = [];

    // Reconnect grace deadlines
    for (const dp of this.disconnectedPlayers.values()) {
      candidates.push(dp.disconnectedAt + RECONNECT_GRACE_MS);
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

  private getPlayerInfoList(): PlayerInfo[] {
    return this.getJoinedWebSockets().map(({ player }) => ({
      id: player.id,
      name: player.name,
      isOwner: player.isOwner,
    }));
  }

  // ============ HTTP fetch handler ============

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    // Internal: POST /init - mark room as created
    if (url.pathname === "/init" && request.method === "POST") {
      const code = url.searchParams.get("code") || "";
      this.created = true;
      this.roomCode = code;
      await this.state.storage.put({ created: true, roomCode: code });
      return new Response("OK");
    }

    // Room info endpoint (non-WebSocket)
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(
        JSON.stringify({
          playerCount: this.getEffectivePlayerCount(),
          closed: this.closed,
          phase: this.phase,
          created: this.created,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // WebSocket upgrade — allow if there's room for active connections
    // (reconnecting players will be validated in onJoin by matching their playerId)
    if (this.getJoinedCount() >= 2) {
      return new Response("Room is full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept WebSocket for hibernation; attachment will be set on "join"
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ============ Hibernatable WebSocket API handlers ============

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    await this.ensureLoaded();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    // Update activity on any player message
    if (msg.type !== "join") {
      await this.touchActivity();
    }

    switch (msg.type) {
      case "join":
        await this.onJoin(ws, msg.playerName as string, msg.playerId as string | undefined);
        break;
      case "draw":
        await this.onDraw(ws, msg as {
          type: string;
          action: "start" | "move" | "end";
          x: number;
          y: number;
          color: string;
          lineWidth: number;
        });
        break;
      case "clear":
        await this.onClear(ws);
        break;
      case "undo":
        await this.onUndo(ws);
        break;
      case "setAnswer":
        await this.onSetAnswer(ws, msg.answer as string);
        break;
      case "guess":
        await this.onGuess(ws, msg.text as string);
        break;
      case "chat":
        this.onChat(ws, msg.text as string);
        break;
      case "transfer":
        await this.onTransfer(ws);
        break;
      case "textStroke":
        await this.onTextStroke(ws, msg as {
          type: string;
          text: string;
          x: number;
          y: number;
          color: string;
          fontSize: number;
        });
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
      if (now - dp.disconnectedAt >= RECONNECT_GRACE_MS) {
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
        try { ws.close(1000, "inactivity"); } catch { /* ignore */ }
      }

      // Reset room
      this.created = false;
      this.closed = false;
      this.phase = "waiting";
      this.drawerId = null;
      this.answer = null;
      this.strokes = [];
      this.disconnectedPlayers.clear();
      this.lastActivityAt = 0;
      await this.saveState();
      return;
    }

    // --- 3. Schedule next alarm if needed ---
    this.scheduleNextAlarm();
  }

  // ============ Message Handlers ============

  private async onJoin(ws: WebSocket, playerName: string, playerId?: string) {
    // Reject joins to non-existent rooms
    if (!this.created) {
      this.send(ws, { type: "error", message: "房间不存在" });
      try { ws.close(1000, "room not found"); } catch { /* ignore */ }
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
          isOwner: disconnected.isOwner,
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
          yourId: player.id,
          answerLength: this.answer ? this.answer.length : undefined,
        });

        return;
      }

      // Check active WebSockets — the old connection may not have closed yet (race condition)
      for (const { ws: oldWs, player: existing } of this.getJoinedWebSockets()) {
        if (existing.id === playerId && oldWs !== ws) {
          // Take over: close old WS, reuse identity on new WS
          oldWs.serializeAttachment(null);
          try { oldWs.close(1000, "reconnected"); } catch { /* already closed */ }

          const player: PlayerAttachment = {
            id: existing.id,
            name: existing.name,
            isOwner: existing.isOwner,
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
            yourId: player.id,
            answerLength: this.answer ? this.answer.length : undefined,
          });

          return;
        }
      }
    }

    // ---- New player join ----
    if (this.getEffectivePlayerCount() >= 2) {
      this.send(ws, { type: "error", message: "房间已满" });
      return;
    }

    const isOwner = this.getEffectivePlayerCount() === 0;
    const player: PlayerAttachment = {
      id: crypto.randomUUID(),
      name: playerName || (isOwner ? "玩家1" : "玩家2"),
      isOwner,
    };

    // Store player info as WebSocket attachment (survives hibernation)
    ws.serializeAttachment(player);

    if (isOwner) {
      this.drawerId = player.id;
      this.phase = "waiting";
    } else {
      this.closed = true;
      this.phase = "drawing";
    }

    await this.saveState();

    // Send full state to the joining player
    this.send(ws, {
      type: "roomState",
      roomCode: this.roomCode,
      players: this.getPlayerInfoList(),
      drawerId: this.drawerId,
      phase: this.phase,
      strokes: this.strokes,
      yourId: player.id,
    });

    // Notify other player about the new join
    this.broadcast(
      {
        type: "playerJoined",
        player: { id: player.id, name: player.name, isOwner: player.isOwner },
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
    },
  ) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;

    // Track stroke for replay
    if (msg.action === "start") {
      this.currentStrokePoints = [{ x: msg.x, y: msg.y }];
      this.currentStrokeColor = msg.color;
      this.currentStrokeWidth = msg.lineWidth;
    } else if (msg.action === "move") {
      this.currentStrokePoints.push({ x: msg.x, y: msg.y });
    } else if (msg.action === "end") {
      this.currentStrokePoints.push({ x: msg.x, y: msg.y });
      this.strokes.push({
        points: [...this.currentStrokePoints],
        color: this.currentStrokeColor,
        lineWidth: this.currentStrokeWidth,
      });
      this.currentStrokePoints = [];
      // Persist strokes only on stroke end
      await this.state.storage.put("strokes", this.strokes);
    }

    // Forward to the other player
    this.broadcast(
      {
        type: "draw",
        action: msg.action,
        x: msg.x,
        y: msg.y,
        color: msg.color,
        lineWidth: msg.lineWidth,
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
    if (!player || player.id !== this.drawerId) return;

    const stroke: SerializedStroke = {
      points: [{ x: msg.x, y: msg.y }],
      color: msg.color,
      lineWidth: 0,
      text: msg.text,
      fontSize: msg.fontSize,
    };
    this.strokes.push(stroke);
    await this.state.storage.put("strokes", this.strokes);

    this.broadcast(
      {
        type: "textStroke",
        text: msg.text,
        x: msg.x,
        y: msg.y,
        color: msg.color,
        fontSize: msg.fontSize,
      },
      ws,
    );
  }

  private async onClear(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;

    this.strokes = [];
    this.currentStrokePoints = [];
    await this.state.storage.put("strokes", this.strokes);
    this.broadcast({ type: "clear" });
  }

  private async onUndo(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;

    if (this.strokes.length > 0) {
      this.strokes.pop();
      await this.state.storage.put("strokes", this.strokes);
      this.broadcast({ type: "undo" });
    }
  }

  private async onSetAnswer(ws: WebSocket, answer: string) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;
    if (!answer || answer.trim().length === 0) return;

    this.answer = answer.trim().toLowerCase();
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
    if (!player || player.id === this.drawerId) return;
    if (this.phase !== "guessing") return;
    if (!text || text.trim().length === 0) return;

    const guess = text.trim().toLowerCase();
    const correct = guess === this.answer;

    this.broadcast({
      type: "guessResult",
      playerId: player.id,
      playerName: player.name,
      text: text.trim(),
      correct,
    });

    if (correct) {
      this.phase = "revealed";

      await this.saveState();

      this.broadcast({
        type: "phaseChange",
        phase: "revealed",
        drawerId: this.drawerId!,
      });
    }
  }

  private onChat(ws: WebSocket, text: string) {
    const player = this.getPlayer(ws);
    if (!player) return;
    if (!text || text.trim().length === 0) return;

    this.broadcast({
      type: "chat",
      playerId: player.id,
      playerName: player.name,
      text: text.trim(),
      timestamp: Date.now(),
    });
  }

  private async onContinueDrawing(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;
    if (this.phase !== "revealed") return;

    this.phase = "drawing";
    this.answer = null;
    this.strokes = [];
    this.currentStrokePoints = [];

    await this.saveState();

    this.broadcast({ type: "clear" });
    this.broadcast({
      type: "phaseChange",
      phase: "drawing",
      drawerId: this.drawerId!,
    });
  }

  private async onTransfer(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;

    // Find the other player
    for (const { player: other } of this.getJoinedWebSockets()) {
      if (other.id !== player.id) {
        await this.executeTransfer(other.id);
        break;
      }
    }
  }

  private async executeTransfer(newDrawerId: string) {
    this.drawerId = newDrawerId;
    this.phase = "drawing";
    this.answer = null;
    this.strokes = [];
    this.currentStrokePoints = [];

    await this.saveState();

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
    if (!player) return;

    ws.serializeAttachment(null);

    // Process as actual leave immediately
    await this.processActualLeave({
      id: player.id,
      name: player.name,
      isOwner: player.isOwner,
      disconnectedAt: 0,
    });

    try { ws.close(1000, "left"); } catch { /* ignore */ }
  }

  /** Unintentional disconnect — grace period for reconnection */
  private async onDisconnect(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player) return;

    // Clear attachment so this ws is no longer counted as a joined player
    ws.serializeAttachment(null);

    // Store in disconnectedPlayers for reconnection grace period
    this.disconnectedPlayers.set(player.id, {
      id: player.id,
      name: player.name,
      isOwner: player.isOwner,
      disconnectedAt: Date.now(),
    });

    await this.saveState();

    // Schedule alarm to clean up if they don't reconnect
    this.scheduleNextAlarm();
  }

  /** Called when a disconnected player's grace period expires without reconnecting */
  private async processActualLeave(dp: DisconnectedPlayer) {
    const remaining = this.getJoinedWebSockets();
    // Also consider other disconnected players still in grace period
    const otherDisconnected = Array.from(this.disconnectedPlayers.values());

    const allRemaining = [
      ...remaining.map((r) => r.player),
      ...otherDisconnected,
    ];

    if (allRemaining.length > 0) {
      // Notify connected players about the leave
      this.broadcast({
        type: "playerLeft",
        playerId: dp.id,
      });

      // If the drawer left, give draw permission to remaining
      if (dp.id === this.drawerId && remaining.length > 0) {
        this.drawerId = remaining[0].player.id;
      } else if (dp.id === this.drawerId && otherDisconnected.length > 0) {
        this.drawerId = otherDisconnected[0].id;
      }

      // Re-open the room so a new player can join
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
      await this.saveState();
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
