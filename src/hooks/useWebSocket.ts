import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "../types/protocol";
import { apiUrl, wsUrl } from "../api";

const PLAYER_ID_KEY = "draw-guess-playerId";

export function useWebSocket(roomCode: string, playerName: string, playerId?: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const listenersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set());
  const isUnloadingRef = useRef(false);
  const hasLeftRef = useRef(false);

  useEffect(() => {
    isUnloadingRef.current = false;
    hasLeftRef.current = false;

    const url = wsUrl(`/api/rooms/${roomCode}/ws`);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      const joinMsg: Record<string, unknown> = { type: "join", playerName };
      if (playerId) joinMsg.playerId = playerId;
      ws.send(JSON.stringify(joinMsg));
    };

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      setLastMessage(msg);
      for (const listener of listenersRef.current) {
        listener(msg);
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    // Detect page unload (refresh / close / navigate to external URL)
    const onBeforeUnload = () => {
      isUnloadingRef.current = true;
    };

    // Send quickleave beacon on page hide — tells server to use a short
    // grace period (5s) instead of the default 30s.  Enough for refresh
    // to reconnect, but fast removal for tab close / external navigation.
    const onPageHide = () => {
      if (hasLeftRef.current) return;
      const pid = sessionStorage.getItem(PLAYER_ID_KEY);
      if (pid && navigator.sendBeacon) {
        navigator.sendBeacon(
          apiUrl(`/api/rooms/${roomCode}/quickleave?playerId=${pid}`),
        );
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);

      // SPA navigation (not page unload) — send "leave" for immediate removal
      if (!isUnloadingRef.current && !hasLeftRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "leave" }));
      }

      ws.close();
      wsRef.current = null;
    };
  }, [roomCode, playerName, playerId]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const addListener = useCallback((fn: (msg: ServerMessage) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  /** Send "leave" message before closing — triggers immediate removal on server */
  const leave = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "leave" }));
      hasLeftRef.current = true;
    }
  }, []);

  return { connected, lastMessage, send, addListener, leave };
}
