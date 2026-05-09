import { useEffect } from "react";
import { tx } from "@twind/core";

export type ToastType = "error" | "info" | "success";

interface Props {
  message: string;
  type?: ToastType;
  onClose: () => void;
  duration?: number;
}

const TYPE_STYLES: Record<ToastType, string> = {
  error: "bg-red-50 text-red-700 border-red-200",
  info: "bg-canvas-parchment text-primary-focus border-hairline",
  success: "bg-green-50 text-green-700 border-green-200",
};

const TYPE_ICONS: Record<ToastType, string> = {
  error: "⚠️",
  info: "ℹ️",
  success: "✅",
};

export default function Toast({ message, type = "info", onClose, duration = 3000 }: Props) {
  useEffect(() => {
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [onClose, duration]);

  return (
    <div
      onClick={onClose}
      className={tx(
        "fixed top-4 right-4 z-[9999] px-4 py-3 rounded-lg border",
        "text-sm font-medium max-w-sm cursor-pointer",
        "flex items-center gap-2",
        "animate-[toast-in_200ms_ease-out]",
        TYPE_STYLES[type],
      )}
    >
      <span>{TYPE_ICONS[type]}</span>
      <span>{message}</span>
      <style>{`
        @keyframes toast-in {
          from { transform: translateX(110%); opacity: 0; }
          to   { transform: translateX(0);     opacity: 1; }
        }
      `}</style>
    </div>
  );
}
