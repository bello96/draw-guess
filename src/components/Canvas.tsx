import { useRef, useEffect, useCallback, useState } from "react";
import { tx } from "@twind/core";
import type { ToolMode } from "./Toolbar";

interface PendingText {
  text: string;
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
}

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  tool?: ToolMode;
  onResize?: () => void;
  onCanvasClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  textInput?: { x: number; y: number } | null;
  textValue?: string;
  onTextValueChange?: (v: string) => void;
  onTextConfirm?: () => void;
  onTextCancel?: () => void;
  textInputRef?: React.RefObject<HTMLInputElement | null>;
  pendingText?: PendingText | null;
  onPendingTextMove?: (x: number, y: number) => void;
  onPendingTextDelete?: () => void;
  onPendingTextCommit?: () => void;
  textColor?: string;
}

export default function Canvas({
  canvasRef,
  isDrawer,
  tool = "pen",
  onResize,
  onCanvasClick,
  textInput,
  textValue = "",
  onTextValueChange,
  onTextConfirm,
  onTextCancel,
  textInputRef,
  pendingText,
  onPendingTextMove,
  onPendingTextDelete,
  onPendingTextCommit,
  textColor = "#000000",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Auto-resize canvas to fill container while keeping it square
  useEffect(() => {
    const resizeCanvas = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;

      const size = Math.min(container.clientWidth, container.clientHeight);
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

  // Drag handlers for pending text
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!pendingText) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pendingText.x,
        origY: pendingText.y,
      };
      setIsDragging(true);
    },
    [pendingText],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      onPendingTextMove?.(dragRef.current.origX + dx, dragRef.current.origY + dy);
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, onPendingTextMove]);

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
        "flex-1 min-h-0 relative",
      )}
    >
      <div className={tx("relative")}>
        <canvas
          ref={canvasRef as React.RefObject<HTMLCanvasElement>}
          className={tx("bg-white shadow-inner rounded-lg", cursorClass)}
          style={{ touchAction: "none" }}
          onClick={onCanvasClick}
        />

        {/* Phase 1: text input */}
        {textInput && (
          <input
            ref={textInputRef as React.RefObject<HTMLInputElement>}
            type="text"
            value={textValue}
            onChange={(e) => onTextValueChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onTextConfirm?.();
              if (e.key === "Escape") onTextCancel?.();
            }}
            onBlur={() => onTextConfirm?.()}
            className={tx(
              "absolute bg-white/80 outline-none border-b-2 border-indigo-400 text-black px-0.5",
            )}
            style={{
              left: textInput.x,
              top: textInput.y,
              fontSize: "18px",
              fontFamily: "sans-serif",
              width: Math.max(40, textValue.length * 12 + 16),
              color: textColor,
            }}
            autoFocus
          />
        )}

        {/* Phase 2: pending text overlay — draggable with delete & confirm */}
        {pendingText && (
          <div
            className={tx(
              "absolute flex items-start gap-0.5 select-none",
              isDragging ? "cursor-grabbing" : "cursor-grab",
            )}
            style={{ left: pendingText.x, top: pendingText.y - 4 }}
            onMouseDown={handleDragStart}
          >
            {/* Border outline */}
            <div
              className={tx(
                "border border-dashed border-indigo-400 rounded px-1 py-0.5 whitespace-nowrap",
              )}
              style={{
                fontSize: "18px",
                fontFamily: "sans-serif",
                color: textColor,
              }}
            >
              {pendingText.text}
            </div>

            {/* Action buttons */}
            <div className={tx("flex flex-col gap-0.5 -mt-1")}>
              {/* Delete button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onPendingTextDelete?.();
                }}
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
              {/* Confirm button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onPendingTextCommit?.();
                }}
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
