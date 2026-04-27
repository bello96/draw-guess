import { useCallback, useState } from "react";

const STORAGE_KEY = "draw-guess-recent-colors";
const MAX_RECENT = 6;
const HEX_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function readFromStorage(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr
      .filter((x): x is string => typeof x === "string" && HEX_RE.test(x))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeToStorage(arr: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // 私密模式 / 配额满 / 禁用：静默失败，运行时降级为内存
  }
}

export function useRecentColors(): {
  recent: string[];
  push: (color: string) => void;
} {
  const [recent, setRecent] = useState<string[]>(() => readFromStorage());
  const push = useCallback((color: string) => {
    setRecent((prev) => {
      const next = [color, ...prev.filter((x) => x !== color)].slice(0, MAX_RECENT);
      writeToStorage(next);
      return next;
    });
  }, []);
  return { recent, push };
}
