import { useRef, useEffect } from "react";
import { tx } from "@twind/core";

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawer: boolean;
}

export default function Canvas({ canvasRef, isDrawer }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-resize canvas to fill container while keeping it square
  useEffect(() => {
    const resizeCanvas = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;

      const size = Math.min(container.clientWidth, container.clientHeight);
      // Only resize if dimension actually changed, to avoid clearing the canvas
      if (canvas.width !== size || canvas.height !== size) {
        // Save current drawing
        const imageData = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height);
        canvas.width = size;
        canvas.height = size;
        // Restore if dimensions were close enough
        if (imageData && Math.abs(imageData.width - size) < 50) {
          canvas.getContext("2d")?.putImageData(imageData, 0, 0);
        }
      }
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [canvasRef]);

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
