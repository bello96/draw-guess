import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "../types/protocol";
import { wsUrl } from "../api";

export function useWebSocket(roomCode: string, playerName: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const listenersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set());

  useEffect(() => {
    const url = wsUrl(`/api/rooms/${roomCode}/ws`);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "join", playerName }));
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

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [roomCode, playerName]);

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

  return { connected, lastMessage, send, addListener };
}
