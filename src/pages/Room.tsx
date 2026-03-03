import { useState, useRef, useEffect, useCallback } from "react";
import { tx } from "@twind/core";
import { useWebSocket } from "../hooks/useWebSocket";
import { useCanvas } from "../hooks/useCanvas";
import Canvas from "../components/Canvas";
import Toolbar from "../components/Toolbar";
import PlayerBar from "../components/PlayerBar";
import ChatPanel from "../components/ChatPanel";
import type {
  PlayerInfo,
  GamePhase,
  ChatMessage,
  ServerMessage,
} from "../types/protocol";

interface Props {
  roomCode: string;
  playerName: string;
  onLeave: () => void;
}

let msgIdCounter = 0;
function nextMsgId() {
  return `msg-${++msgIdCounter}`;
}

export default function Room({ roomCode, playerName, onLeave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Game state
  const [myId, setMyId] = useState<string | null>(null);
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<GamePhase>("waiting");
  const [answerLength, setAnswerLength] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Drawing state
  const [color, setColor] = useState("#000000");
  const [lineWidth, setLineWidth] = useState(4);

  const isDrawer = myId !== null && myId === drawerId;

  // WebSocket
  const { connected, send, addListener } = useWebSocket(roomCode, playerName);

  // Canvas
  const { replayDraw, replayAll, clearCanvas, strokesRef } = useCanvas({
    canvasRef,
    isDrawer,
    color,
    lineWidth,
    send,
  });

  // Canvas resize handler — replay all strokes from strokesRef
  const handleCanvasResize = useCallback(() => {
    replayAll([...strokesRef.current]);
  }, [replayAll, strokesRef]);

  const addSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        playerId: "system",
        playerName: "系统",
        text,
        timestamp: Date.now(),
        kind: "system",
      },
    ]);
  }, []);

  // Handle incoming messages
  useEffect(() => {
    const unsubscribe = addListener((msg: ServerMessage) => {
      switch (msg.type) {
        case "roomState":
          setMyId(msg.yourId);
          setPlayers(msg.players);
          setDrawerId(msg.drawerId);
          setPhase(msg.phase);
          if (msg.answerLength) setAnswerLength(msg.answerLength);
          if (msg.strokes.length > 0) {
            replayAll(msg.strokes);
          }
          break;

        case "playerJoined":
          setPlayers((prev) => [...prev, msg.player]);
          addSystemMessage(`${msg.player.name} 加入了房间`);
          break;

        case "playerLeft":
          setPlayers((prev) => {
            const leaving = prev.find((p) => p.id === msg.playerId);
            if (leaving) {
              addSystemMessage(`${leaving.name} 离开了房间`);
            }
            return prev.filter((p) => p.id !== msg.playerId);
          });
          break;

        case "draw":
          replayDraw(msg);
          break;

        case "clear":
          clearCanvas();
          break;

        case "undo":
          // Pop the last stroke and replay all remaining
          strokesRef.current.pop();
          replayAll([...strokesRef.current]);
          break;

        case "phaseChange":
          setPhase(msg.phase);
          setDrawerId(msg.drawerId);
          if (msg.answerLength) setAnswerLength(msg.answerLength);
          if (msg.phase === "guessing") {
            addSystemMessage("答案已设定，开始猜词！");
          } else if (msg.phase === "revealed") {
            addSystemMessage("🎉 猜对了！请手动转让画笔开始下一轮");
          } else if (msg.phase === "drawing") {
            addSystemMessage("新一轮开始，画手开始画画吧！");
            setAnswerLength(null);
          } else if (msg.phase === "waiting") {
            addSystemMessage("等待其他玩家加入...");
          }
          break;

        case "guessResult":
          setMessages((prev) => [
            ...prev,
            {
              id: nextMsgId(),
              playerId: msg.playerId,
              playerName: msg.playerName,
              text: msg.text,
              timestamp: Date.now(),
              kind: "guess",
              correct: msg.correct,
            },
          ]);
          break;

        case "chat":
          setMessages((prev) => [
            ...prev,
            {
              id: nextMsgId(),
              playerId: msg.playerId,
              playerName: msg.playerName,
              text: msg.text,
              timestamp: msg.timestamp,
              kind: "chat",
            },
          ]);
          break;

        case "transferDone":
          setDrawerId(msg.newDrawerId);
          addSystemMessage("画笔权限已转移！");
          break;

        case "error":
          addSystemMessage(`⚠️ ${msg.message}`);
          break;

        case "roomClosed":
          addSystemMessage(`房间已关闭: ${msg.reason}`);
          break;
      }
    });

    return unsubscribe;
  }, [
    addListener,
    replayDraw,
    replayAll,
    clearCanvas,
    addSystemMessage,
    strokesRef,
  ]);

  const handleClear = () => {
    send({ type: "clear" });
    clearCanvas();
  };

  const handleUndo = () => {
    send({ type: "undo" });
    // Local undo for the drawer: pop and replay
    strokesRef.current.pop();
    replayAll([...strokesRef.current]);
  };

  const handleTransfer = () => {
    send({ type: "transfer" });
  };

  const handleSendChat = (text: string) => {
    send({ type: "chat", text });
  };

  const handleGuess = (text: string) => {
    send({ type: "guess", text });
  };

  const handleSetAnswer = (answer: string) => {
    send({ type: "setAnswer", answer });
  };

  if (!connected) {
    return (
      <div
        className={tx(
          "flex items-center justify-center min-h-screen bg-gray-50",
        )}
      >
        <div className={tx("text-center")}>
          <div className={tx("text-4xl mb-4 animate-bounce")}>🎨</div>
          <div className={tx("text-gray-500")}>连接中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className={tx("flex flex-col h-screen bg-gray-50 p-3 gap-3")}>
      {/* Top bar */}
      <PlayerBar
        roomCode={roomCode}
        players={players}
        drawerId={drawerId}
        myId={myId}
        phase={phase}
        onTransfer={handleTransfer}
        onLeave={onLeave}
      />

      {/* Main content */}
      <div className={tx("flex flex-1 gap-3 min-h-0")}>
        {/* Left: Canvas + Toolbar */}
        <div className={tx("flex flex-col flex-1 gap-3 min-h-0")}>
          <Canvas
            canvasRef={canvasRef}
            isDrawer={isDrawer}
            onResize={handleCanvasResize}
          />
          <Toolbar
            color={color}
            lineWidth={lineWidth}
            onColorChange={setColor}
            onLineWidthChange={setLineWidth}
            onClear={handleClear}
            onUndo={handleUndo}
            disabled={!isDrawer}
          />
        </div>

        {/* Right: Chat panel */}
        <div className={tx("w-[350px] min-h-0")}>
          <ChatPanel
            messages={messages}
            phase={phase}
            isDrawer={isDrawer}
            answerLength={answerLength}
            onSendChat={handleSendChat}
            onGuess={handleGuess}
            onSetAnswer={handleSetAnswer}
          />
        </div>
      </div>
    </div>
  );
}
