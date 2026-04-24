// Shared types for the GameRoom Durable Object.
// Not imported by the frontend — that uses src/types/protocol.ts. Some shapes
// overlap (PlayerInfo, SerializedStroke, ChatHistoryEntry) but duplicating
// keeps the worker self-contained and avoids cross-package imports.

export type GamePhase = "waiting" | "drawing" | "guessing" | "revealed";

export interface PlayerInfo {
  id: string;
  name: string;
  isOwner: boolean;
}

export interface SerializedStroke {
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  // Text stroke fields (optional)
  text?: string;
  fontSize?: number;
  // Shape stroke fields (optional).
  // - rect/ellipse: points = [topLeft, bottomRight] (min→max)
  // - arrow/line:   points = [start, end] (direction preserved for arrow; irrelevant for line)
  shape?: "rect" | "ellipse" | "arrow" | "line";
  filled?: boolean; // only meaningful for rect/ellipse
  // Bucket-fill stroke: points = [{ x, y }] seed, color = fill color.
  fill?: { tolerance: number };
}

// Chat/guess message stored for replay on reconnection.
export interface ChatHistoryEntry {
  kind: "chat" | "guess";
  playerId: string;
  playerName: string;
  text: string;
  timestamp: number;
  correct?: boolean;
}

// Data stored as WebSocket attachment (survives hibernation).
export interface PlayerAttachment {
  id: string;
  name: string;
  isOwner: boolean;
  quickLeave?: boolean; // Set by quickleave beacon — use short grace on disconnect
}

// Player info stored during reconnection grace period.
export interface DisconnectedPlayer {
  id: string;
  name: string;
  isOwner: boolean;
  disconnectedAt: number;
  graceMs: number; // Grace period duration (short for quickleave, long for normal)
}
