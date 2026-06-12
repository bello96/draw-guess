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

export type BrushType = "pen" | "airbrush" | "crayon" | "watercolor";

export interface SerializedStroke {
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  // Pen 笔型（pen 笔画专用；缺值视作 "pen"）
  brushType?: BrushType;
  // Text stroke fields (optional)
  text?: string;
  fontSize?: number;
  // 文本局部上色区间（镜像 src/types/protocol.ts 的 TextColorRange）
  colorRanges?: { start: number; end: number; color: string }[];
  // Shape stroke fields (optional).
  // - rect/ellipse/triangle/star/heart: points = [topLeft, bottomRight] (min→max)
  // - arrow/line:                       points = [start, end] (direction preserved for arrow; irrelevant for line)
  shape?: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
  filled?: boolean; // meaningful for rect / ellipse / triangle / star / heart
  // Bucket-fill stroke: points = [{ x, y }] seed, color = fill color.
  fill?: { tolerance: number };
  // Selection-move stroke: copy src rect → whiten src → paste at dst (normalized).
  selection?: {
    srcX: number;
    srcY: number;
    w: number;
    h: number;
    dstX: number;
    dstY: number;
  };
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
  quickLeave?: boolean; // Set by quickleave beacon — use short grace on disconnect
}

// Player info stored during reconnection grace period.
export interface DisconnectedPlayer {
  id: string;
  name: string;
  disconnectedAt: number;
  graceMs: number; // Grace period duration (short for quickleave, long for normal)
}
