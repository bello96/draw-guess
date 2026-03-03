// ============ Shared Types ============

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
}

// ============ Client → Server Messages ============

export interface C_Join {
  type: "join";
  playerName: string;
}

export interface C_Draw {
  type: "draw";
  action: "start" | "move" | "end";
  x: number;
  y: number;
  color: string;
  lineWidth: number;
}

export interface C_Clear {
  type: "clear";
}

export interface C_Undo {
  type: "undo";
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
}

export type ClientMessage =
  | C_Join
  | C_Draw
  | C_Clear
  | C_Undo
  | C_SetAnswer
  | C_Guess
  | C_Chat
  | C_Transfer;

// ============ Server → Client Messages ============

export interface S_RoomState {
  type: "roomState";
  roomCode: string;
  players: PlayerInfo[];
  drawerId: string;
  phase: GamePhase;
  answerLength?: number;
  strokes: SerializedStroke[];
  yourId: string;
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
}

export interface S_Clear {
  type: "clear";
}

export interface S_Undo {
  type: "undo";
}

export interface S_PhaseChange {
  type: "phaseChange";
  phase: GamePhase;
  drawerId: string;
  answerLength?: number;
  answer?: string;
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

export type ServerMessage =
  | S_RoomState
  | S_PlayerJoined
  | S_PlayerLeft
  | S_Draw
  | S_Clear
  | S_Undo
  | S_PhaseChange
  | S_GuessResult
  | S_Chat
  | S_TransferDone
  | S_Error
  | S_RoomClosed;

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
