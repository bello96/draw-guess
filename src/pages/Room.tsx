import { useState, useRef, useCallback } from "react";
import { tx } from "@twind/core";
import { useWebSocket } from "../hooks/useWebSocket";
import { useCanvas } from "../hooks/useCanvas";
import Canvas from "../components/Canvas";
import type { EditingSelection, EditingShape, EditingText } from "../components/Canvas";
import type { DrawnShape } from "../hooks/useCanvas";
import Toolbar, { TEXT_SIZE_TO_PX } from "../components/Toolbar";
import type { FillMode, TextSize, ToolMode } from "../components/Toolbar";
import PlayerBar from "../components/PlayerBar";
import ChatPanel from "../components/ChatPanel";
import Confetti from "../components/Confetti";
import Toast, { type ToastType } from "../components/Toast";
import type {
  PlayerInfo,
  GamePhase,
  ChatMessage,
  ChatHistoryEntry,
  ServerMessage,
  BrushType,
} from "../types/protocol";
import { useEffect } from "react";

interface Props {
  roomCode: string;
  playerName: string;
  playerId?: string;
  onLeave: () => void;
}

const PLAYER_ID_KEY = "draw-guess-playerId";

let msgIdCounter = 0;
function nextMsgId() {
  return `msg-${++msgIdCounter}`;
}

export default function Room({ roomCode, playerName, playerId, onLeave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Game state
  const [myId, setMyId] = useState<string | null>(null);
  const myIdRef = useRef<string | null>(null);
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<GamePhase>("waiting");
  const [answerLength, setAnswerLength] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [confettiKey, setConfettiKey] = useState(0);
  const [joinError, setJoinError] = useState("");
  const [toast, setToast] = useState<{ message: string; type: ToastType; id: number } | null>(null);
  const [maxPlayers, setMaxPlayers] = useState<number>(2);
  const [pendingPromotionId, setPendingPromotionId] = useState<string | null>(null);

  // Drawing state
  const [color, setColor] = useState("#000000");
  const [lineWidth, setLineWidth] = useState(4);
  const [tool, setTool] = useState<ToolMode>("pen");
  const [fillMode, setFillMode] = useState<FillMode>("stroke");
  const [textSize, setTextSize] = useState<TextSize>("medium");
  // Pen 笔型：默认普通画笔；切换后 useCanvas 会用对应渲染算法处理新 stroke
  const [brushType, setBrushType] = useState<BrushType>("pen");

  // Unified text editing state
  const [editingText, setEditingText] = useState<EditingText | null>(null);
  // Shape (rect/ellipse) editing state — the drawer has drawn a shape and is
  // previewing it inside a dashed overlay; commits on click-outside/tool-change.
  const [editingShape, setEditingShape] = useState<EditingShape | null>(null);
  // Selection (marquee move) editing state — offscreen src region has already
  // been whitened and the patch is held in memory; commits on click-outside.
  const [editingSelection, setEditingSelection] = useState<EditingSelection | null>(null);
  // Undone strokes, LIFO. Any new stroke invalidates this stack — mirrors the
  // server-side redoStack so both sides stay in sync.
  const redoStackRef = useRef<import("../types/protocol").SerializedStroke[]>([]);
  // Mirror of "strokes / redoStack non-empty" for toolbar enablement. Kept as
  // state so React re-renders buttons when the stacks change.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const isDrawer = myId !== null && myId === drawerId;

  // WebSocket
  const {
    connected,
    send,
    addListener,
    leave: wsLeave,
  } = useWebSocket(roomCode, playerName, playerId);

  // Wrap onLeave: send "leave" message first for instant server-side removal
  const handleLeave = useCallback(() => {
    wsLeave();
    onLeave();
  }, [wsLeave, onLeave]);

  // Bridge: useCanvas emits a DrawnShape on mouseup; we store it as editingShape.
  const handleShapeDrawn = useCallback((shape: DrawnShape) => {
    setEditingShape({
      shape: shape.shape,
      filled: shape.filled,
      points: shape.points,
      normalizedPoints: shape.normalizedPoints,
      color: shape.color,
      lineWidth: shape.lineWidth,
    });
  }, []);

  // Refresh undo/redo button enablement. Call after any strokes/redoStack mutation.
  // Refs aren't reactive, so we mirror the "non-empty" flag into state here.
  const syncHistoryFlags = useCallback(() => {
    setCanUndo(strokesRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Local pen stroke finished — any new stroke invalidates redo history.
  const handleLocalPenEnd = useCallback(() => {
    redoStackRef.current = [];
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  // Bridge: useCanvas finished drawing a marquee + extracted the patch.
  // We open the selection overlay here; commit happens on click-outside.
  const handleSelectionDrawn = useCallback(
    (srcNorm: { x: number; y: number; w: number; h: number }, patch: HTMLCanvasElement) => {
      setEditingSelection({
        srcNorm,
        patch,
        dragOffsetPx: { dx: 0, dy: 0 },
      });
    },
    [],
  );

  // Canvas
  const {
    replayDraw,
    replayAll,
    clearCanvas,
    addTextStroke,
    addShape,
    addFill,
    addSelection,
    commitLocalSelection,
    cancelLocalSelection,
    syncVisibleFromOffscreen,
    strokesRef,
  } = useCanvas({
    canvasRef,
    isDrawer,
    color,
    lineWidth,
    tool,
    fillMode,
    brushType,
    send,
    onShapeDrawn: handleShapeDrawn,
    onLocalPenEnd: handleLocalPenEnd,
    onSelectionDrawn: handleSelectionDrawn,
    phase,
  });

  // Canvas resize handler — blit the cached offscreen onto the (now resized)
  // visible canvas. O(1) regardless of stroke count.
  const handleCanvasResize = useCallback(() => {
    syncVisibleFromOffscreen();
  }, [syncVisibleFromOffscreen]);

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
          myIdRef.current = msg.yourId;
          // Persist playerId for reconnection on page refresh
          sessionStorage.setItem(PLAYER_ID_KEY, msg.yourId);
          setPlayers(msg.players);
          setDrawerId(msg.drawerId);
          setPhase(msg.phase);
          setPendingPromotionId(msg.pendingPromotionId ?? null);
          if (typeof msg.maxPlayers === "number") {
            setMaxPlayers(msg.maxPlayers);
          }
          if (msg.answerLength) {
            setAnswerLength(msg.answerLength);
          }
          if (msg.answer) {
            setAnswerText(msg.answer);
          }
          // Replay strokes (strokesRef is saved even if canvas isn't mounted yet)
          replayAll(msg.strokes);
          syncHistoryFlags();
          // Restore chat history
          if (msg.chatHistory && msg.chatHistory.length > 0) {
            setMessages(
              msg.chatHistory.map((entry: ChatHistoryEntry) => ({
                id: nextMsgId(),
                playerId: entry.playerId,
                playerName: entry.playerName,
                text: entry.text,
                timestamp: entry.timestamp,
                kind: entry.kind,
                correct: entry.correct,
              })),
            );
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
          if (msg.action === "end") {
            redoStackRef.current = []; // new stroke invalidates redo history
            syncHistoryFlags();
          }
          break;

        case "clear":
          clearCanvas();
          redoStackRef.current = [];
          syncHistoryFlags();
          break;

        case "textStroke":
          addTextStroke(msg.text, msg.x, msg.y, msg.color, msg.fontSize);
          redoStackRef.current = [];
          syncHistoryFlags();
          break;

        case "shape":
          addShape(
            { x: msg.x, y: msg.y },
            { x: msg.x + msg.width, y: msg.y + msg.height },
            msg.color,
            msg.lineWidth,
            msg.shape,
            msg.filled,
          );
          redoStackRef.current = [];
          syncHistoryFlags();
          break;

        case "fill":
          addFill(msg.x, msg.y, msg.color, msg.tolerance);
          redoStackRef.current = [];
          syncHistoryFlags();
          break;

        case "selection":
          addSelection(
            { x: msg.srcX, y: msg.srcY, w: msg.w, h: msg.h },
            { x: msg.dstX, y: msg.dstY },
          );
          redoStackRef.current = [];
          syncHistoryFlags();
          break;

        case "undo": {
          const popped = strokesRef.current.pop();
          if (popped) {
            redoStackRef.current.push(popped);
          }
          replayAll([...strokesRef.current]);
          syncHistoryFlags();
          break;
        }

        case "redo": {
          const redone = redoStackRef.current.pop();
          if (redone) {
            strokesRef.current.push(redone);
            replayAll([...strokesRef.current]);
          }
          syncHistoryFlags();
          break;
        }

        case "phaseChange":
          setPhase(msg.phase);
          setDrawerId(msg.drawerId);
          if (msg.phase === "revealed") {
            setPendingPromotionId(msg.pendingPromotionId ?? null);
          } else {
            setPendingPromotionId(null);
          }
          if (msg.answerLength) {
            setAnswerLength(msg.answerLength);
          }
          // 切到非 drawing 阶段时，清理所有 in-progress editing overlay，
          // 避免本地继续操作未 commit 的 overlay 后两端画面 diverge
          if (msg.phase !== "drawing") {
            setEditingShape(null);
            setEditingText(null);
            if (editingSelection) {
              cancelLocalSelection();
              setEditingSelection(null);
            }
          }
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
          // If we haven't joined yet (no myId), this is a join error — show and redirect
          if (!myIdRef.current) {
            setJoinError(msg.message);
            setTimeout(() => onLeave(), 1500);
          } else {
            // Runtime error (rate limit, invalid action, etc.) — toast instead of
            // noisy system message in the chat log.
            setToast({ message: msg.message, type: "error", id: Date.now() });
          }
          break;

        case "roomClosed":
          addSystemMessage(`房间已关闭: ${msg.reason}`);
          setTimeout(() => onLeave(), 1500);
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
    addShape,
    addFill,
    addSelection,
    addSystemMessage,
    strokesRef,
    syncHistoryFlags,
    onLeave,
    editingSelection,
    cancelLocalSelection,
  ]);

  const handleClear = () => {
    setEditingShape(null);
    setEditingSelection(null);
    redoStackRef.current = [];
    send({ type: "clear" });
    clearCanvas();
    syncHistoryFlags();
  };

  const handleUndo = () => {
    if (strokesRef.current.length === 0) {
      return;
    }
    const popped = strokesRef.current[strokesRef.current.length - 1];
    strokesRef.current.pop();
    redoStackRef.current.push(popped);
    replayAll([...strokesRef.current]);
    send({ type: "undo" });
    syncHistoryFlags();
  };

  const handleRedo = () => {
    if (redoStackRef.current.length === 0) {
      return;
    }
    const redone = redoStackRef.current.pop();
    if (!redone) {
      return;
    }
    strokesRef.current.push(redone);
    replayAll([...strokesRef.current]);
    send({ type: "redo" });
    syncHistoryFlags();
  };

  const handleTransfer = (targetId?: string) => {
    setEditingShape(null);
    if (editingSelection) {
      cancelLocalSelection();
      setEditingSelection(null);
    }
    redoStackRef.current = [];
    if (targetId) {
      send({ type: "transfer", targetId });
    } else {
      send({ type: "transfer" });
    }
    syncHistoryFlags();
  };

  const handleContinueDrawing = () => {
    setEditingShape(null);
    if (editingSelection) {
      cancelLocalSelection();
      setEditingSelection(null);
    }
    redoStackRef.current = [];
    send({ type: "continueDrawing" });
    syncHistoryFlags();
  };

  // Commit editing text to canvas and sync to server
  const commitEditingText = useCallback(() => {
    if (phase !== "drawing") {
      setEditingText(null);
      return;
    }
    if (!editingText || !editingText.text.trim()) {
      setEditingText(null);
      return;
    }
    addTextStroke(
      editingText.text,
      editingText.normalizedX,
      editingText.normalizedY,
      color,
      editingText.fontSize,
    );
    send({
      type: "textStroke",
      text: editingText.text,
      x: editingText.normalizedX,
      y: editingText.normalizedY,
      color,
      fontSize: editingText.fontSize,
    });
    redoStackRef.current = []; // new stroke invalidates redo history
    syncHistoryFlags();
    setEditingText(null);
  }, [phase, editingText, color, addTextStroke, send, syncHistoryFlags]);

  // Text tool: click on canvas to create editing text
  const handleCanvasClickForText = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (phase !== "drawing") {
        return;
      }
      if (!isDrawer || tool !== "text") {
        return;
      }
      // Commit current editing text first
      if (editingText) {
        commitEditingText();
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      setEditingText({
        text: "",
        x: offsetX,
        y: offsetY,
        normalizedX: offsetX / rect.width,
        normalizedY: offsetY / rect.height,
        fontSize: TEXT_SIZE_TO_PX[textSize],
      });
    },
    [phase, isDrawer, tool, canvasRef, editingText, commitEditingText, textSize],
  );

  // Update editing text fields
  const handleEditingTextUpdate = useCallback((updates: Partial<EditingText>) => {
    setEditingText((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  // --- Shape editing ---

  // Commit the current editing shape: draw onto canvas + sync to the other player.
  const commitEditingShape = useCallback(() => {
    if (phase !== "drawing") {
      setEditingShape(null);
      return;
    }
    if (!editingShape) {
      return;
    }
    const {
      shape,
      filled,
      color: shapeColor,
      lineWidth: shapeLineWidth,
      normalizedPoints,
    } = editingShape;
    const [p0, p1] = normalizedPoints;
    addShape(p0, p1, shapeColor, shapeLineWidth, shape, filled);
    // Wire protocol uses {x,y,width,height}. For arrow: width/height may be
    // negative (direction preserved). For rect/ellipse: both are ≥ 0.
    send({
      type: "shape",
      shape,
      filled,
      x: p0.x,
      y: p0.y,
      width: p1.x - p0.x,
      height: p1.y - p0.y,
      color: shapeColor,
      lineWidth: shapeLineWidth,
    });
    redoStackRef.current = []; // new stroke invalidates redo history
    syncHistoryFlags();
    setEditingShape(null);
  }, [phase, editingShape, addShape, send, syncHistoryFlags]);

  // Drag the overlay around (pixel + normalized both get updated)
  const handleEditingShapeUpdate = useCallback((updates: Partial<EditingShape>) => {
    setEditingShape((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  // --- Selection editing ---

  // Commit the current editing selection: paste patch at final dst + sync peer.
  const commitEditingSelection = useCallback(() => {
    if (phase !== "drawing") {
      cancelLocalSelection();
      setEditingSelection(null);
      return;
    }
    if (!editingSelection) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const { srcNorm, patch, dragOffsetPx } = editingSelection;
    const dstNorm = {
      x: srcNorm.x + dragOffsetPx.dx / canvas.width,
      y: srcNorm.y + dragOffsetPx.dy / canvas.height,
    };
    commitLocalSelection(patch, srcNorm, dstNorm);
    send({
      type: "selection",
      srcX: srcNorm.x,
      srcY: srcNorm.y,
      w: srcNorm.w,
      h: srcNorm.h,
      dstX: dstNorm.x,
      dstY: dstNorm.y,
    });
    redoStackRef.current = [];
    syncHistoryFlags();
    setEditingSelection(null);
  }, [phase, editingSelection, cancelLocalSelection, commitLocalSelection, send, syncHistoryFlags]);

  // Drag the selection overlay (pixel offset only — no resize).
  const handleEditingSelectionUpdate = useCallback((updates: Partial<EditingSelection>) => {
    setEditingSelection((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  // When switching tools, commit whichever in-edit item is active.
  const handleToolChange = useCallback(
    (t: ToolMode) => {
      if (t !== "text" && editingText) {
        commitEditingText();
      }
      if (t !== "rect" && t !== "ellipse" && editingShape) {
        commitEditingShape();
      }
      if (t !== "selection" && editingSelection) {
        commitEditingSelection();
      }
      setTool(t);
    },
    [
      editingText,
      editingShape,
      editingSelection,
      commitEditingText,
      commitEditingShape,
      commitEditingSelection,
    ],
  );

  // Click-outside commit: while a text is being edited, clicking anywhere
  // outside the overlay and outside the canvas (canvas clicks are handled
  // separately by onCanvasClick which commits and opens a new one) should
  // commit the current text. This matches expected text-editor behavior.
  useEffect(() => {
    if (!editingText) {
      return;
    }
    const handleGlobalMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest("[data-text-overlay]")) {
        return;
      }
      if (target.tagName === "CANVAS") {
        return;
      }
      commitEditingText();
    };
    window.addEventListener("mousedown", handleGlobalMouseDown);
    return () => window.removeEventListener("mousedown", handleGlobalMouseDown);
  }, [editingText, commitEditingText]);

  // Click-outside commit for editing shape. Uses CAPTURE phase so this fires
  // before useCanvas's canvas mousedown handler — that way a click on the
  // canvas (e.g. starting a new shape) commits the current one first, then
  // the fresh drag is allowed to proceed on the now-empty editing slot.
  useEffect(() => {
    if (!editingShape) {
      return;
    }
    const handleGlobalMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }
      // Inside the dashed overlay: it's a drag, not a commit.
      if (target.closest("[data-shape-overlay]")) {
        return;
      }
      commitEditingShape();
    };
    window.addEventListener("mousedown", handleGlobalMouseDown, true);
    return () => window.removeEventListener("mousedown", handleGlobalMouseDown, true);
  }, [editingShape, commitEditingShape]);

  // Click-outside commit for editing selection. Capture phase — same reason as
  // shape overlay: any new marquee starting on the canvas must commit the
  // current selection first.
  useEffect(() => {
    if (!editingSelection) {
      return;
    }
    const handleGlobalMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest("[data-selection-overlay]")) {
        return;
      }
      commitEditingSelection();
    };
    window.addEventListener("mousedown", handleGlobalMouseDown, true);
    return () => window.removeEventListener("mousedown", handleGlobalMouseDown, true);
  }, [editingSelection, commitEditingSelection]);

  // 自动升级：猜对者本机 6.5s 后自动 claim drawer
  useEffect(() => {
    if (phase !== "revealed") {
      return;
    }
    if (pendingPromotionId === null) {
      return;
    }
    if (pendingPromotionId !== myId) {
      return;
    }

    const AUTO_PROMOTE_DELAY_MS = 6500;
    const timer = window.setTimeout(() => {
      send({ type: "claimDrawer" });
    }, AUTO_PROMOTE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [phase, pendingPromotionId, myId, send]);

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

  if (!connected || !myId) {
    return (
      <div className={tx("flex items-center justify-center min-h-screen bg-gray-50")}>
        <div className={tx("text-center")}>
          {joinError ? (
            <>
              <div className={tx("text-4xl mb-4")}>😥</div>
              <div className={tx("text-red-600 font-medium")}>{joinError}</div>
              <div className={tx("text-gray-400 text-sm mt-2")}>即将返回首页...</div>
            </>
          ) : (
            <>
              <div className={tx("text-4xl mb-4 animate-bounce")}>🎨</div>
              <div className={tx("text-gray-500")}>连接中...</div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={tx("flex flex-col h-screen bg-gray-50 p-3 gap-3")}>
      {confettiKey > 0 && <Confetti key={confettiKey} />}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
      {/* Top bar */}
      <PlayerBar
        roomCode={roomCode}
        players={players}
        drawerId={drawerId}
        myId={myId}
        phase={phase}
        maxPlayers={maxPlayers}
        pendingPromotionId={pendingPromotionId}
        onTransfer={handleTransfer}
        onContinueDrawing={handleContinueDrawing}
        onLeave={handleLeave}
      />

      {/* Main content */}
      <div className={tx("flex flex-1 gap-3 min-h-0")}>
        {/* Left: Canvas + Toolbar */}
        <div className={tx("flex flex-col flex-1 gap-3 min-h-0")}>
          <Canvas
            canvasRef={canvasRef}
            isDrawer={isDrawer}
            phase={phase}
            tool={tool}
            onResize={handleCanvasResize}
            onCanvasClick={handleCanvasClickForText}
            editingText={editingText}
            onEditingTextUpdate={handleEditingTextUpdate}
            textColor={color}
            editingShape={editingShape}
            onEditingShapeUpdate={handleEditingShapeUpdate}
            editingSelection={editingSelection}
            onEditingSelectionUpdate={handleEditingSelectionUpdate}
          />
          <Toolbar
            color={color}
            lineWidth={lineWidth}
            tool={tool}
            fillMode={fillMode}
            textSize={textSize}
            brushType={brushType}
            onColorChange={setColor}
            onLineWidthChange={setLineWidth}
            onToolChange={handleToolChange}
            onFillModeChange={setFillMode}
            onTextSizeChange={setTextSize}
            onBrushTypeChange={setBrushType}
            onClear={handleClear}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo}
            canRedo={canRedo}
            disabled={!isDrawer || phase !== "drawing"}
          />
        </div>

        {/* Right: Chat panel */}
        <div className={tx("w-[350px] min-h-0")}>
          <ChatPanel
            messages={messages}
            phase={phase}
            isDrawer={isDrawer}
            myId={myId}
            answerLength={answerLength}
            answerText={answerText}
            playerCount={players.length}
            onSendChat={handleSendChat}
            onGuess={handleGuess}
            onSetAnswer={handleSetAnswer}
          />
        </div>
      </div>
    </div>
  );
}
