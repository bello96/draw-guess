import { useState, useRef, useEffect, useCallback } from "react";
import { tx } from "@twind/core";
import { useWebSocket } from "../hooks/useWebSocket";
import { useCanvas } from "../hooks/useCanvas";
import Canvas from "../components/Canvas";
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
  const [answerText, setAnswerText] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [confettiKey, setConfettiKey] = useState(0);

  // Drawing state
  const [color, setColor] = useState("#000000");
  const [lineWidth, setLineWidth] = useState(4);
  const [tool, setTool] = useState<ToolMode>("pen");
  // Phase 1: typing text
  const [textInput, setTextInput] = useState<{
    x: number;
    y: number;
    normalizedX: number;
    normalizedY: number;
  } | null>(null);
  const [textValue, setTextValue] = useState("");
  const textInputRef = useRef<HTMLInputElement>(null);
  // Phase 2: pending text (movable + deletable, not yet committed to canvas)
  const [pendingText, setPendingText] = useState<{
    text: string;
    x: number;
    y: number;
    normalizedX: number;
    normalizedY: number;
  } | null>(null);

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
    // Local undo for the drawer: pop and replay
    strokesRef.current.pop();
    replayAll([...strokesRef.current]);
  };

  const handleTransfer = () => {
    send({ type: "transfer" });
  };

  const handleContinueDrawing = () => {
    send({ type: "continueDrawing" });
  };

  // Map lineWidth to distinct font sizes: 2→16, 4→24, 8→36, 12→48
  const textFontSize = lineWidth * 4 + 8;

  // Compute the actual display pixel size (matching canvas rendering)
  const getDisplayFontSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return textFontSize;
    return textFontSize * (canvas.width / 800);
  }, [textFontSize, canvasRef]);

  // Commit pending text to canvas and sync to server
  const commitPendingText = useCallback(() => {
    if (!pendingText) return;
    addTextStroke(pendingText.text, pendingText.normalizedX, pendingText.normalizedY, color, textFontSize);
    send({
      type: "textStroke",
      text: pendingText.text,
      x: pendingText.normalizedX,
      y: pendingText.normalizedY,
      color,
      fontSize: textFontSize,
    });
    setPendingText(null);
  }, [pendingText, color, textFontSize, addTextStroke, send]);

  // Text tool: handle canvas click to place text input
  const handleCanvasClickForText = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawer || tool !== "text") return;
      // If there's pending text, commit it first
      if (pendingText) {
        commitPendingText();
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      setTextInput({
        x: offsetX,
        y: offsetY,
        normalizedX: offsetX / rect.width,
        normalizedY: offsetY / rect.height,
      });
      setTextValue("");
      setTimeout(() => textInputRef.current?.focus(), 0);
    },
    [isDrawer, tool, canvasRef, pendingText, commitPendingText],
  );

  // After typing, move text to pending state (movable + deletable)
  const handleTextConfirm = useCallback(() => {
    if (!textInput || !textValue.trim()) {
      setTextInput(null);
      setTextValue("");
      return;
    }
    setPendingText({
      text: textValue.trim(),
      x: textInput.x,
      y: textInput.y,
      normalizedX: textInput.normalizedX,
      normalizedY: textInput.normalizedY,
    });
    setTextInput(null);
    setTextValue("");
  }, [textInput, textValue]);

  // Delete pending text
  const handleDeletePendingText = useCallback(() => {
    setPendingText(null);
  }, []);

  // Update pending text position after drag
  const handlePendingTextMove = useCallback(
    (x: number, y: number) => {
      if (!pendingText) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      setPendingText((prev) =>
        prev
          ? { ...prev, x, y, normalizedX: x / rect.width, normalizedY: y / rect.height }
          : null,
      );
    },
    [pendingText, canvasRef],
  );

  // When switching away from text tool, commit pending text
  const handleToolChange = useCallback(
    (t: ToolMode) => {
      if (t !== "text" && pendingText) {
        commitPendingText();
      }
      setTool(t);
    },
    [pendingText, commitPendingText],
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
            textInput={textInput}
            textValue={textValue}
            onTextValueChange={setTextValue}
            onTextConfirm={handleTextConfirm}
            onTextCancel={() => { setTextInput(null); setTextValue(""); }}
            textInputRef={textInputRef}
            pendingText={pendingText}
            onPendingTextMove={handlePendingTextMove}
            onPendingTextDelete={handleDeletePendingText}
            onPendingTextCommit={commitPendingText}
            textColor={color}
            displayFontSize={getDisplayFontSize()}
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
