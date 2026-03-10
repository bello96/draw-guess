import { tx } from "@twind/core";

const COLORS = [
  "#000000", "#ef4444", "#f97316", "#eab308",
  "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899",
  "#ffffff", "#6b7280",
];

const LINE_WIDTHS = [2, 4, 8, 12];

export type ToolMode = "pen" | "text";

interface Props {
  color: string;
  lineWidth: number;
  tool: ToolMode;
  onColorChange: (c: string) => void;
  onLineWidthChange: (w: number) => void;
  onToolChange: (t: ToolMode) => void;
  onClear: () => void;
  onUndo: () => void;
  disabled: boolean;
}

export default function Toolbar({
  color,
  lineWidth,
  tool,
  onColorChange,
  onLineWidthChange,
  onToolChange,
  onClear,
  onUndo,
  disabled,
}: Props) {
  return (
    <div
      className={tx(
        "flex items-center gap-3 p-3 bg-white rounded-xl shadow-sm flex-wrap",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {/* Colors */}
      <div className={tx("flex gap-1.5")}>
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => onColorChange(c)}
            className={tx(
              "w-7 h-7 rounded-full border-2 transition",
              c === color ? "border-indigo-500 scale-110" : "border-gray-300",
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>

      {/* Divider */}
      <div className={tx("w-px h-8 bg-gray-200")} />

      {/* Tool mode */}
      <div className={tx("flex gap-1.5 items-center")}>
        <button
          onClick={() => onToolChange("pen")}
          title="画笔"
          className={tx(
            "flex items-center justify-center w-8 h-8 rounded-lg transition text-base",
            tool === "pen" ? "bg-indigo-100 text-indigo-700" : "hover:bg-gray-100 text-gray-600",
          )}
        >
          ✏️
        </button>
        <button
          onClick={() => onToolChange("text")}
          title="文字"
          className={tx(
            "flex items-center justify-center w-8 h-8 rounded-lg transition font-bold text-base",
            tool === "text" ? "bg-indigo-100 text-indigo-700" : "hover:bg-gray-100 text-gray-600",
          )}
        >
          T
        </button>
      </div>

      {/* Divider */}
      <div className={tx("w-px h-8 bg-gray-200")} />

      {/* Line widths */}
      <div className={tx("flex gap-1.5 items-center")}>
        {LINE_WIDTHS.map((w) => (
          <button
            key={w}
            onClick={() => onLineWidthChange(w)}
            className={tx(
              "flex items-center justify-center w-8 h-8 rounded-lg transition",
              w === lineWidth ? "bg-indigo-100" : "hover:bg-gray-100",
            )}
          >
            <div
              className={tx("rounded-full bg-gray-800")}
              style={{ width: w + 2, height: w + 2 }}
            />
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className={tx("w-px h-8 bg-gray-200")} />

      {/* Actions */}
      <div className={tx("flex gap-2")}>
        <button
          onClick={onUndo}
          className={tx(
            "px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition",
          )}
        >
          撤销
        </button>
        <button
          onClick={onClear}
          className={tx(
            "px-3 py-1.5 text-sm bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition",
          )}
        >
          清除
        </button>
      </div>
    </div>
  );
}
