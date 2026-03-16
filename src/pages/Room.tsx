import { useState, useRef, useCallback } from "react";
import { tx } from "@twind/core";
import { useWebSocket } from "../hooks/useWebSocket";
import { useCanvas } from "../hooks/useCanvas";
import Canvas from "../components/Canvas";
import type { EditingText } from "../components/Canvas";
import Toolbar from "../components/Toolbar";
import PlayerBar from "../components/PlayerBar";
import ChatPanel from "../components/ChatPanel";
import Confetti from "../components/Confetti";
import type {
  PlayerInfo,
  GamePhase,
  ChatMessage,
  ServerMessage,
} from "../types/protocol";
import type { ToolMode } from "../components/Toolbar";
import { useEffect } from "react";

interface Props {
  roomCode: string;
  playerName: string;
  onLeave: () => void;
}

let msgIdCounter = 0;
function nextMsgId() {
  return `msg-${++msgIdCounter}`;
}

const DEFAULT_TEXT_FONT_SIZE = 24;

export default function Room({ roomCode, playerName, onLeave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Game state
  const [myId, setMyId] = useState<string | null>(null);
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<GamePhase>("waiting");
  const [answerLength, setAnswerLength] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [confettiKey, setConfettiKey] = useState(0);

  // Drawing state
  const [color, setColor] = useState("#000000");
  const [lineWidth, setLineWidth] = useState(4);
  const [tool, setTool] = useState<ToolMode>("pen");

  // Unified text editing state
  const [editingText, setEditingText] = useState<EditingText | null>(null);

  const isDrawer = myId !== null && myId === drawerId;

  // WebSocket
  const { connected, send, addListener } = useWebSocket(roomCode, playerName);

  // Canvas
  const { replayDraw, replayAll, clearCanvas, addTextStroke, strokesRef } = useCanvas({
    canvasRef,
    isDrawer,
    color,
    lineWidth,
    tool,
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

        case "textStroke":
          addTextStroke(msg.text, msg.x, msg.y, msg.color, msg.fontSize);
          break;

        case "undo":
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
            addSystemMessage("🎉 猜对了！可以继续出题或转让画笔");
          } else if (msg.phase === "drawing") {
            addSystemMessage("新一轮开始，画手开始画画吧！");
            setAnswerLength(null);
            setAnswerText(null);
            setConfettiKey(0);
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
          if (msg.correct) {
            setConfettiKey((k) => k + 1);
          }
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
    addTextStroke,
    addSystemMessage,
    strokesRef,
  ]);

  const handleClear = () => {
    send({ type: "clear" });
    clearCanvas();
  };

  const handleUndo = () => {
    send({ type: "undo" });
    strokesRef.current.pop();
    replayAll([...strokesRef.current]);
  };

  const handleTransfer = () => {
    send({ type: "transfer" });
  };

  const handleContinueDrawing = () => {
    send({ type: "continueDrawing" });
  };

  // Commit editing text to canvas and sync to server
  const commitEditingText = useCallback(() => {
    if (!editingText || !editingText.text.trim()) {
      setEditingText(null);
      return;
    }
    addTextStroke(editingText.text, editingText.normalizedX, editingText.normalizedY, color, editingText.fontSize);
    send({
      type: "textStroke",
      text: editingText.text,
      x: editingText.normalizedX,
      y: editingText.normalizedY,
      color,
      fontSize: editingText.fontSize,
    });
    setEditingText(null);
  }, [editingText, color, addTextStroke, send]);

  // Text tool: click on canvas to create editing text
  const handleCanvasClickForText = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawer || tool !== "text") return;
      // Commit current editing text first
      if (editingText) {
        commitEditingText();
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      setEditingText({
        text: "",
        x: offsetX,
        y: offsetY,
        normalizedX: offsetX / rect.width,
        normalizedY: offsetY / rect.height,
        fontSize: DEFAULT_TEXT_FONT_SIZE,
      });
    },
    [isDrawer, tool, canvasRef, editingText, commitEditingText],
  );

  // Update editing text fields
  const handleEditingTextUpdate = useCallback(
    (updates: Partial<EditingText>) => {
      setEditingText((prev) => (prev ? { ...prev, ...updates } : null));
    },
    [],
  );

  // Delete editing text
  const handleEditingTextDelete = useCallback(() => {
    setEditingText(null);
  }, []);

  // When switching away from text tool, commit editing text
  const handleToolChange = useCallback(
    (t: ToolMode) => {
      if (t !== "text" && editingText) {
        commitEditingText();
      }
      setTool(t);
    },
    [editingText, commitEditingText],
  );

  const handleSendChat = (text: string) => {
    send({ type: "chat", text });
  };

  const handleGuess = (text: string) => {
    send({ type: "guess", text });
  };

  const handleSetAnswer = (answer: string) => {
    send({ type: "setAnswer", answer });
    setAnswerText(answer);
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
      {confettiKey > 0 && (
        <Confetti key={confettiKey} duration={4000} />
      )}
      {/* Top bar */}
      <PlayerBar
        roomCode={roomCode}
        players={players}
        drawerId={drawerId}
        myId={myId}
        phase={phase}
        onTransfer={handleTransfer}
        onContinueDrawing={handleContinueDrawing}
        onLeave={onLeave}
      />

      {/* Main content */}
      <div className={tx("flex flex-1 gap-3 min-h-0")}>
        {/* Left: Canvas + Toolbar */}
        <div className={tx("flex flex-col flex-1 gap-3 min-h-0")}>
          <Canvas
            canvasRef={canvasRef}
            isDrawer={isDrawer}
            tool={tool}
            onResize={handleCanvasResize}
            onCanvasClick={handleCanvasClickForText}
            editingText={editingText}
            onEditingTextUpdate={handleEditingTextUpdate}
            onEditingTextDelete={handleEditingTextDelete}
            onEditingTextCommit={commitEditingText}
            textColor={color}
          />
          <Toolbar
            color={color}
            lineWidth={lineWidth}
            tool={tool}
            onColorChange={setColor}
            onLineWidthChange={setLineWidth}
            onToolChange={handleToolChange}
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
            answerText={answerText}
            onSendChat={handleSendChat}
            onGuess={handleGuess}
            onSetAnswer={handleSetAnswer}
          />
        </div>
      </div>
    </div>
  );
}
