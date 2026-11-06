import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "../types/protocol";
import { PROTOCOL_VERSION } from "../types/protocol";
import { apiUrl, wsUrl } from "../api";

export const PLAYER_ID_KEY = "draw-guess-playerId";
// 重连凭证。playerId 是公开的，取回身份靠它；quickleave 也要带。
export const PLAYER_TOKEN_KEY = "draw-guess-playerToken";

/**
 * 这个标签页的重连凭证，第一次用时生成。由客户端生成而不是等服务端下发：
 * roomState 没送到就断线时，重试还能凭它回到原身份，否则只能当陌生人（两人房直接“房间已满”）。
 */
function getPlayerToken(): string {
  let token = sessionStorage.getItem(PLAYER_TOKEN_KEY);
  if (!token) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem(PLAYER_TOKEN_KEY, token);
  }
  return token;
}

// 告诉服务端可以缩短自己的断线保留期（30 秒 → 5 秒）。
function sendQuickLeave(roomCode: string) {
  const pid = sessionStorage.getItem(PLAYER_ID_KEY);
  if (pid && navigator.sendBeacon) {
    // token 放请求体，不进 URL；字符串请求体是 text/plain，不会触发预检
    navigator.sendBeacon(
      apiUrl(`/api/rooms/${roomCode}/quickleave?playerId=${encodeURIComponent(pid)}`),
      sessionStorage.getItem(PLAYER_TOKEN_KEY) ?? "",
    );
  }
}

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

const PING_INTERVAL_MS = 25_000;
// 发出 ping 后这么久什么都没收到，就当连接已经半开（TCP 没断，但对面收不到也发不来）。
const PONG_TIMEOUT_MS = 10_000;
// 重连退避上限。服务端的断线保留期是 30 秒，上限太大的话网络恢复了也赶不上。
const MAX_RECONNECT_DELAY_MS = 8_000;
// 握手的超时。卡住的握手（切 VPN 或代理节点时常见）不会很快失败，会挡住所有重试。
const CONNECT_TIMEOUT_MS = 15_000;

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
    let terminated = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;

    const stopConnectionTimers = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
    };

    const handleDisconnected = (reason: string) => {
      joinedRef.current = false;
      setConnected(false);
      wsRef.current = null;
      stopConnectionTimers();

      if (!shouldReconnect || hasLeftRef.current || isUnloadingRef.current) {
        return;
      }
      // 只看 reason：限流的 close code 是 1008，不是 1000。
      if (TERMINAL_CLOSE_REASONS.has(reason)) {
        terminated = true;
        setTerminalReason(reason);
        return;
      }

      // Exponential backoff with jitter: about 1s, 2s, 4s, 8s, 8s...
      const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
      reconnectAttempts++;
      reconnectTimer = setTimeout(
        () => {
          reconnectTimer = null;
          connect();
        },
        delay * (0.8 + Math.random() * 0.4),
      );
    };

    // close() 要等对面回应才会触发 onclose，半开或握手卡住时等不到。解绑后直接按断线处理；
    // 重连时服务端走接管路径，旧连接由它关闭。
    const abandonConnection = (ws: WebSocket) => {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      handleDisconnected("");
    };

    const connect = () => {
      if (!shouldReconnect) {
        return;
      }

      const url = wsUrl(`/api/rooms/${roomCode}/ws`);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      stopConnectionTimers();
      connectTimer = setTimeout(() => abandonConnection(ws), CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        const joinMsg: Record<string, unknown> = {
          type: "join",
          playerName,
          v: PROTOCOL_VERSION,
          playerToken: getPlayerToken(),
        };
        // Prefer freshest playerId from sessionStorage — the prop is only the
        // value at mount time; after the first roomState we always have one.
        const latestPlayerId = sessionStorage.getItem(PLAYER_ID_KEY) || playerId;
        if (latestPlayerId) {
          joinMsg.playerId = latestPlayerId;
        }
        ws.send(JSON.stringify(joinMsg));

        // Heartbeat: keeps intermediate proxies from dropping the connection, and
        // notices a half-open one (no close event ever comes for those).
        stopConnectionTimers();
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }
          ws.send(JSON.stringify({ type: "ping" }));
          // roomState 到达之前不计时：它可能很大，下载期间 pong 排在后面。慢网下会被误判成
          // 半开，关掉重下，永远完不成。
          if (pongTimer || !joinedRef.current) {
            return;
          }
          pongTimer = setTimeout(() => abandonConnection(ws), PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        // 任何消息都说明连接是通的，不一定非要等到 pong
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
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

      ws.onclose = (event) => handleDisconnected(event.reason);

      ws.onerror = () => {
        // onclose always follows; reconnection is handled there.
      };
    };

    connect();

    // 网络恢复时不用等退避，也不用等卡住的握手超时
    const onOnline = () => {
      if (wsRef.current?.readyState === WebSocket.CONNECTING) {
        abandonConnection(wsRef.current);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempts = 0;
        connect();
      }
    };

    // pagehide + sendBeacon tells server to use QUICK_LEAVE_GRACE_MS (5s)
    // instead of the default 30s — enough for a refresh to reconnect, fast
    // for tab close / external navigation.
    // 卸载标记也在这里置位，不用 beforeunload：刷新可能被取消，之后断线就不会重连了。
    const onPageHide = () => {
      isUnloadingRef.current = true;
      if (hasLeftRef.current) {
        return;
      }
      sendQuickLeave(roomCode);
    };

    // 从往返缓存恢复：离开期间的断线没有安排重连，这里补上
    const onPageShow = (event: PageTransitionEvent) => {
      isUnloadingRef.current = false;
      if (event.persisted && !wsRef.current && !reconnectTimer && !terminated) {
        reconnectAttempts = 0;
        connect();
      }
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      shouldReconnect = false;
      stopConnectionTimers();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);

      // 这里不发 leave：主动离开由调用方用 leave() 显式通知。其他原因卸载（比如渲染出错，
      // ErrorBoundary 换成提示页）按普通断线处理，席位有保留期，刷新还能回来。
      const ws = wsRef.current;
      if (ws) {
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
  // 都以服务端状态为准，和断线期间的操作一样。返回是否真的发出去了。
  const send = useCallback((msg: ClientMessage): boolean => {
    if (joinedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const addListener = useCallback((fn: (msg: ServerMessage) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const leave = useCallback(() => {
    hasLeftRef.current = true;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "leave" }));
      return;
    }
    // 正在重连：服务端不知道玩家走了，席位要等保留期结束。调用方接着就会清掉身份，
    // 这是最后的机会告诉它。
    sendQuickLeave(roomCode);
  }, [roomCode]);

  return { connected, terminalReason, send, addListener, leave };
}
