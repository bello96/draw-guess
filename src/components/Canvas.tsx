import { useRef, useEffect } from "react";
import { tx } from "@twind/core";

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
  onResize?: () => void;
}

export default function Canvas({ canvasRef, isDrawer, onResize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

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
        // Let the parent replay all strokes after resize
        onResize?.();
      }
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [canvasRef, onResize]);

  return (
    <div
      ref={containerRef}
      className={tx(
        "flex items-center justify-center bg-gray-100 rounded-xl overflow-hidden",
        "flex-1 min-h-0",
      )}
    >
      <canvas
        ref={canvasRef as React.RefObject<HTMLCanvasElement>}
        className={tx(
          "bg-white shadow-inner rounded-lg",
          isDrawer ? "cursor-crosshair" : "cursor-default",
        )}
        style={{ touchAction: "none" }}
      />
    </div>
  );
}
