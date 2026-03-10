import { useRef, useCallback, useEffect } from "react";
import type { ClientMessage, S_Draw, SerializedStroke } from "../types/protocol";
import type { ToolMode } from "../components/Toolbar";

interface UseCanvasOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  color: string;
  lineWidth: number;
  tool: ToolMode;
  send: (msg: ClientMessage) => void;
}

export function useCanvas({ canvasRef, isDrawer, color, lineWidth, tool, send }: UseCanvasOptions) {
  const isDrawingRef = useRef(false);
  const strokesRef = useRef<SerializedStroke[]>([]);
  // Track current in-progress stroke for both local and remote drawing
  const currentStrokeRef = useRef<{ points: { x: number; y: number }[]; color: string; lineWidth: number } | null>(null);

  // Setup canvas drawing events
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!isDrawer || tool === "text") return;

    const normalize = (e: MouseEvent) => ({
      x: e.offsetX / canvas.width,
      y: e.offsetY / canvas.height,
    });

    const normalizeTouchEvent = (e: TouchEvent) => {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0] || e.changedTouches[0];
      return {
        x: (touch.clientX - rect.left) / rect.width,
        y: (touch.clientY - rect.top) / rect.height,
        offsetX: touch.clientX - rect.left,
        offsetY: touch.clientY - rect.top,
      };
    };

    const onMouseDown = (e: MouseEvent) => {
      isDrawingRef.current = true;
      const { x, y } = normalize(e);
      ctx.beginPath();
      ctx.moveTo(e.offsetX, e.offsetY);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      currentStrokeRef.current = { points: [{ x, y }], color, lineWidth };
      send({ type: "draw", action: "start", x, y, color, lineWidth });
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      const { x, y } = normalize(e);
      ctx.lineTo(e.offsetX, e.offsetY);
      ctx.stroke();
      currentStrokeRef.current?.points.push({ x, y });
      send({ type: "draw", action: "move", x, y, color, lineWidth });
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      const { x, y } = normalize(e);
      ctx.lineTo(e.offsetX, e.offsetY);
      ctx.stroke();
      if (currentStrokeRef.current) {
        currentStrokeRef.current.points.push({ x, y });
        strokesRef.current.push(currentStrokeRef.current as SerializedStroke);
        currentStrokeRef.current = null;
      }
      send({ type: "draw", action: "end", x, y, color, lineWidth });
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      isDrawingRef.current = true;
      const { x, y, offsetX, offsetY } = normalizeTouchEvent(e);
      ctx.beginPath();
      ctx.moveTo(offsetX, offsetY);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      currentStrokeRef.current = { points: [{ x, y }], color, lineWidth };
      send({ type: "draw", action: "start", x, y, color, lineWidth });
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!isDrawingRef.current) return;
      const { x, y, offsetX, offsetY } = normalizeTouchEvent(e);
      ctx.lineTo(offsetX, offsetY);
      ctx.stroke();
      currentStrokeRef.current?.points.push({ x, y });
      send({ type: "draw", action: "move", x, y, color, lineWidth });
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      const { x, y, offsetX, offsetY } = normalizeTouchEvent(e);
      ctx.lineTo(offsetX, offsetY);
      ctx.stroke();
      if (currentStrokeRef.current) {
        currentStrokeRef.current.points.push({ x, y });
        strokesRef.current.push(currentStrokeRef.current as SerializedStroke);
        currentStrokeRef.current = null;
      }
      send({ type: "draw", action: "end", x, y, color, lineWidth });
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd, { passive: false });

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, [canvasRef, isDrawer, color, lineWidth, tool, send]);

  // Replay a single draw event from remote — also track strokes
  const replayDraw = useCallback(
    (msg: S_Draw) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const cx = msg.x * canvas.width;
      const cy = msg.y * canvas.height;

      if (msg.action === "start") {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.strokeStyle = msg.color;
        ctx.lineWidth = msg.lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        currentStrokeRef.current = { points: [{ x: msg.x, y: msg.y }], color: msg.color, lineWidth: msg.lineWidth };
      } else if (msg.action === "move") {
        ctx.lineTo(cx, cy);
        ctx.stroke();
        currentStrokeRef.current?.points.push({ x: msg.x, y: msg.y });
      } else if (msg.action === "end") {
        ctx.lineTo(cx, cy);
        ctx.stroke();
        if (currentStrokeRef.current) {
          currentStrokeRef.current.points.push({ x: msg.x, y: msg.y });
          strokesRef.current.push(currentStrokeRef.current as SerializedStroke);
          currentStrokeRef.current = null;
        }
      }
    },
    [canvasRef],
  );

  // Draw a single text stroke on the canvas
  const drawTextStroke = useCallback(
    (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, stroke: SerializedStroke) => {
      if (!stroke.text || stroke.points.length === 0) return;
      const fontSize = (stroke.fontSize || 24) * (canvas.width / 800);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = stroke.color;
      ctx.textBaseline = "top";
      const px = stroke.points[0].x * canvas.width;
      const py = stroke.points[0].y * canvas.height;
      ctx.fillText(stroke.text, px, py);
    },
    [],
  );

  // Replay all strokes (on join, undo, or resize)
  const replayAll = useCallback(
    (strokes: SerializedStroke[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      strokesRef.current = strokes;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const stroke of strokes) {
        if (stroke.text) {
          drawTextStroke(ctx, canvas, stroke);
          continue;
        }
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < stroke.points.length; i++) {
          const px = stroke.points[i].x * canvas.width;
          const py = stroke.points[i].y * canvas.height;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    },
    [canvasRef, drawTextStroke],
  );

  // Clear canvas
  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokesRef.current = [];
  }, [canvasRef]);

  // Add a text stroke to the canvas
  const addTextStroke = useCallback(
    (text: string, x: number, y: number, textColor: string, fontSize: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const stroke: SerializedStroke = {
        points: [{ x, y }],
        color: textColor,
        lineWidth: 0,
        text,
        fontSize,
      };
      drawTextStroke(ctx, canvas, stroke);
      strokesRef.current.push(stroke);
    },
    [canvasRef, drawTextStroke],
  );

  return { replayDraw, replayAll, clearCanvas, addTextStroke, strokesRef };
}
