import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { tx } from "@twind/core";
import type { ToolMode } from "./Toolbar";
import type { GamePhase } from "../types/protocol";
import {
  scaleLineWidth,
  computeArrowGeometry,
  svgPathTriangle,
  svgPathStar,
  svgPathHeart,
} from "../hooks/useCanvas";

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
  shape: "rect" | "ellipse" | "arrow" | "line" | "triangle" | "star" | "heart";
  filled: boolean;
  /** Raw pixel points (p0, p1). For arrow/line: p0 = start, p1 = end. */
  points: [Point, Point];
  /** Normalized counterparts of `points`, 0..1. */
  normalizedPoints: [Point, Point];
  color: string;
  lineWidth: number;
}

export interface EditingSelection {
  /** Source rectangle on the canvas, normalized 0..1. */
  srcNorm: { x: number; y: number; w: number; h: number };
  /** Extracted patch bitmap (off-DOM canvas at offscreen resolution). */
  patch: HTMLCanvasElement;
  /** Translate offset in visible canvas pixels (dx, dy from src position). */
  dragOffsetPx: { dx: number; dy: number };
}

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  phase: GamePhase;
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
  // Selection (marquee move)
  editingSelection?: EditingSelection | null;
  onEditingSelectionUpdate?: (updates: Partial<EditingSelection>) => void;
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
const HANDLE_SIZE = 10;
const HANDLE_COLOR = "#818cf8";

const CORNERS = [
  { name: "nw", cursor: "nw-resize", style: { top: -5, left: -5 } },
  { name: "ne", cursor: "ne-resize", style: { top: -5, right: -5 } },
  { name: "sw", cursor: "sw-resize", style: { bottom: -5, left: -5 } },
  { name: "se", cursor: "se-resize", style: { bottom: -5, right: -5 } },
] as const;

type ShapeCorner = "nw" | "ne" | "sw" | "se";

/** Unified mousedown-driven interaction on editing shape overlay. */
type ShapeInteraction =
  | {
      kind: "translate";
      startClientX: number;
      startClientY: number;
      origPoints: [Point, Point];
      origNormPoints: [Point, Point];
    }
  | {
      kind: "endpoint";
      endpointIndex: 0 | 1;
      startClientX: number;
      startClientY: number;
      origPoints: [Point, Point];
      origNormPoints: [Point, Point];
    }
  | {
      kind: "resize";
      corner: ShapeCorner;
      startClientX: number;
      startClientY: number;
      /** Renormalized to [LT, RB] at mousedown so corner semantics are clean. */
      origPoints: [Point, Point];
      origNormPoints: [Point, Point];
    };

/** SVG preview of a tapered arrow. Visible shape is a filled polygon
 *  (tail tip → body base → head base → head tip). `overflow: visible` lets
 *  degenerate bounding boxes still render. A wide invisible line on top is
 *  the hit-box for "drag arrow body". */
function ArrowPreviewSvg({
  start,
  end,
  bboxW,
  bboxH,
  color,
  strokeWidthPx,
  onHitBoxMouseDown,
}: {
  start: Point;
  end: Point;
  bboxW: number;
  bboxH: number;
  color: string;
  strokeWidthPx: number;
  onHitBoxMouseDown: (e: React.MouseEvent) => void;
}) {
  const g = computeArrowGeometry(start.x, start.y, end.x, end.y, strokeWidthPx);
  if (!g) {
    return null;
  }
  const p1x = g.baseX + g.perpX * g.bodyHalf;
  const p1y = g.baseY + g.perpY * g.bodyHalf;
  const p2x = g.baseX + g.perpX * g.headHalf;
  const p2y = g.baseY + g.perpY * g.headHalf;
  const p4x = g.baseX - g.perpX * g.headHalf;
  const p4y = g.baseY - g.perpY * g.headHalf;
  const p5x = g.baseX - g.perpX * g.bodyHalf;
  const p5y = g.baseY - g.perpY * g.bodyHalf;
  const points = `${start.x},${start.y} ${p1x},${p1y} ${p2x},${p2y} ${end.x},${end.y} ${p4x},${p4y} ${p5x},${p5y}`;
  const hitWidth = Math.max(20, strokeWidthPx * 3);
  return (
    <svg
      width={Math.max(bboxW, 1)}
      height={Math.max(bboxH, 1)}
      style={{ overflow: "visible", display: "block", pointerEvents: "none" }}
    >
      <polygon points={points} fill={color} pointerEvents="none" />
      {/* Invisible wide hit-box line for "drag arrow body" */}
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke="transparent"
        strokeWidth={hitWidth}
        strokeLinecap="round"
        data-shape-overlay="true"
        onMouseDown={onHitBoxMouseDown}
        style={{ cursor: "move", pointerEvents: "stroke" }}
      />
    </svg>
  );
}

/** SVG preview of a straight line. Mirrors the arrow overlay structure: one
 *  visible stroke + a wide invisible hit-box line on top. */
function LinePreviewSvg({
  start,
  end,
  bboxW,
  bboxH,
  color,
  strokeWidthPx,
  onHitBoxMouseDown,
}: {
  start: Point;
  end: Point;
  bboxW: number;
  bboxH: number;
  color: string;
  strokeWidthPx: number;
  onHitBoxMouseDown: (e: React.MouseEvent) => void;
}) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) < 1) {
    return null;
  }
  const hitWidth = Math.max(20, strokeWidthPx * 3);
  return (
    <svg
      width={Math.max(bboxW, 1)}
      height={Math.max(bboxH, 1)}
      style={{ overflow: "visible", display: "block", pointerEvents: "none" }}
    >
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke={color}
        strokeWidth={strokeWidthPx}
        strokeLinecap="round"
        pointerEvents="none"
      />
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke="transparent"
        strokeWidth={hitWidth}
        strokeLinecap="round"
        data-shape-overlay="true"
        onMouseDown={onHitBoxMouseDown}
        style={{ cursor: "move", pointerEvents: "stroke" }}
      />
    </svg>
  );
}

export default function Canvas({
  canvasRef,
  isDrawer,
  phase,
  tool = "pen",
  onResize,
  onCanvasClick,
  editingText,
  onEditingTextUpdate,
  textColor = "#000000",
  editingShape,
  onEditingShapeUpdate,
  editingSelection,
  onEditingSelectionUpdate,
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

  const shapeInteractionRef = useRef<ShapeInteraction | null>(null);
  const [shapeInteractionKind, setShapeInteractionKind] = useState<ShapeInteraction["kind"] | null>(
    null,
  );

  const selDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    origDragOffsetPx: { dx: number; dy: number };
  } | null>(null);
  const [isSelDragging, setIsSelDragging] = useState(false);
  const selPatchCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Canvas is 5:3. Height-driven; fall back to width-driven if the container is
  // too narrow to fit 5:3 at its clientHeight.
  const RATIO_W = 5;
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

  // --- Shape editing: unified handler supporting translate / endpoint / resize ---

  const startShapeTranslate = useCallback(
    (e: React.MouseEvent) => {
      if (!editingShape) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      shapeInteractionRef.current = {
        kind: "translate",
        startClientX: e.clientX,
        startClientY: e.clientY,
        origPoints: [{ ...editingShape.points[0] }, { ...editingShape.points[1] }],
        origNormPoints: [
          { ...editingShape.normalizedPoints[0] },
          { ...editingShape.normalizedPoints[1] },
        ],
      };
      setShapeInteractionKind("translate");
    },
    [editingShape],
  );

  const startShapeEndpointDrag = useCallback(
    (e: React.MouseEvent, endpointIndex: 0 | 1) => {
      if (!editingShape) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      shapeInteractionRef.current = {
        kind: "endpoint",
        endpointIndex,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origPoints: [{ ...editingShape.points[0] }, { ...editingShape.points[1] }],
        origNormPoints: [
          { ...editingShape.normalizedPoints[0] },
          { ...editingShape.normalizedPoints[1] },
        ],
      };
      setShapeInteractionKind("endpoint");
    },
    [editingShape],
  );

  const startShapeResize = useCallback(
    (e: React.MouseEvent, corner: ShapeCorner) => {
      if (!editingShape) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // Renormalize points to [LT, RB] form at mousedown so corner semantics
      // are clean. If shape already in LT-RB form this is a no-op.
      const [p0, p1] = editingShape.points;
      const [n0, n1] = editingShape.normalizedPoints;
      const ltPx: Point = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y) };
      const rbPx: Point = { x: Math.max(p0.x, p1.x), y: Math.max(p0.y, p1.y) };
      const ltN: Point = { x: Math.min(n0.x, n1.x), y: Math.min(n0.y, n1.y) };
      const rbN: Point = { x: Math.max(n0.x, n1.x), y: Math.max(n0.y, n1.y) };
      // If not already normalized, push update so the overlay re-renders aligned.
      if (p0.x !== ltPx.x || p0.y !== ltPx.y || p1.x !== rbPx.x || p1.y !== rbPx.y) {
        onEditingShapeUpdate?.({
          points: [ltPx, rbPx],
          normalizedPoints: [ltN, rbN],
        });
      }
      shapeInteractionRef.current = {
        kind: "resize",
        corner,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origPoints: [ltPx, rbPx],
        origNormPoints: [ltN, rbN],
      };
      setShapeInteractionKind("resize");
    },
    [editingShape, onEditingShapeUpdate],
  );

  useEffect(() => {
    if (!shapeInteractionKind) {
      return;
    }
    const handleMove = (e: MouseEvent) => {
      const ref = shapeInteractionRef.current;
      if (!ref) {
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const dx = e.clientX - ref.startClientX;
      const dy = e.clientY - ref.startClientY;
      const ndx = dx / rect.width;
      const ndy = dy / rect.height;

      if (ref.kind === "translate") {
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
        return;
      }

      if (ref.kind === "endpoint") {
        const i = ref.endpointIndex;
        const other = i === 0 ? 1 : 0;
        const moved: Point = { x: ref.origPoints[i].x + dx, y: ref.origPoints[i].y + dy };
        const movedN: Point = {
          x: ref.origNormPoints[i].x + ndx,
          y: ref.origNormPoints[i].y + ndy,
        };
        const nextPoints: [Point, Point] =
          i === 0 ? [moved, ref.origPoints[other]] : [ref.origPoints[other], moved];
        const nextNorm: [Point, Point] =
          i === 0 ? [movedN, ref.origNormPoints[other]] : [ref.origNormPoints[other], movedN];
        onEditingShapeUpdate?.({
          points: nextPoints,
          normalizedPoints: nextNorm,
        });
        return;
      }

      if (ref.kind === "resize") {
        // origPoints were snapped to [LT, RB] at mousedown. Corner → which
        // coordinates move:
        //   nw: p0.x, p0.y   ne: p1.x, p0.y
        //   sw: p0.x, p1.y   se: p1.x, p1.y
        const p0 = { ...ref.origPoints[0] };
        const p1 = { ...ref.origPoints[1] };
        const n0 = { ...ref.origNormPoints[0] };
        const n1 = { ...ref.origNormPoints[1] };
        switch (ref.corner) {
          case "nw":
            p0.x += dx;
            p0.y += dy;
            n0.x += ndx;
            n0.y += ndy;
            break;
          case "ne":
            p1.x += dx;
            p0.y += dy;
            n1.x += ndx;
            n0.y += ndy;
            break;
          case "sw":
            p0.x += dx;
            p1.y += dy;
            n0.x += ndx;
            n1.y += ndy;
            break;
          case "se":
            p1.x += dx;
            p1.y += dy;
            n1.x += ndx;
            n1.y += ndy;
            break;
        }
        onEditingShapeUpdate?.({
          points: [p0, p1],
          normalizedPoints: [n0, n1],
        });
      }
    };
    const handleUp = () => {
      shapeInteractionRef.current = null;
      setShapeInteractionKind(null);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [shapeInteractionKind, canvasRef, onEditingShapeUpdate]);

  // --- Selection (marquee move) editing: translate only, no resize ---

  const startSelectionTranslate = useCallback(
    (e: React.MouseEvent) => {
      if (!editingSelection) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      selDragRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        origDragOffsetPx: { ...editingSelection.dragOffsetPx },
      };
      setIsSelDragging(true);
    },
    [editingSelection],
  );

  useEffect(() => {
    if (!isSelDragging) {
      return;
    }
    const handleMove = (e: MouseEvent) => {
      const ref = selDragRef.current;
      if (!ref) {
        return;
      }
      const dx = e.clientX - ref.startClientX;
      const dy = e.clientY - ref.startClientY;
      onEditingSelectionUpdate?.({
        dragOffsetPx: { dx: ref.origDragOffsetPx.dx + dx, dy: ref.origDragOffsetPx.dy + dy },
      });
    };
    const handleUp = () => {
      selDragRef.current = null;
      setIsSelDragging(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isSelDragging, onEditingSelectionUpdate]);

  // Paint the selection's patch bitmap into the DOM preview canvas whenever
  // the patch source changes. Uses fixed offscreen resolution; CSS scales it.
  useEffect(() => {
    const previewCanvas = selPatchCanvasRef.current;
    if (!previewCanvas || !editingSelection) {
      return;
    }
    previewCanvas.width = editingSelection.patch.width;
    previewCanvas.height = editingSelection.patch.height;
    const ctx = previewCanvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(editingSelection.patch, 0, 0);
    }
  }, [editingSelection]);

  // Shape overlay bbox (in pixel) — always Math.min/max so the visual bbox is
  // correct regardless of the points' internal ordering (which may be
  // non-LT-RB in the middle of a resize drag).
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

  const canDraw = isDrawer && (phase === "drawing" || phase === "waiting");
  const cursorClass =
    canDraw && tool === "text" ? "cursor-text" : canDraw ? "cursor-crosshair" : "cursor-default";

  const renderHandle = (
    left: number,
    top: number,
    cursor: string,
    onMouseDown: (e: React.MouseEvent) => void,
  ) => (
    <div
      data-shape-overlay="true"
      onMouseDown={onMouseDown}
      style={{
        position: "absolute",
        left: left - HANDLE_SIZE / 2,
        top: top - HANDLE_SIZE / 2,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        background: HANDLE_COLOR,
        borderRadius: 2,
        cursor,
        pointerEvents: "auto",
      }}
    />
  );

  return (
    <div
      ref={containerRef}
      className={tx(
        "flex items-center justify-center bg-gray-100 rounded-lg overflow-hidden",
        "flex-1 min-h-0 relative min-w-[667px] min-h-[400px]",
      )}
    >
      <div className={tx("relative")}>
        <canvas
          ref={canvasRef as React.RefObject<HTMLCanvasElement>}
          className={tx("bg-white shadow-product rounded-lg", cursorClass)}
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

        {/* Shape editing overlay — arrow/line share a layout (two-endpoint shapes
         *  with a hit-box body); rect/ellipse use a different one (bbox + corner
         *  resize handles). */}
        {editingShape &&
          shapeBox &&
          (editingShape.shape === "arrow" || editingShape.shape === "line") && (
            <div
              className={tx("absolute select-none")}
              data-shape-overlay="true"
              style={{
                left: shapeBox.bx - SHAPE_OVERLAY_PADDING,
                top: shapeBox.by - SHAPE_OVERLAY_PADDING,
                width: shapeBox.bw + SHAPE_OVERLAY_PADDING * 2,
                height: shapeBox.bh + SHAPE_OVERLAY_PADDING * 2,
                pointerEvents: "none",
              }}
            >
              {/* Dashed border — pure visual, does NOT respond to drag */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  border: "2px dashed #818cf8",
                  boxSizing: "border-box",
                  pointerEvents: "none",
                }}
              />

              {/* Visible shape + invisible wide hit-box line */}
              <div
                style={{
                  position: "absolute",
                  left: SHAPE_OVERLAY_PADDING,
                  top: SHAPE_OVERLAY_PADDING,
                  width: shapeBox.bw,
                  height: shapeBox.bh,
                  pointerEvents: "none",
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
                    onHitBoxMouseDown={startShapeTranslate}
                  />
                ) : (
                  <LinePreviewSvg
                    start={{ x: shapeBox.p0.x - shapeBox.bx, y: shapeBox.p0.y - shapeBox.by }}
                    end={{ x: shapeBox.p1.x - shapeBox.bx, y: shapeBox.p1.y - shapeBox.by }}
                    bboxW={shapeBox.bw}
                    bboxH={shapeBox.bh}
                    color={editingShape.color}
                    strokeWidthPx={shapeBox.scaledLW}
                    onHitBoxMouseDown={startShapeTranslate}
                  />
                )}
              </div>

              {/* Endpoint handles at p0 (start) and p1 (end) */}
              {renderHandle(
                shapeBox.p0.x - shapeBox.bx + SHAPE_OVERLAY_PADDING,
                shapeBox.p0.y - shapeBox.by + SHAPE_OVERLAY_PADDING,
                "grab",
                (e) => startShapeEndpointDrag(e, 0),
              )}
              {renderHandle(
                shapeBox.p1.x - shapeBox.bx + SHAPE_OVERLAY_PADDING,
                shapeBox.p1.y - shapeBox.by + SHAPE_OVERLAY_PADDING,
                "grab",
                (e) => startShapeEndpointDrag(e, 1),
              )}
            </div>
          )}

        {editingShape &&
          shapeBox &&
          editingShape.shape !== "arrow" &&
          editingShape.shape !== "line" && (
            <div
              className={tx("absolute select-none")}
              data-shape-overlay="true"
              onMouseDown={startShapeTranslate}
              style={{
                left: shapeBox.bx - SHAPE_OVERLAY_PADDING,
                top: shapeBox.by - SHAPE_OVERLAY_PADDING,
                width: shapeBox.bw + SHAPE_OVERLAY_PADDING * 2,
                height: shapeBox.bh + SHAPE_OVERLAY_PADDING * 2,
                cursor: shapeInteractionKind === "translate" ? "grabbing" : "move",
              }}
            >
              {/* Dashed border — inner layer so the container stays border-free
               *  and corner handles can land exactly on the outer corners. */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  border: "2px dashed #818cf8",
                  boxSizing: "border-box",
                  pointerEvents: "none",
                }}
              />

              {/* Shape preview — rect/ellipse 用 CSS（border/background），三角形 / 五角星 / 爱心
               *  路径形状用 SVG <path>，复用 useCanvas 里同一份 svgPath* 几何（保证 overlay
               *  和最终 commit 到 canvas 上的形状像素级一致）。 */}
              {editingShape.shape === "rect" || editingShape.shape === "ellipse" ? (
                <div
                  style={{
                    position: "absolute",
                    left: SHAPE_OVERLAY_PADDING,
                    top: SHAPE_OVERLAY_PADDING,
                    width: shapeBox.bw,
                    height: shapeBox.bh,
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
              ) : (
                <svg
                  style={{
                    position: "absolute",
                    left: SHAPE_OVERLAY_PADDING,
                    top: SHAPE_OVERLAY_PADDING,
                    width: shapeBox.bw,
                    height: shapeBox.bh,
                    overflow: "visible",
                    pointerEvents: "none",
                  }}
                  viewBox={`0 0 ${Math.max(shapeBox.bw, 1)} ${Math.max(shapeBox.bh, 1)}`}
                  preserveAspectRatio="none"
                >
                  <path
                    d={
                      editingShape.shape === "triangle"
                        ? svgPathTriangle(shapeBox.bw, shapeBox.bh)
                        : editingShape.shape === "star"
                          ? svgPathStar(shapeBox.bw, shapeBox.bh)
                          : svgPathHeart(shapeBox.bw, shapeBox.bh)
                    }
                    fill={editingShape.filled ? editingShape.color : "none"}
                    stroke={editingShape.filled ? "none" : editingShape.color}
                    strokeWidth={shapeBox.scaledLW}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              )}

              {/* 4 corner resize handles — centered exactly on the dashed border's
               *  outer corners. Container has no border so abs-positioning's
               *  padding-edge basis coincides with the outer edge. */}
              {renderHandle(0, 0, "nw-resize", (e) => startShapeResize(e, "nw"))}
              {renderHandle(shapeBox.bw + SHAPE_OVERLAY_PADDING * 2, 0, "ne-resize", (e) =>
                startShapeResize(e, "ne"),
              )}
              {renderHandle(0, shapeBox.bh + SHAPE_OVERLAY_PADDING * 2, "sw-resize", (e) =>
                startShapeResize(e, "sw"),
              )}
              {renderHandle(
                shapeBox.bw + SHAPE_OVERLAY_PADDING * 2,
                shapeBox.bh + SHAPE_OVERLAY_PADDING * 2,
                "se-resize",
                (e) => startShapeResize(e, "se"),
              )}
            </div>
          )}

        {/* Selection (marquee move) overlay — translate only, no resize handles */}
        {editingSelection &&
          canvasRef.current &&
          (() => {
            const vis = canvasRef.current;
            if (!vis) {
              return null;
            }
            const srcLeftPx = editingSelection.srcNorm.x * vis.width;
            const srcTopPx = editingSelection.srcNorm.y * vis.height;
            const srcWPx = editingSelection.srcNorm.w * vis.width;
            const srcHPx = editingSelection.srcNorm.h * vis.height;
            const left = srcLeftPx + editingSelection.dragOffsetPx.dx;
            const top = srcTopPx + editingSelection.dragOffsetPx.dy;
            return (
              <div
                className={tx("absolute select-none")}
                data-selection-overlay="true"
                onMouseDown={startSelectionTranslate}
                style={{
                  left,
                  top,
                  width: srcWPx,
                  height: srcHPx,
                  cursor: isSelDragging ? "grabbing" : "move",
                }}
              >
                <canvas
                  ref={selPatchCanvasRef}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: "none",
                    display: "block",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    border: "2px dashed #818cf8",
                    boxSizing: "border-box",
                    pointerEvents: "none",
                  }}
                />
              </div>
            );
          })()}
      </div>
    </div>
  );
}
