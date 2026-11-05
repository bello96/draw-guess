import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "../types/protocol";
import { PROTOCOL_VERSION } from "../types/protocol";
import { apiUrl, wsUrl } from "../api";

const PLAYER_ID_KEY = "draw-guess-playerId";

// Server-initiated close reasons where reconnecting is pointless (or harmful),
// with the message shown to the user.
export const TERMINAL_CLOSE_REASONS = new Map([
  ["left", "你已离开房间"], // local user clicked leave
  ["room not found", "房间不存在或已解散"],
  ["room full", "房间已满"],
  ["inactivity", "房间超过10分钟无活动，已自动关闭"], // server auto-closed after idle timeout
  ["reconnected", "你已在其他标签页或设备进入此房间"], // server take-over from another tab/device
  ["rate limited", "消息频率过高，连接已断开"], // reconnecting would just get kicked again
  ["version mismatch", "客户端版本过旧，请刷新页面"], // client and server protocol versions differ
]);

export function useWebSocket(roomCode: string, playerName: string, playerId?: string) {
  const wsRef = useRef<WebSocket | null>(null);
  // 本连接的 roomState 已到达。socket 打开不算：见 send 的注释。
  const joinedRef = useRef(false);
  const [connected, setConnected] = useState(false);
  // 服务端明确不让重连时的 close reason。UI 据此切错误屏，否则会一直显示“正在重连”。
  const [terminalReason, setTerminalReason] = useState<string | null>(null);
  const listenersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set());
  const isUnloadingRef = useRef(false);
  const hasLeftRef = useRef(false);

  useEffect(() => {
    isUnloadingRef.current = false;
    hasLeftRef.current = false;
    setTerminalReason(null);
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
        const joinMsg: Record<string, unknown> = {
          type: "join",
          playerName,
          v: PROTOCOL_VERSION,
        };
        // Prefer freshest playerId from sessionStorage — the prop is only the
        // value at mount time; after the first roomState we always have one.
        const latestPlayerId = sessionStorage.getItem(PLAYER_ID_KEY) || playerId;
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
        if (msg.type === "roomState") {
          joinedRef.current = true;
          reconnectAttempts = 0;
          setConnected(true);
        }
        for (const listener of listenersRef.current) {
          listener(msg);
        }
      };

      ws.onclose = (event) => {
        joinedRef.current = false;
        setConnected(false);
        wsRef.current = null;
        stopPing();

        if (!shouldReconnect || hasLeftRef.current || isUnloadingRef.current) {
          return;
        }
        // 只看 reason：限流的 close code 是 1008，不是 1000。
        if (TERMINAL_CLOSE_REASONS.has(event.reason)) {
          setTerminalReason(event.reason);
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

  // roomState 到达之前不发：服务端按 join、这条消息的顺序处理，发回来的 roomState
  // 却不含这条消息的效果，随后 roomState 会覆盖本地状态，两边就分叉了。丢弃则两边
  // 都以服务端状态为准，和断线期间的操作一样。
  const send = useCallback((msg: ClientMessage) => {
    if (joinedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
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

  return { connected, terminalReason, send, addListener, leave };
}
