const API_BASE = import.meta.env.VITE_API_BASE || "";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function wsUrl(path: string): string {
  if (API_BASE) {
    // Dev mode: connect directly to deployed Worker
    const url = new URL(API_BASE);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}${path}`;
  }
  // Production: same origin
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}
