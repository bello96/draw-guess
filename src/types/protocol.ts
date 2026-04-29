// ============ Shared Types ============

/**
 * Wire protocol version.
 *
 * Bump only on **breaking** changes:
 * - removing a message type / required field
 * - changing the type or semantics of an existing field
 *
 * Non-breaking (do NOT bump):
 * - adding a new message type
 * - adding an optional field
 *
 * Keep in sync with `PROTOCOL_VERSION` in `worker/src/room.ts`.
 * Clients send `v` in their `join` message; server rejects mismatched versions.
 */
export const PROTOCOL_VERSION = 1;

export type GamePhase = "waiting" | "drawing" | "guessing" | "revealed";

/**
 * Pen 工具的笔型。null/undefined 等价 "pen"（默认普通画笔），让缺字段的旧客户端
 * 自动落到 pen 渲染，所以加这个字段不算 breaking change。
 *  - pen        : 实心实色单笔画（旧行为）
 *  - airbrush   : 沿路径喷洒散点 + 半径方向密度衰减
 *  - crayon     : 沿路径加颗粒纹理 + 不均匀填充
 *  - watercolor : 多次半透明描边叠加，呈柔边水彩感
 */
export type BrushType = "pen" | "airbrush" | "crayon" | "watercolor";

export interface PlayerInfo {
  id: string;
  name: string;
  isOwner: boolean;
}

export interface SerializedStroke {
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  // Pen 笔型（仅 pen 笔画有意义；空值视作 "pen"）
  brushType?: BrushType;
  // Text stroke fields (optional)
  text?: string;
  fontSize?: number;
  // Shape stroke fields (optional).
  // - rect/ellipse/triangle/star/heart: points = [topLeft, bottomRight] (normalized, min→max)
  // - arrow/line:                       points = [start, end]           (normalized; arrow preserves direction)
  shape?: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
  filled?: boolean; // meaningful for rect / ellipse / triangle / star / heart
  // Bucket-fill stroke (flood fill from a seed point).
  // When present: points = [{ x, y }] normalized seed, color = fill color.
  fill?: { tolerance: number };
  // Selection-move stroke: copy pixels from src rect, whiten src, paste at dst.
  // All values normalized 0..1 relative to canvas.
  selection?: {
    srcX: number;
    srcY: number;
    w: number;
    h: number;
    dstX: number;
    dstY: number;
  };
}

// ============ Client → Server Messages ============

export interface C_Join {
  type: "join";
  playerName: string;
  playerId?: string; // For reconnection — reuse previous player ID
  v?: number; // Protocol version — server rejects mismatched clients
}

export interface C_Draw {
  type: "draw";
  action: "start" | "move" | "end";
  x: number;
  y: number;
  color: string;
  lineWidth: number;
  // Pen 笔型（仅在 action="start" 时由发送方填一次；老客户端缺该字段时服务端按 "pen" 处理）。
  brushType?: BrushType;
  // Optional batched points for 'move' action (RAF-throttled).
  // When present, server appends all points; x/y is redundantly the last one.
  points?: { x: number; y: number }[];
}

export interface C_Clear {
  type: "clear";
}

export interface C_Undo {
  type: "undo";
}

export interface C_Redo {
  type: "redo";
}

export interface C_SetAnswer {
  type: "setAnswer";
  answer: string;
}

export interface C_Guess {
  type: "guess";
  text: string;
}

export interface C_Chat {
  type: "chat";
  text: string;
}

export interface C_Transfer {
  type: "transfer";
  targetId?: string; // 3+ 人模式必须；缺省时服务端按"非自己第一个"处理
}

export interface C_TextStroke {
  type: "textStroke";
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
}

export interface C_Shape {
  type: "shape";
  shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
  filled: boolean;
  // For rect/ellipse/triangle/star/heart: (x,y) is top-left, width/height ≥ 0
  // For arrow/line:                       (x,y) is start point; width/height may be negative (end - start)
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  lineWidth: number;
}

export interface C_Fill {
  type: "fill";
  x: number; // normalized seed, 0..1
  y: number;
  color: string;
  tolerance: number; // per-channel RGB diff threshold
}

export interface C_Selection {
  type: "selection";
  srcX: number; // all normalized 0..1
  srcY: number;
  w: number;
  h: number;
  dstX: number;
  dstY: number;
}

export interface C_ContinueDrawing {
  type: "continueDrawing";
}

export interface C_ClaimDrawer {
  type: "claimDrawer";
}

export interface C_Leave {
  type: "leave";
}

export interface C_Ping {
  type: "ping";
}

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

// ============ Chat History (persisted on server for replay) ============

export interface ChatHistoryEntry {
  kind: "chat" | "guess";
  playerId: string;
  playerName: string;
  text: string;
  timestamp: number;
  correct?: boolean;
}

// ============ Server → Client Messages ============

export interface S_RoomState {
  type: "roomState";
  roomCode: string;
  players: PlayerInfo[];
  drawerId: string;
  phase: GamePhase;
  answerLength?: number;
  answer?: string; // Only sent to the drawer
  strokes: SerializedStroke[];
  chatHistory?: ChatHistoryEntry[];
  yourId: string;
  maxPlayers?: number;
  pendingPromotionId?: string;
}

export interface S_PlayerJoined {
  type: "playerJoined";
  player: PlayerInfo;
}

export interface S_PlayerLeft {
  type: "playerLeft";
  playerId: string;
}

export interface S_Draw {
  type: "draw";
  action: "start" | "move" | "end";
  x: number;
  y: number;
  color: string;
  lineWidth: number;
  // Pen 笔型（服务端把 start 上的 brushType 透传到所有 action 让对端无须缓存）。
  brushType?: BrushType;
  // Batched move points (same semantics as client side).
  points?: { x: number; y: number }[];
}

export interface S_Clear {
  type: "clear";
}

export interface S_Undo {
  type: "undo";
}

export interface S_Redo {
  type: "redo";
}

export interface S_PhaseChange {
  type: "phaseChange";
  phase: GamePhase;
  drawerId: string;
  answerLength?: number;
  answer?: string;
  pendingPromotionId?: string;
}

export interface S_GuessResult {
  type: "guessResult";
  playerId: string;
  playerName: string;
  text: string;
  correct: boolean;
}

export interface S_Chat {
  type: "chat";
  playerId: string;
  playerName: string;
  text: string;
  timestamp: number;
}

export interface S_TextStroke {
  type: "textStroke";
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
}

export interface S_Shape {
  type: "shape";
  shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
  filled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  lineWidth: number;
}

export interface S_Fill {
  type: "fill";
  x: number;
  y: number;
  color: string;
  tolerance: number;
}

export interface S_Selection {
  type: "selection";
  srcX: number;
  srcY: number;
  w: number;
  h: number;
  dstX: number;
  dstY: number;
}

export interface S_TransferDone {
  type: "transferDone";
  newDrawerId: string;
}

export interface S_Error {
  type: "error";
  message: string;
}

export interface S_RoomClosed {
  type: "roomClosed";
  reason: string;
}

export interface S_Pong {
  type: "pong";
}

export type ServerMessage =
  | S_RoomState
  | S_PlayerJoined
  | S_PlayerLeft
  | S_Draw
  | S_Clear
  | S_Undo
  | S_Redo
  | S_PhaseChange
  | S_GuessResult
  | S_Chat
  | S_TextStroke
  | S_Shape
  | S_Fill
  | S_Selection
  | S_TransferDone
  | S_Error
  | S_RoomClosed
  | S_Pong;

// ============ Frontend State ============

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  timestamp: number;
  kind: "chat" | "guess" | "system";
  correct?: boolean;
}
