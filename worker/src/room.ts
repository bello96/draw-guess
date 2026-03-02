// ============ Types (mirrored from frontend protocol.ts) ============

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

interface PlayerState {
  id: string;
  name: string;
  isOwner: boolean;
  ws: WebSocket;
}

// ============ GameRoom Durable Object ============

export class GameRoom implements DurableObject {
  private players: Map<WebSocket, PlayerState> = new Map();
  private drawerId: string | null = null;
  private phase: GamePhase = "waiting";
  private answer: string | null = null;
  private strokes: SerializedStroke[] = [];
  private currentStrokePoints: { x: number; y: number }[] = [];
  private currentStrokeColor = "#000000";
  private currentStrokeWidth = 3;
  private closed = false;
  private roomCode = "";

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Room info endpoint (non-WebSocket)
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(
        JSON.stringify({
          playerCount: this.players.size,
          closed: this.closed,
          phase: this.phase,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // WebSocket upgrade
    if (this.players.size >= 2) {
      return new Response("Room is full", { status: 403 });
    }

    // Extract room code from URL
    const match = url.pathname.match(/\/api\/rooms\/(\d{6})\/ws/);
    if (match) {
      this.roomCode = match[1];
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernatable WebSocket API handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case "join":
        this.onJoin(ws, msg.playerName as string);
        break;
      case "draw":
        this.onDraw(ws, msg as {
          type: string;
          action: "start" | "move" | "end";
          x: number;
          y: number;
          color: string;
          lineWidth: number;
        });
        break;
      case "clear":
        this.onClear(ws);
        break;
      case "undo":
        this.onUndo(ws);
        break;
      case "setAnswer":
        this.onSetAnswer(ws, msg.answer as string);
        break;
      case "guess":
        this.onGuess(ws, msg.text as string);
        break;
      case "chat":
        this.onChat(ws, msg.text as string);
        break;
      case "transfer":
        this.onTransfer(ws);
        break;
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.onDisconnect(ws);
  }

  // ============ Message Handlers ============

  private onJoin(ws: WebSocket, playerName: string) {
    if (this.players.size >= 2) {
      this.send(ws, { type: "error", message: "房间已满" });
      return;
    }

    const isOwner = this.players.size === 0;
    const player: PlayerState = {
      id: crypto.randomUUID(),
      name: playerName || (isOwner ? "玩家1" : "玩家2"),
      isOwner,
      ws,
    };

    this.players.set(ws, player);

    if (isOwner) {
      this.drawerId = player.id;
      this.phase = "waiting";
    } else {
      this.closed = true;
      this.phase = "drawing";
    }

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

    // If 2 players, switch to drawing phase
    if (this.players.size === 2) {
      this.broadcast({
        type: "phaseChange",
        phase: "drawing",
        drawerId: this.drawerId!,
      });
    }
  }

  private onDraw(
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
    const player = this.players.get(ws);
    if (!player || player.id !== this.drawerId) {
      this.send(ws, { type: "error", message: "你不是画手" });
      return;
    }

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

  private onClear(ws: WebSocket) {
    const player = this.players.get(ws);
    if (!player || player.id !== this.drawerId) return;

    this.strokes = [];
    this.currentStrokePoints = [];
    this.broadcast({ type: "clear" });
  }

  private onUndo(ws: WebSocket) {
    const player = this.players.get(ws);
    if (!player || player.id !== this.drawerId) return;

    if (this.strokes.length > 0) {
      this.strokes.pop();
      this.broadcast({ type: "undo" });
    }
  }

  private onSetAnswer(ws: WebSocket, answer: string) {
    const player = this.players.get(ws);
    if (!player || player.id !== this.drawerId) return;
    if (!answer || answer.trim().length === 0) return;

    this.answer = answer.trim().toLowerCase();
    this.phase = "guessing";

    this.broadcast({
      type: "phaseChange",
      phase: "guessing",
      drawerId: this.drawerId!,
      answerLength: this.answer.length,
    });
  }

  private onGuess(ws: WebSocket, text: string) {
    const player = this.players.get(ws);
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
      this.broadcast({
        type: "phaseChange",
        phase: "revealed",
        drawerId: this.drawerId!,
      });
    }
  }

  private onChat(ws: WebSocket, text: string) {
    const player = this.players.get(ws);
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

  private onTransfer(ws: WebSocket) {
    const player = this.players.get(ws);
    if (!player || player.id !== this.drawerId) return;

    // Find the other player
    for (const [, otherPlayer] of this.players) {
      if (otherPlayer.id !== player.id) {
        this.drawerId = otherPlayer.id;
        this.phase = "drawing";
        this.answer = null;
        this.strokes = [];
        this.currentStrokePoints = [];

        this.broadcast({
          type: "transferDone",
          newDrawerId: otherPlayer.id,
        });
        this.broadcast({ type: "clear" });
        this.broadcast({
          type: "phaseChange",
          phase: "drawing",
          drawerId: this.drawerId,
        });
        break;
      }
    }
  }

  private onDisconnect(ws: WebSocket) {
    const player = this.players.get(ws);
    if (!player) return;

    this.players.delete(ws);

    if (this.players.size > 0) {
      this.broadcast({
        type: "playerLeft",
        playerId: player.id,
      });

      // If the drawer left, give draw permission to the remaining player
      if (player.id === this.drawerId) {
        for (const [, remaining] of this.players) {
          this.drawerId = remaining.id;
          this.phase = "drawing";
          this.answer = null;
          this.broadcast({
            type: "phaseChange",
            phase: "drawing",
            drawerId: this.drawerId,
          });
          break;
        }
      }

      // Re-open the room so a new player can join
      this.closed = false;
      this.phase = "waiting";
      this.broadcast({
        type: "phaseChange",
        phase: "waiting",
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
    for (const [ws] of this.players) {
      if (ws !== exclude) {
        this.send(ws, msg);
      }
    }
  }

  private getPlayerInfoList(): PlayerInfo[] {
    const list: PlayerInfo[] = [];
    for (const [, p] of this.players) {
      list.push({ id: p.id, name: p.name, isOwner: p.isOwner });
    }
    return list;
  }
}
