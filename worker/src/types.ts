// Shared types for the GameRoom Durable Object.
// Not imported by the frontend — that uses src/types/protocol.ts. Some shapes
// overlap (PlayerInfo, SerializedStroke, ChatHistoryEntry) but duplicating
// keeps the worker self-contained and avoids cross-package imports.

export type GamePhase = "waiting" | "drawing" | "guessing" | "revealed";

export interface PlayerInfo {
  id: string;
  name: string;
  isOwner: boolean;
  // false = 断线中（重连保留期内，仍算在房间里）
  connected?: boolean;
}

export type BrushType = "pen" | "airbrush" | "crayon" | "watercolor";

export type ShapeKind = "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";

// 文本局部上色区间（镜像 src/types/protocol.ts 的 TextColorRange）
export interface TextColorRange {
  start: number;
  end: number;
  color: string;
}

export interface SerializedStroke {
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  // Pen 笔型（pen 笔画专用；缺值视作 "pen"）
  brushType?: BrushType;
  // Text stroke fields (optional)
  text?: string;
  fontSize?: number;
  colorRanges?: TextColorRange[];
  // Shape stroke fields (optional).
  // - rect/ellipse/triangle/star/heart: points = [topLeft, bottomRight] (min→max)
  // - arrow/line:                       points = [start, end] (direction preserved for arrow; irrelevant for line)
  shape?: ShapeKind;
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
  // 重连凭证。id 会广播给所有人，不能当凭证；token 由客户端生成，只有它自己和服务端知道。
  // 缺省表示玩家用的是不认识 token 的旧客户端，见 GameRoom.ownsIdentity。
  token?: string;
  quickLeaveAt?: number; // Set by quickleave beacon — use short grace if the close follows soon
}

// 名册里每个玩家的身份信息。attachment 跟着连接走，实例崩溃时连接和 close 事件都没了，
// 只有存在存储里的这份能把人恢复回来。
export interface RosterEntry {
  name: string;
  token?: string;
}

// 连上了但还没发 join 的连接。记下接入时间，超时清理要用。
export interface UnjoinedAttachment {
  unjoinedSince: number;
}

// Player info stored during reconnection grace period.
export interface DisconnectedPlayer {
  id: string;
  name: string;
  token?: string; // 同 PlayerAttachment.token
  disconnectedAt: number;
  graceMs: number; // Grace period duration (short for quickleave, long for normal)
}
