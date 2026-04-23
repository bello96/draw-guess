import { useRef, useCallback, useEffect } from "react";
import type { ClientMessage, S_Draw, SerializedStroke } from "../types/protocol";
import type { FillMode, ToolMode } from "../components/Toolbar";

type Point = { x: number; y: number };

/** Raw shape data emitted by the shape/arrow tool on mouseup (before commit). */
export interface DrawnShape {
  shape: "rect" | "ellipse" | "arrow";
  filled: boolean;
  /**
   * Raw pixel points in canvas-element space. Semantics:
   * - rect/ellipse: bounding box corners (order doesn't matter; consumers take min/max)
   * - arrow:        p0 = start, p1 = end (direction matters — the arrow head is at p1)
   */
  points: [Point, Point];
  /** Normalized (0..1) counterparts of the points above — used for send / persistence. */
  normalizedPoints: [Point, Point];
  color: string;
  lineWidth: number;
}

interface UseCanvasOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  color: string;
  lineWidth: number;
  tool: ToolMode;
  fillMode: FillMode;
  send: (msg: ClientMessage) => void;
  /** Mouseup after dragging a shape/arrow — hook does NOT commit; upstream handles it. */
  onShapeDrawn?: (shape: DrawnShape) => void;
  /** Fired when a local pen stroke finishes (commit path without editing-overlay). */
  onLocalPenEnd?: () => void;
}

// Reference canvas dimensions (4:3) for lineWidth scaling and offscreen cache
// resolution. lineWidth values in the protocol are authored against this width;
// text fontSize likewise.
const REF_WIDTH = 800;
const REF_HEIGHT = 600;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.5;

export function scaleLineWidth(baseWidth: number, canvasWidth: number): number {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, canvasWidth / REF_WIDTH));
  return baseWidth * scale;
}

/** Draw an arrow (line + triangle head) in pixel coords onto the given ctx. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  scaledLineWidth: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    return;
  }
  const ux = dx / dist;
  const uy = dy / dist;
  // Head proportional to line width, with a sensible minimum.
  const headLen = Math.max(scaledLineWidth * 4, 12);
  const headWidth = headLen * 0.8;
  // Back off the line end so it doesn't peek through the filled triangle.
  const backed = Math.min(headLen * 0.75, dist);
  const lineEndX = x1 - ux * backed;
  const lineEndY = y1 - uy * backed;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = scaledLineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(lineEndX, lineEndY);
  ctx.stroke();

  // Filled triangle at the tip
  const baseX = x1 - ux * headLen;
  const baseY = y1 - uy * headLen;
  const perpX = -uy * (headWidth / 2);
  const perpY = ux * (headWidth / 2);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(baseX + perpX, baseY + perpY);
  ctx.lineTo(baseX - perpX, baseY - perpY);
  ctx.closePath();
  ctx.fill();
}

/** Render a single stroke onto an arbitrary context (visible canvas or offscreen). */
function renderStrokeToCtx(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  stroke: SerializedStroke,
): void {
  // Shape strokes: rect / ellipse / arrow
  if (stroke.shape === "rect" || stroke.shape === "ellipse" || stroke.shape === "arrow") {
    if (stroke.points.length < 2) {
      return;
    }
    const [p0, p1] = stroke.points;
    const lw = scaleLineWidth(stroke.lineWidth, canvas.width);

    if (stroke.shape === "arrow") {
      drawArrow(
        ctx,
        p0.x * canvas.width,
        p0.y * canvas.height,
        p1.x * canvas.width,
        p1.y * canvas.height,
        stroke.color,
        lw,
      );
      return;
    }

    // rect/ellipse — bbox corners, order doesn't matter
    const x = Math.min(p0.x, p1.x) * canvas.width;
    const y = Math.min(p0.y, p1.y) * canvas.height;
    const w = Math.abs(p1.x - p0.x) * canvas.width;
    const h = Math.abs(p1.y - p0.y) * canvas.height;
    if (w === 0 || h === 0) {
      return;
    }
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (stroke.shape === "rect") {
      if (stroke.filled) {
        ctx.fillRect(x, y, w, h);
      } else {
        ctx.strokeRect(x, y, w, h);
      }
    } else {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (stroke.filled) {
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }
    return;
  }

  // Text stroke
  if (stroke.text) {
    if (stroke.points.length === 0) {
      return;
    }
    const fontSize = (stroke.fontSize || 24) * (canvas.width / REF_WIDTH);
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = stroke.color;
    ctx.textBaseline = "top";
    const px = stroke.points[0].x * canvas.width;
    const py = stroke.points[0].y * canvas.height;
    const lineHeight = fontSize * 1.2;
    const lines = stroke.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], px, py + i * lineHeight);
    }
    return;
  }

  // Freehand pen stroke
  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = scaleLineWidth(stroke.lineWidth, canvas.width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < stroke.points.length; i++) {
    const px = stroke.points[i].x * canvas.width;
    const py = stroke.points[i].y * canvas.height;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}

/** Draw a live preview of an in-progress shape/arrow onto the visible context. */
function drawShapePreview(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  start: Point,
  end: Point,
  color: string,
  lineWidth: number,
  shape: "rect" | "ellipse" | "arrow",
  filled: boolean,
): void {
  const lw = scaleLineWidth(lineWidth, canvas.width);

  if (shape === "arrow") {
    drawArrow(
      ctx,
      start.x * canvas.width,
      start.y * canvas.height,
      end.x * canvas.width,
      end.y * canvas.height,
      color,
      lw,
    );
    return;
  }

  const x = Math.min(start.x, end.x) * canvas.width;
  const y = Math.min(start.y, end.y) * canvas.height;
  const w = Math.abs(end.x - start.x) * canvas.width;
  const h = Math.abs(end.y - start.y) * canvas.height;
  if (w === 0 || h === 0) {
    return;
  }
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (shape === "rect") {
    if (filled) {
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.strokeRect(x, y, w, h);
    }
  } else {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (filled) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
}

export function useCanvas({
  canvasRef,
  isDrawer,
  color,
  lineWidth,
  tool,
  fillMode,
  send,
  onShapeDrawn,
  onLocalPenEnd,
}: UseCanvasOptions) {
  const isDrawingRef = useRef(false);
  const strokesRef = useRef<SerializedStroke[]>([]);
  const currentStrokeRef = useRef<{
    points: Point[];
    color: string;
    lineWidth: number;
  } | null>(null);
  const pendingPointsRef = useRef<Point[]>([]);
  const rafIdRef = useRef<number | null>(null);

  // Offscreen canvas — single source of truth for committed strokes.
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  if (offscreenRef.current === null && typeof document !== "undefined") {
    const off = document.createElement("canvas");
    off.width = REF_WIDTH;
    off.height = REF_HEIGHT;
    offscreenRef.current = off;
  }

  const commitToOffscreen = useCallback((stroke: SerializedStroke) => {
    const offs = offscreenRef.current;
    if (!offs) {
      return;
    }
    const offCtx = offs.getContext("2d");
    if (!offCtx) {
      return;
    }
    renderStrokeToCtx(offCtx, offs, stroke);
  }, []);

  const syncVisibleFromOffscreen = useCallback(() => {
    const canvas = canvasRef.current;
    const offs = offscreenRef.current;
    if (!canvas || !offs) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offs, 0, 0, canvas.width, canvas.height);
  }, [canvasRef]);

  const rebuildOffscreen = useCallback((strokes: SerializedStroke[]) => {
    const offs = offscreenRef.current;
    if (!offs) {
      return;
    }
    const offCtx = offs.getContext("2d");
    if (!offCtx) {
      return;
    }
    offCtx.clearRect(0, 0, offs.width, offs.height);
    for (const stroke of strokes) {
      renderStrokeToCtx(offCtx, offs, stroke);
    }
  }, []);

  // Canvas pointer events — routed by tool
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    if (!isDrawer) {
      return;
    }
    if (tool === "text") {
      // Text tool uses a DOM overlay (handled in Canvas.tsx), not canvas events.
      return;
    }

    const normalize = (e: MouseEvent): Point => ({
      x: e.offsetX / canvas.width,
      y: e.offsetY / canvas.height,
    });

    // ========== Pen tool ==========
    if (tool === "pen") {
      const flushPendingMove = () => {
        rafIdRef.current = null;
        const points = pendingPointsRef.current;
        if (points.length === 0) {
          return;
        }
        pendingPointsRef.current = [];
        const last = points[points.length - 1];
        send({
          type: "draw",
          action: "move",
          x: last.x,
          y: last.y,
          color,
          lineWidth,
          points,
        });
      };

      const scheduleFlush = () => {
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flushPendingMove);
        }
      };

      const onMouseDown = (e: MouseEvent) => {
        isDrawingRef.current = true;
        const { x, y } = normalize(e);
        ctx.beginPath();
        ctx.moveTo(e.offsetX, e.offsetY);
        ctx.strokeStyle = color;
        ctx.lineWidth = scaleLineWidth(lineWidth, canvas.width);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        currentStrokeRef.current = { points: [{ x, y }], color, lineWidth };
        send({ type: "draw", action: "start", x, y, color, lineWidth });
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!isDrawingRef.current) {
          return;
        }
        const { x, y } = normalize(e);
        ctx.lineTo(e.offsetX, e.offsetY);
        ctx.stroke();
        currentStrokeRef.current?.points.push({ x, y });
        pendingPointsRef.current.push({ x, y });
        scheduleFlush();
      };

      const onMouseUp = (e: MouseEvent) => {
        if (!isDrawingRef.current) {
          return;
        }
        isDrawingRef.current = false;
        const { x, y } = normalize(e);
        ctx.lineTo(e.offsetX, e.offsetY);
        ctx.stroke();
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push({ x, y });
          const finalized = currentStrokeRef.current as SerializedStroke;
          strokesRef.current.push(finalized);
          commitToOffscreen(finalized);
          currentStrokeRef.current = null;
        }
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        flushPendingMove();
        send({ type: "draw", action: "end", x, y, color, lineWidth });
        onLocalPenEnd?.();
      };

      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseup", onMouseUp);
      canvas.addEventListener("mouseleave", onMouseUp);

      return () => {
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("mouseup", onMouseUp);
        canvas.removeEventListener("mouseleave", onMouseUp);
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        pendingPointsRef.current = [];
      };
    }

    // ========== Shape / arrow tools ==========
    // mousedown: record start
    // mousemove: repaint visible (clear + blit offscreen + preview), never writes to offscreen
    // mouseup: emit DrawnShape — upstream holds it in editingShape state
    const filled = fillMode === "fill";
    const shapeKind: "rect" | "ellipse" | "arrow" = tool;
    let shapeStart: Point | null = null;

    const onShapeDown = (e: MouseEvent) => {
      shapeStart = normalize(e);
    };

    const onShapeMove = (e: MouseEvent) => {
      if (!shapeStart) {
        return;
      }
      const current = normalize(e);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const offs = offscreenRef.current;
      if (offs) {
        ctx.drawImage(offs, 0, 0, canvas.width, canvas.height);
      }
      drawShapePreview(ctx, canvas, shapeStart, current, color, lineWidth, shapeKind, filled);
    };

    const onShapeUp = (e: MouseEvent) => {
      if (!shapeStart) {
        return;
      }
      const start = shapeStart;
      const end = normalize(e);
      shapeStart = null;
      // Wipe the preview — editing overlay replaces it.
      syncVisibleFromOffscreen();
      // Reject tiny drags (treat as a missclick)
      const totalDist = Math.hypot(end.x - start.x, end.y - start.y);
      if (totalDist < 0.005) {
        return;
      }
      onShapeDrawn?.({
        shape: shapeKind,
        filled,
        normalizedPoints: [
          { x: start.x, y: start.y },
          { x: end.x, y: end.y },
        ],
        points: [
          { x: start.x * canvas.width, y: start.y * canvas.height },
          { x: end.x * canvas.width, y: end.y * canvas.height },
        ],
        color,
        lineWidth,
      });
    };

    const onShapeLeave = () => {
      if (!shapeStart) {
        return;
      }
      shapeStart = null;
      syncVisibleFromOffscreen();
    };

    canvas.addEventListener("mousedown", onShapeDown);
    canvas.addEventListener("mousemove", onShapeMove);
    canvas.addEventListener("mouseup", onShapeUp);
    canvas.addEventListener("mouseleave", onShapeLeave);

    return () => {
      canvas.removeEventListener("mousedown", onShapeDown);
      canvas.removeEventListener("mousemove", onShapeMove);
      canvas.removeEventListener("mouseup", onShapeUp);
      canvas.removeEventListener("mouseleave", onShapeLeave);
      if (shapeStart !== null) {
        syncVisibleFromOffscreen();
      }
    };
  }, [
    canvasRef,
    isDrawer,
    color,
    lineWidth,
    tool,
    fillMode,
    send,
    commitToOffscreen,
    syncVisibleFromOffscreen,
    onShapeDrawn,
    onLocalPenEnd,
  ]);

  // Replay a remote draw event (pen)
  const replayDraw = useCallback(
    (msg: S_Draw) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      if (msg.action === "start") {
        ctx.beginPath();
        ctx.moveTo(msg.x * canvas.width, msg.y * canvas.height);
        ctx.strokeStyle = msg.color;
        ctx.lineWidth = scaleLineWidth(msg.lineWidth, canvas.width);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        currentStrokeRef.current = {
          points: [{ x: msg.x, y: msg.y }],
          color: msg.color,
          lineWidth: msg.lineWidth,
        };
      } else if (msg.action === "move") {
        const points = msg.points ?? [{ x: msg.x, y: msg.y }];
        for (const p of points) {
          ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
        }
        ctx.stroke();
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push(...points);
        }
      } else if (msg.action === "end") {
        ctx.lineTo(msg.x * canvas.width, msg.y * canvas.height);
        ctx.stroke();
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push({ x: msg.x, y: msg.y });
          const finalized = currentStrokeRef.current as SerializedStroke;
          strokesRef.current.push(finalized);
          commitToOffscreen(finalized);
          currentStrokeRef.current = null;
        }
      }
    },
    [canvasRef, commitToOffscreen],
  );

  const replayAll = useCallback(
    (strokes: SerializedStroke[]) => {
      strokesRef.current = strokes;
      rebuildOffscreen(strokes);
      syncVisibleFromOffscreen();
    },
    [rebuildOffscreen, syncVisibleFromOffscreen],
  );

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    const offs = offscreenRef.current;
    if (offs) {
      const offCtx = offs.getContext("2d");
      if (offCtx) {
        offCtx.clearRect(0, 0, offs.width, offs.height);
      }
    }
    strokesRef.current = [];
  }, [canvasRef]);

  // Add a text stroke from remote (commit to offscreen + mirror to visible)
  const addTextStroke = useCallback(
    (text: string, x: number, y: number, textColor: string, fontSize: number) => {
      const stroke: SerializedStroke = {
        points: [{ x, y }],
        color: textColor,
        lineWidth: 0,
        text,
        fontSize,
      };
      commitToOffscreen(stroke);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          renderStrokeToCtx(ctx, canvas, stroke);
        }
      }
      strokesRef.current.push(stroke);
    },
    [canvasRef, commitToOffscreen],
  );

  /** Add a shape/arrow stroke (from local commit OR remote). Accepts normalized points. */
  const addShape = useCallback(
    (
      p0: Point,
      p1: Point,
      shapeColor: string,
      shapeLineWidth: number,
      shape: "rect" | "ellipse" | "arrow",
      filled: boolean,
    ) => {
      const stroke: SerializedStroke = {
        points: [p0, p1],
        color: shapeColor,
        lineWidth: shapeLineWidth,
        shape,
        filled,
      };
      commitToOffscreen(stroke);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          renderStrokeToCtx(ctx, canvas, stroke);
        }
      }
      strokesRef.current.push(stroke);
    },
    [canvasRef, commitToOffscreen],
  );

  return {
    replayDraw,
    replayAll,
    clearCanvas,
    addTextStroke,
    addShape,
    syncVisibleFromOffscreen,
    strokesRef,
  };
}
