import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { tx } from "@twind/core";
import type { ToolMode } from "./Toolbar";

export interface EditingText {
  text: string;
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
  fontSize: number;
}

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  tool?: ToolMode;
  onResize?: () => void;
  onCanvasClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  editingText?: EditingText | null;
  onEditingTextUpdate?: (updates: Partial<EditingText>) => void;
  onEditingTextDelete?: () => void;
  onEditingTextCommit?: () => void;
  textColor?: string;
}

/** Measure the pixel width of the longest line in a string */
function measureTextWidth(text: string, fontSize: number): number {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  if (!ctx) return 60;
  ctx.font = `${fontSize}px sans-serif`;
  const lines = text.split("\n");
  const maxWidth = Math.max(...lines.map((l) => ctx.measureText(l || " ").width));
  return Math.max(60, maxWidth + 8);
}

const CORNERS = [
  { name: "nw", cursor: "nw-resize", style: { top: -5, left: -5 } },
  { name: "ne", cursor: "ne-resize", style: { top: -5, right: -5 } },
  { name: "sw", cursor: "sw-resize", style: { bottom: -5, left: -5 } },
  { name: "se", cursor: "se-resize", style: { bottom: -5, right: -5 } },
] as const;

export default function Canvas({
  canvasRef,
  isDrawer,
  tool = "pen",
  onResize,
  onCanvasClick,
  editingText,
  onEditingTextUpdate,
  onEditingTextDelete,
  onEditingTextCommit,
  textColor = "#000000",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ corner: string; startX: number; startY: number; initialFontSize: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  // Canvas size
  const MIN_CANVAS_SIZE = 400;

  useEffect(() => {
    const resizeCanvas = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;

      const size = Math.max(MIN_CANVAS_SIZE, Math.min(container.clientWidth, container.clientHeight));
      if (canvas.width !== size || canvas.height !== size) {
        canvas.width = size;
        canvas.height = size;
        onResize?.();
      }
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [canvasRef, onResize]);

  // Display font size (scaled to canvas)
  const displayFontSize = editingText
    ? editingText.fontSize * ((canvasRef.current?.width || 800) / 800)
    : 18;

  // Auto-size textarea height
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !editingText) return;
    ta.style.height = "0";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editingText?.text, displayFontSize]);

  // Textarea width based on text content
  const textareaWidth = useMemo(
    () => (editingText ? measureTextWidth(editingText.text, displayFontSize) : 60),
    [editingText?.text, displayFontSize],
  );

  // === Move: drag on dashed border area ===
  const handleBorderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!editingText) return;
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
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
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

  // === Resize: drag on corner handles ===
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, corner: string) => {
      if (!editingText) return;
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
    if (!isResizing) return;

    const handleMove = (e: MouseEvent) => {
      const ref = resizeRef.current;
      if (!ref) return;
      const dx = e.clientX - ref.startX;
      const dy = e.clientY - ref.startY;
      // Each corner direction: outward = bigger
      let delta: number;
      switch (ref.corner) {
        case "se": delta = dx + dy; break;
        case "nw": delta = -dx - dy; break;
        case "ne": delta = dx - dy; break;
        case "sw": delta = -dx + dy; break;
        default: delta = 0;
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

  const cursorClass =
    isDrawer && tool === "text"
      ? "cursor-text"
      : isDrawer
        ? "cursor-crosshair"
        : "cursor-default";

  return (
    <div
      ref={containerRef}
      className={tx(
        "flex items-center justify-center bg-gray-100 rounded-xl overflow-hidden",
        "flex-1 min-h-0 relative min-w-[400px] min-h-[400px]",
      )}
    >
      <div className={tx("relative")}>
        <canvas
          ref={canvasRef as React.RefObject<HTMLCanvasElement>}
          className={tx("bg-white shadow-inner rounded-lg", cursorClass)}
          style={{ touchAction: "none" }}
          onClick={onCanvasClick}
        />

        {/* Unified text editing overlay */}
        {editingText && (
          <div
            className={tx("absolute select-none")}
            style={{ left: editingText.x - 10, top: editingText.y - 10 }}
          >
            {/* Dashed border wrapper — drag on border to move */}
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
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onEditingTextDelete?.();
                  }
                }}
                onMouseDown={(e) => e.stopPropagation()}
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
                  // Pull text up by half-leading so the glyph top aligns with (x, y)
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

              {/* Corner resize handles */}
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

            {/* Action buttons */}
            <div
              className={tx("absolute flex flex-col gap-0.5")}
              style={{ right: -28, top: 0 }}
            >
              <button
                onClick={(e) => { e.stopPropagation(); onEditingTextDelete?.(); }}
                onMouseDown={(e) => e.stopPropagation()}
                className={tx(
                  "w-5 h-5 flex items-center justify-center rounded-full",
                  "bg-red-500 text-white text-xs leading-none hover:bg-red-600",
                  "shadow-sm",
                )}
                title="删除"
              >
                ×
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onEditingTextCommit?.(); }}
                onMouseDown={(e) => e.stopPropagation()}
                className={tx(
                  "w-5 h-5 flex items-center justify-center rounded-full",
                  "bg-green-500 text-white text-xs leading-none hover:bg-green-600",
                  "shadow-sm",
                )}
                title="确认"
              >
                ✓
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
