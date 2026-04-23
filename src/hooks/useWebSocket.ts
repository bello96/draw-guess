import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "../types/protocol";
import { PROTOCOL_VERSION } from "../types/protocol";
import { apiUrl, wsUrl } from "../api";

const PLAYER_ID_KEY = "draw-guess-playerId";

// Server-initiated close reasons where reconnecting is pointless (or harmful).
const TERMINAL_CLOSE_REASONS = new Set([
  "left", // local user clicked leave
  "room not found",
  "room full",
  "inactivity", // server auto-closed after idle timeout
  "reconnected", // server take-over from another tab/device
  "rate limited", // server rate-limited us; reconnecting would just get kicked again
  "version mismatch", // client and server protocol versions differ — refresh needed
]);

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
    let shouldReconnect = true;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const stopPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const connect = () => {
      if (!shouldReconnect) {
        return;
      }

      const url = wsUrl(`/api/rooms/${roomCode}/ws`);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectAttempts = 0;
        const joinMsg: Record<string, unknown> = {
          type: "join",
          playerName,
          v: PROTOCOL_VERSION,
        };
        // Prefer freshest playerId from sessionStorage — the prop is only the
        // value at mount time; after the first roomState we always have one.
        const latestPlayerId = playerId || sessionStorage.getItem(PLAYER_ID_KEY) || undefined;
        if (latestPlayerId) {
          joinMsg.playerId = latestPlayerId;
        }
        ws.send(JSON.stringify(joinMsg));

        // Heartbeat: every 25s to keep intermediate proxies from dropping the
        // connection. Server swallows ping and returns pong.
        stopPing();
        pingTimer = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "ping" }));
          }
        }, 25_000);
      };

      ws.onmessage = (event) => {
        const msg: ServerMessage = JSON.parse(event.data);
        // Pong is a keepalive — no listener should care.
        if (msg.type === "pong") {
          return;
        }
        setLastMessage(msg);
        for (const listener of listenersRef.current) {
          listener(msg);
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        wsRef.current = null;
        stopPing();

        if (!shouldReconnect || hasLeftRef.current || isUnloadingRef.current) {
          return;
        }
        if (event.code === 1000 && TERMINAL_CLOSE_REASONS.has(event.reason)) {
          return;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap).
        const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
        reconnectAttempts++;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose always follows; reconnection is handled there.
      };
    };

    connect();

    const onBeforeUnload = () => {
      isUnloadingRef.current = true;
    };

    // pagehide + sendBeacon tells server to use QUICK_LEAVE_GRACE_MS (5s)
    // instead of the default 30s — enough for a refresh to reconnect, fast
    // for tab close / external navigation.
    const onPageHide = () => {
      if (hasLeftRef.current) {
        return;
      }
      const pid = sessionStorage.getItem(PLAYER_ID_KEY);
      if (pid && navigator.sendBeacon) {
        navigator.sendBeacon(apiUrl(`/api/rooms/${roomCode}/quickleave?playerId=${pid}`));
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      shouldReconnect = false;
      stopPing();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);

      const ws = wsRef.current;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN && !isUnloadingRef.current && !hasLeftRef.current) {
          ws.send(JSON.stringify({ type: "leave" }));
        }
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
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

  const leave = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "leave" }));
      hasLeftRef.current = true;
    }
  }, []);

  return { connected, lastMessage, send, addListener, leave };
}
