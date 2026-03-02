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
}

// Data stored as WebSocket attachment (survives hibernation)
interface PlayerAttachment {
  id: string;
  name: string;
  isOwner: boolean;
}

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
  private timerEndsAt: number | null = null;
  private pendingNextDrawer: string | null = null;

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
      "timerEndsAt", "pendingNextDrawer",
    ]);

    this.created = (data.get("created") as boolean) ?? false;
    this.drawerId = (data.get("drawerId") as string | null) ?? null;
    this.phase = (data.get("phase") as GamePhase) ?? "waiting";
    this.answer = (data.get("answer") as string | null) ?? null;
    this.closed = (data.get("closed") as boolean) ?? false;
    this.roomCode = (data.get("roomCode") as string) ?? "";
    this.strokes = (data.get("strokes") as SerializedStroke[]) ?? [];
    this.timerEndsAt = (data.get("timerEndsAt") as number | null) ?? null;
    this.pendingNextDrawer = (data.get("pendingNextDrawer") as string | null) ?? null;
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
      timerEndsAt: this.timerEndsAt,
      pendingNextDrawer: this.pendingNextDrawer,
    });
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
          playerCount: this.getJoinedCount(),
          closed: this.closed,
          phase: this.phase,
          created: this.created,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // WebSocket upgrade
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

    switch (msg.type) {
      case "join":
        await this.onJoin(ws, msg.playerName as string);
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
        await this.onSetAnswer(ws, msg.answer as string, msg.timerSeconds as number | undefined);
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

  // ============ Alarm handler (countdown timer) ============

  async alarm() {
    await this.ensureLoaded();

    if (this.phase === "guessing") {
      // Timer expired during guessing → reveal the answer
      this.phase = "revealed";
      this.timerEndsAt = null;

      // Find the other player to auto-rotate to
      const joined = this.getJoinedWebSockets();
      const otherPlayer = joined.find(({ player }) => player.id !== this.drawerId);
      if (otherPlayer) {
        this.pendingNextDrawer = otherPlayer.player.id;
      }

      await this.saveState();

      this.broadcast({
        type: "phaseChange",
        phase: "revealed",
        drawerId: this.drawerId!,
        answer: this.answer,
      });

      // Schedule auto-rotation after 3 seconds
      if (this.pendingNextDrawer) {
        await this.state.storage.setAlarm(Date.now() + 3000);
      }
    } else if (this.phase === "revealed" && this.pendingNextDrawer) {
      // Auto-rotate to next drawer
      await this.executeTransfer(this.pendingNextDrawer);
    }
  }

  // ============ Message Handlers ============

  private async onJoin(ws: WebSocket, playerName: string) {
    if (this.getJoinedCount() >= 2) {
      this.send(ws, { type: "error", message: "房间已满" });
      return;
    }

    const isOwner = this.getJoinedCount() === 0;
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
      timerEndsAt: this.timerEndsAt,
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

  private async onSetAnswer(ws: WebSocket, answer: string, timerSeconds?: number) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;
    if (!answer || answer.trim().length === 0) return;

    this.answer = answer.trim().toLowerCase();
    this.phase = "guessing";

    // Set up timer if requested
    if (timerSeconds && timerSeconds > 0) {
      this.timerEndsAt = Date.now() + timerSeconds * 1000;
      await this.state.storage.setAlarm(Date.now() + timerSeconds * 1000);
    } else {
      this.timerEndsAt = null;
    }

    await this.saveState();

    this.broadcast({
      type: "phaseChange",
      phase: "guessing",
      drawerId: this.drawerId!,
      answerLength: this.answer.length,
      timerEndsAt: this.timerEndsAt,
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
      // Cancel existing alarm
      await this.state.storage.deleteAlarm();
      this.timerEndsAt = null;

      this.phase = "revealed";

      // Set up auto-rotation: the guesser becomes the next drawer
      this.pendingNextDrawer = player.id;

      await this.saveState();

      this.broadcast({
        type: "phaseChange",
        phase: "revealed",
        drawerId: this.drawerId!,
      });

      // Schedule auto-rotation after 3 seconds
      await this.state.storage.setAlarm(Date.now() + 3000);
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

  private async onTransfer(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player || player.id !== this.drawerId) return;

    // Cancel any pending alarm/timer
    await this.state.storage.deleteAlarm();
    this.timerEndsAt = null;
    this.pendingNextDrawer = null;

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
    this.timerEndsAt = null;
    this.pendingNextDrawer = null;

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

  private async onDisconnect(ws: WebSocket) {
    const player = this.getPlayer(ws);
    if (!player) return;

    // Clear attachment so this ws is no longer counted as a joined player
    ws.serializeAttachment(null);

    // Cancel any pending alarm/timer
    await this.state.storage.deleteAlarm();
    this.timerEndsAt = null;
    this.pendingNextDrawer = null;

    const remaining = this.getJoinedWebSockets();

    if (remaining.length > 0) {
      this.broadcast({
        type: "playerLeft",
        playerId: player.id,
      });

      // If the drawer left, give draw permission to the remaining player
      if (player.id === this.drawerId) {
        this.drawerId = remaining[0].player.id;
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
      // Room is empty, reset everything
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
