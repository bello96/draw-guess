import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { tx } from "@twind/core";
import type { ToolMode } from "./Toolbar";
import { scaleLineWidth } from "../hooks/useCanvas";

type Point = { x: number; y: number };

export interface EditingText {
  text: string;
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
  fontSize: number;
}

export interface EditingShape {
  shape: "rect" | "ellipse" | "arrow";
  filled: boolean;
  /** Raw pixel points (p0, p1). For arrow: direction matters (p0 → p1). */
  points: [Point, Point];
  /** Normalized counterparts of `points`, 0..1. */
  normalizedPoints: [Point, Point];
  color: string;
  lineWidth: number;
}

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  tool?: ToolMode;
  onResize?: () => void;
  onCanvasClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  // Text editing
  editingText?: EditingText | null;
  onEditingTextUpdate?: (updates: Partial<EditingText>) => void;
  textColor?: string;
  // Shape editing
  editingShape?: EditingShape | null;
  onEditingShapeUpdate?: (updates: Partial<EditingShape>) => void;
}

/** Measure the pixel width of the longest line in a string */
function measureTextWidth(text: string, fontSize: number): number {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  if (!ctx) {
    return 60;
  }
  ctx.font = `${fontSize}px sans-serif`;
  const lines = text.split("\n");
  const maxWidth = Math.max(...lines.map((l) => ctx.measureText(l || " ").width));
  return Math.max(60, maxWidth + 8);
}

const SHAPE_OVERLAY_PADDING = 8;

const CORNERS = [
  { name: "nw", cursor: "nw-resize", style: { top: -5, left: -5 } },
  { name: "ne", cursor: "ne-resize", style: { top: -5, right: -5 } },
  { name: "sw", cursor: "sw-resize", style: { bottom: -5, left: -5 } },
  { name: "se", cursor: "se-resize", style: { bottom: -5, right: -5 } },
] as const;

/** SVG preview of an arrow inside the editing overlay. Uses `overflow: visible`
 *  so degenerate bounding boxes (horizontal/vertical arrows) still render. */
function ArrowPreviewSvg({
  start,
  end,
  bboxW,
  bboxH,
  color,
  strokeWidthPx,
}: {
  start: Point;
  end: Point;
  bboxW: number;
  bboxH: number;
  color: string;
  strokeWidthPx: number;
}) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    return null;
  }
  const ux = dx / dist;
  const uy = dy / dist;
  const headLen = Math.max(strokeWidthPx * 4, 12);
  const headWidth = headLen * 0.8;
  const backed = Math.min(headLen * 0.75, dist);
  const lineEndX = end.x - ux * backed;
  const lineEndY = end.y - uy * backed;
  const baseX = end.x - ux * headLen;
  const baseY = end.y - uy * headLen;
  const perpX = -uy * (headWidth / 2);
  const perpY = ux * (headWidth / 2);
  const trianglePoints = `${end.x},${end.y} ${baseX + perpX},${baseY + perpY} ${baseX - perpX},${baseY - perpY}`;
  return (
    <svg
      width={Math.max(bboxW, 1)}
      height={Math.max(bboxH, 1)}
      style={{ overflow: "visible", pointerEvents: "none", display: "block" }}
    >
      <line
        x1={start.x}
        y1={start.y}
        x2={lineEndX}
        y2={lineEndY}
        stroke={color}
        strokeWidth={strokeWidthPx}
        strokeLinecap="round"
      />
      <polygon points={trianglePoints} fill={color} />
    </svg>
  );
}

export default function Canvas({
  canvasRef,
  isDrawer,
  tool = "pen",
  onResize,
  onCanvasClick,
  editingText,
  onEditingTextUpdate,
  textColor = "#000000",
  editingShape,
  onEditingShapeUpdate,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const resizeRef = useRef<{
    corner: string;
    startX: number;
    startY: number;
    initialFontSize: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const shapeDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    origPoints: [Point, Point];
    origNormPoints: [Point, Point];
  } | null>(null);
  const [isShapeDragging, setIsShapeDragging] = useState(false);

  // Canvas is 4:3. Height-driven; fall back to width-driven if the container is
  // too narrow to fit 4:3 at its clientHeight.
  const RATIO_W = 4;
  const RATIO_H = 3;

  useEffect(() => {
    const resizeCanvas = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) {
        return;
      }
      const availW = container.clientWidth;
      const availH = container.clientHeight;
      let height = availH;
      let width = (height * RATIO_W) / RATIO_H;
      if (width > availW) {
        width = availW;
        height = (width * RATIO_H) / RATIO_W;
      }
      width = Math.round(width);
      height = Math.round(height);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        onResize?.();
      }
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [canvasRef, onResize]);

  // --- Text editing ---

  const displayFontSize = editingText
    ? editingText.fontSize * ((canvasRef.current?.width || 800) / 800)
    : 18;

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !editingText) {
      return;
    }
    ta.style.height = "0";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editingText?.text, displayFontSize]);

  const textareaWidth = useMemo(
    () => (editingText ? measureTextWidth(editingText.text, displayFontSize) : 60),
    [editingText?.text, displayFontSize],
  );

  const handleBorderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!editingText) {
        return;
      }
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: editingText.x,
        origY: editingText.y,
      };
      setIsDragging(true);
    },
    [editingText],
  );

  useEffect(() => {
    if (!isDragging) {
      return;
    }
    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current) {
        return;
      }
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const newX = dragRef.current.origX + dx;
      const newY = dragRef.current.origY + dy;
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        onEditingTextUpdate?.({
          x: newX,
          y: newY,
          normalizedX: newX / rect.width,
          normalizedY: newY / rect.height,
        });
      }
    };
    const handleUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, canvasRef, onEditingTextUpdate]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, corner: string) => {
      if (!editingText) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        corner,
        startX: e.clientX,
        startY: e.clientY,
        initialFontSize: editingText.fontSize,
      };
      setIsResizing(true);
    },
    [editingText],
  );

  useEffect(() => {
    if (!isResizing) {
      return;
    }
    const handleMove = (e: MouseEvent) => {
      const ref = resizeRef.current;
      if (!ref) {
        return;
      }
      const dx = e.clientX - ref.startX;
      const dy = e.clientY - ref.startY;
      let delta: number;
      switch (ref.corner) {
        case "se":
          delta = dx + dy;
          break;
        case "nw":
          delta = -dx - dy;
          break;
        case "ne":
          delta = dx - dy;
          break;
        case "sw":
          delta = -dx + dy;
          break;
        default:
          delta = 0;
      }
      const scale = Math.max(0.3, 1 + delta / 200);
      const newFontSize = Math.round(Math.max(12, Math.min(72, ref.initialFontSize * scale)));
      onEditingTextUpdate?.({ fontSize: newFontSize });
    };
    const handleUp = () => {
      resizeRef.current = null;
      setIsResizing(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isResizing, onEditingTextUpdate]);

  // --- Shape editing: drag the overlay to translate both points together ---

  const handleShapeOverlayMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!editingShape) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      shapeDragRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        origPoints: [
          { ...editingShape.points[0] },
          { ...editingShape.points[1] },
        ],
        origNormPoints: [
          { ...editingShape.normalizedPoints[0] },
          { ...editingShape.normalizedPoints[1] },
        ],
      };
      setIsShapeDragging(true);
    },
    [editingShape],
  );

  useEffect(() => {
    if (!isShapeDragging) {
      return;
    }
    const handleMove = (e: MouseEvent) => {
      const ref = shapeDragRef.current;
      if (!ref) {
        return;
      }
      const dx = e.clientX - ref.startClientX;
      const dy = e.clientY - ref.startClientY;
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const ndx = dx / rect.width;
      const ndy = dy / rect.height;
      onEditingShapeUpdate?.({
        points: [
          { x: ref.origPoints[0].x + dx, y: ref.origPoints[0].y + dy },
          { x: ref.origPoints[1].x + dx, y: ref.origPoints[1].y + dy },
        ],
        normalizedPoints: [
          { x: ref.origNormPoints[0].x + ndx, y: ref.origNormPoints[0].y + ndy },
          { x: ref.origNormPoints[1].x + ndx, y: ref.origNormPoints[1].y + ndy },
        ],
      });
    };
    const handleUp = () => {
      shapeDragRef.current = null;
      setIsShapeDragging(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isShapeDragging, canvasRef, onEditingShapeUpdate]);

  // Shape overlay bbox (in pixel)
  const shapeBox = useMemo(() => {
    if (!editingShape) {
      return null;
    }
    const [p0, p1] = editingShape.points;
    const bx = Math.min(p0.x, p1.x);
    const by = Math.min(p0.y, p1.y);
    const bw = Math.abs(p1.x - p0.x);
    const bh = Math.abs(p1.y - p0.y);
    const canvasW = canvasRef.current?.width ?? 800;
    const scaledLW = scaleLineWidth(editingShape.lineWidth, canvasW);
    return { bx, by, bw, bh, scaledLW, p0, p1 };
  }, [editingShape, canvasRef]);

  const cursorClass =
    isDrawer && tool === "text" ? "cursor-text" : isDrawer ? "cursor-crosshair" : "cursor-default";

  return (
    <div
      ref={containerRef}
      className={tx(
        "flex items-center justify-center bg-gray-100 rounded-xl overflow-hidden",
        "flex-1 min-h-0 relative min-w-[533px] min-h-[400px]",
      )}
    >
      <div className={tx("relative")}>
        <canvas
          ref={canvasRef as React.RefObject<HTMLCanvasElement>}
          className={tx("bg-white shadow-inner rounded-lg", cursorClass)}
          onClick={onCanvasClick}
        />

        {/* Text editing overlay — click outside commits (no buttons) */}
        {editingText && (
          <div
            className={tx("absolute select-none")}
            data-text-overlay="true"
            style={{ left: editingText.x - 10, top: editingText.y - 10 }}
          >
            <div
              onMouseDown={handleBorderMouseDown}
              style={{
                padding: 8,
                border: "2px dashed #818cf8",
                borderRadius: 4,
                cursor: isDragging ? "grabbing" : "move",
                position: "relative",
              }}
            >
              <textarea
                ref={textareaRef}
                value={editingText.text}
                onChange={(e) => onEditingTextUpdate?.({ text: e.target.value })}
                onMouseDown={(e) => e.stopPropagation()}
                maxLength={100}
                autoFocus
                style={{
                  fontSize: displayFontSize,
                  lineHeight: 1.2,
                  fontFamily: "sans-serif",
                  color: textColor,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  padding: 0,
                  marginTop: -displayFontSize * 0.1,
                  marginLeft: 0,
                  marginRight: 0,
                  marginBottom: 0,
                  display: "block",
                  minWidth: 40,
                  minHeight: displayFontSize * 1.2,
                  width: textareaWidth,
                  overflow: "hidden",
                }}
              />

              {CORNERS.map((corner) => (
                <div
                  key={corner.name}
                  onMouseDown={(e) => handleResizeStart(e, corner.name)}
                  className={tx("absolute")}
                  style={{
                    width: 10,
                    height: 10,
                    background: "#818cf8",
                    borderRadius: 2,
                    cursor: corner.cursor,
                    ...corner.style,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Shape editing overlay — click outside commits (no buttons) */}
        {editingShape && shapeBox && (
          <div
            className={tx("absolute select-none")}
            data-shape-overlay="true"
            onMouseDown={handleShapeOverlayMouseDown}
            style={{
              left: shapeBox.bx - SHAPE_OVERLAY_PADDING,
              top: shapeBox.by - SHAPE_OVERLAY_PADDING,
              width: shapeBox.bw + SHAPE_OVERLAY_PADDING * 2,
              height: shapeBox.bh + SHAPE_OVERLAY_PADDING * 2,
              border: "2px dashed #818cf8",
              boxSizing: "border-box",
              padding: SHAPE_OVERLAY_PADDING - 2,
              cursor: isShapeDragging ? "grabbing" : "move",
            }}
          >
            {editingShape.shape === "arrow" ? (
              <ArrowPreviewSvg
                start={{ x: shapeBox.p0.x - shapeBox.bx, y: shapeBox.p0.y - shapeBox.by }}
                end={{ x: shapeBox.p1.x - shapeBox.bx, y: shapeBox.p1.y - shapeBox.by }}
                bboxW={shapeBox.bw}
                bboxH={shapeBox.bh}
                color={editingShape.color}
                strokeWidthPx={shapeBox.scaledLW}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  boxSizing: "border-box",
                  pointerEvents: "none",
                  ...(editingShape.shape === "ellipse" ? { borderRadius: "50%" } : {}),
                  ...(editingShape.filled
                    ? { backgroundColor: editingShape.color }
                    : {
                        border: `${shapeBox.scaledLW}px solid ${editingShape.color}`,
                      }),
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
