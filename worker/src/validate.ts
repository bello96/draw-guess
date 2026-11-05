// 客户端消息的入口校验。WebSocket 上来的都是不可信数据：先在这里校验类型和范围、
// 只保留认识的字段，handler 拿到的就是干净的消息。纯函数，不碰 DO 状态。
//
// 范围要放得足够宽：合法客户端的消息被丢弃会让它和服务端分叉，比放过一点异常值更糟。
// 改这里的边界前，先看前端实际能发出什么值（useCanvas.ts、Canvas.tsx、Toolbar.tsx）。

import {
  MAX_COORDINATE,
  MAX_DELETE_STROKES,
  MAX_FONT_SIZE,
  MAX_ID_LENGTH,
  MAX_LINE_WIDTH,
  MAX_MESSAGE_LENGTH,
  MAX_SELECTION_EXTENT,
  MAX_STROKE_PATH,
  MAX_STROKE_POINTS,
  MAX_TEXT_COLOR_RANGES,
  MAX_TEXT_STROKE_LENGTH,
  MAX_TOLERANCE,
} from "./constants";
import { pathLength } from "./helpers";
import type { BrushType, SerializedStroke, ShapeKind, TextColorRange } from "./types";

type Point = { x: number; y: number };

export interface JoinMessage {
  type: "join";
  playerName: string;
  playerId?: string;
  // 客户端生成的重连凭证，见 GameRoom.ownsIdentity。旧客户端不带。
  playerToken?: string;
  v?: number;
}

export interface DrawMessage {
  type: "draw";
  action: "start" | "move" | "end";
  x: number;
  y: number;
  color: string;
  lineWidth: number;
  brushType?: BrushType;
  points?: Point[];
  stroke?: SerializedStroke;
}

export interface TextStrokeMessage {
  type: "textStroke";
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
  colorRanges?: TextColorRange[];
}

export interface ShapeMessage {
  type: "shape";
  shape: ShapeKind;
  filled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  lineWidth: number;
}

export interface FillMessage {
  type: "fill";
  x: number;
  y: number;
  color: string;
  tolerance: number;
}

export interface SelectionMessage {
  type: "selection";
  srcX: number;
  srcY: number;
  w: number;
  h: number;
  dstX: number;
  dstY: number;
}

export type ClientMessage =
  | JoinMessage
  | DrawMessage
  | TextStrokeMessage
  | ShapeMessage
  | FillMessage
  | SelectionMessage
  | { type: "deleteStrokes"; indices: number[] }
  | { type: "setAnswer"; answer: string }
  | { type: "guess"; text: string }
  | { type: "chat"; text: string }
  | { type: "transfer"; targetId?: string }
  | { type: "ping" | "clear" | "undo" | "redo" | "claimDrawer" | "continueDrawing" | "leave" };

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const BRUSH_TYPES: readonly BrushType[] = ["pen", "airbrush", "crayon", "watercolor"];
const SHAPE_KINDS: readonly ShapeKind[] = [
  "rect",
  "ellipse",
  "arrow",
  "line",
  "triangle",
  "star",
  "heart",
];

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

// 归一化坐标不限制在 0~1：鼠标滑出画布、编辑框拖到画布外都会越界
function isCoordinate(v: unknown): v is number {
  return inRange(v, -MAX_COORDINATE, MAX_COORDINATE);
}

function isColor(v: unknown): v is string {
  return typeof v === "string" && HEX_COLOR.test(v);
}

function isLineWidth(v: unknown): v is number {
  return inRange(v, 0, MAX_LINE_WIDTH);
}

function parseBrushType(v: unknown): BrushType | undefined {
  return BRUSH_TYPES.includes(v as BrushType) ? (v as BrushType) : undefined;
}

function parsePoints(v: unknown): Point[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_STROKE_POINTS) {
    return null;
  }
  const points: Point[] = [];
  for (const p of v) {
    if (!p || typeof p !== "object" || !isCoordinate(p.x) || !isCoordinate(p.y)) {
      return null;
    }
    points.push({ x: p.x, y: p.y });
  }
  return points;
}

/** draw end 携带的整笔。非法时返回 undefined，调用方当作没带（回退到 start / move 的缓存）。 */
function parseStroke(v: unknown): SerializedStroke | undefined {
  if (!v || typeof v !== "object") {
    return undefined;
  }
  const raw = v as Record<string, unknown>;
  const points = parsePoints(raw.points);
  if (!points || !isColor(raw.color) || !isLineWidth(raw.lineWidth)) {
    return undefined;
  }
  if (pathLength(points) > MAX_STROKE_PATH) {
    return undefined;
  }
  const brushType = parseBrushType(raw.brushType);
  return {
    points,
    color: raw.color,
    lineWidth: raw.lineWidth,
    // 默认 pen 不写字段（保持 wire 紧凑、和老 stroke 一致）
    ...(brushType && brushType !== "pen" ? { brushType } : {}),
  };
}

function parseDraw(m: Record<string, unknown>): DrawMessage | null {
  const { action, x, y, color, lineWidth } = m;
  if (action !== "start" && action !== "move" && action !== "end") {
    return null;
  }
  if (!isCoordinate(x) || !isCoordinate(y) || !isColor(color) || !isLineWidth(lineWidth)) {
    return null;
  }
  const draw: DrawMessage = { type: "draw", action, x, y, color, lineWidth };
  if (action === "start") {
    draw.brushType = parseBrushType(m.brushType);
  } else if (action === "move" && m.points !== undefined) {
    const points = parsePoints(m.points);
    if (!points) {
      return null;
    }
    draw.points = points;
  } else if (action === "end") {
    draw.stroke = parseStroke(m.stroke);
  }
  return draw;
}

// 局部上色区间：逐项检查，非法项丢弃；引用被截断文本之外的区间一并丢弃。
function parseColorRanges(v: unknown, textLength: number): TextColorRange[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const ranges: TextColorRange[] = [];
  for (const r of v.slice(0, MAX_TEXT_COLOR_RANGES)) {
    if (
      r &&
      typeof r === "object" &&
      Number.isInteger(r.start) &&
      Number.isInteger(r.end) &&
      isColor(r.color) &&
      r.start >= 0 &&
      r.end <= textLength &&
      r.start < r.end
    ) {
      ranges.push({ start: r.start, end: r.end, color: r.color });
    }
  }
  return ranges.length > 0 ? ranges : undefined;
}

function parseTextStroke(m: Record<string, unknown>): TextStrokeMessage | null {
  const { x, y, color, fontSize } = m;
  if (typeof m.text !== "string") {
    return null;
  }
  const text = m.text.slice(0, MAX_TEXT_STROKE_LENGTH);
  if (!text || !isCoordinate(x) || !isCoordinate(y) || !isColor(color)) {
    return null;
  }
  if (!inRange(fontSize, 1, MAX_FONT_SIZE)) {
    return null;
  }
  const colorRanges = parseColorRanges(m.colorRanges, text.length);
  return {
    type: "textStroke",
    text,
    x,
    y,
    color,
    fontSize,
    ...(colorRanges ? { colorRanges } : {}),
  };
}

function parseShape(m: Record<string, unknown>): ShapeMessage | null {
  const { shape, x, y, width, height, color, lineWidth } = m;
  if (!SHAPE_KINDS.includes(shape as ShapeKind)) {
    return null;
  }
  if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height)) {
    return null;
  }
  if (!isColor(color) || !isLineWidth(lineWidth)) {
    return null;
  }
  return {
    type: "shape",
    shape: shape as ShapeKind,
    filled: m.filled === true,
    x,
    y,
    width,
    height,
    color,
    lineWidth,
  };
}

function parseFill(m: Record<string, unknown>): FillMessage | null {
  const { x, y, color, tolerance } = m;
  if (!isCoordinate(x) || !isCoordinate(y) || !isColor(color)) {
    return null;
  }
  if (!inRange(tolerance, 0, MAX_TOLERANCE)) {
    return null;
  }
  return { type: "fill", x, y, color, tolerance };
}

// 框选只能从画布内开始（尺寸决定渲染时临时画布的大小，必须严格限制）；
// 落点可以拖到画布外，所以 dst 只按普通坐标限制。
function parseSelection(m: Record<string, unknown>): SelectionMessage | null {
  const { srcX, srcY, w, h, dstX, dstY } = m;
  const margin = MAX_SELECTION_EXTENT - 1;
  if (
    !inRange(srcX, -margin, MAX_SELECTION_EXTENT) ||
    !inRange(srcY, -margin, MAX_SELECTION_EXTENT)
  ) {
    return null;
  }
  if (!inRange(w, 0, MAX_SELECTION_EXTENT) || !inRange(h, 0, MAX_SELECTION_EXTENT)) {
    return null;
  }
  if (!isCoordinate(dstX) || !isCoordinate(dstY)) {
    return null;
  }
  return { type: "selection", srcX, srcY, w, h, dstX, dstY };
}

function parseDeleteStrokes(m: Record<string, unknown>): ClientMessage | null {
  const { indices } = m;
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > MAX_DELETE_STROKES) {
    return null;
  }
  if (!indices.every((i) => Number.isInteger(i))) {
    return null;
  }
  return { type: "deleteStrokes", indices: indices as number[] };
}

function parseId(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH ? v : undefined;
}

function parseJoin(m: Record<string, unknown>): JoinMessage {
  const join: JoinMessage = {
    type: "join",
    playerName: typeof m.playerName === "string" ? m.playerName : "",
  };
  const playerId = parseId(m.playerId);
  if (playerId) {
    join.playerId = playerId;
  }
  // 空的和过长的 token 都当没带
  const playerToken = parseId(m.playerToken);
  if (playerToken) {
    join.playerToken = playerToken;
  }
  if (typeof m.v === "number") {
    join.v = m.v;
  }
  return join;
}

/** 这条消息会不会写存储（draw 只有 end 落盘）。限流用，判断可以比实际宽一点。 */
export function writesStorage(msg: ClientMessage): boolean {
  switch (msg.type) {
    case "draw":
      return msg.action === "end";
    case "join":
    case "ping":
    case "leave":
      return false;
    default:
      return true;
  }
}

/** 解析并清洗一条客户端消息。不认识或不合法时返回 null，调用方直接丢弃。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const m = parsed as Record<string, unknown>;
  switch (m.type) {
    case "join":
      return parseJoin(m);
    case "draw":
      return parseDraw(m);
    case "textStroke":
      return parseTextStroke(m);
    case "shape":
      return parseShape(m);
    case "fill":
      return parseFill(m);
    case "selection":
      return parseSelection(m);
    case "deleteStrokes":
      return parseDeleteStrokes(m);
    case "setAnswer":
      return typeof m.answer === "string" ? { type: "setAnswer", answer: m.answer } : null;
    case "guess":
      return typeof m.text === "string" ? { type: "guess", text: m.text } : null;
    case "chat":
      return typeof m.text === "string" ? { type: "chat", text: m.text } : null;
    case "transfer":
      if (m.targetId === undefined) {
        return { type: "transfer" };
      }
      return parseId(m.targetId) ? { type: "transfer", targetId: m.targetId as string } : null;
    case "ping":
    case "clear":
    case "undo":
    case "redo":
    case "claimDrawer":
    case "continueDrawing":
    case "leave":
      return { type: m.type };
    default:
      return null;
  }
}
