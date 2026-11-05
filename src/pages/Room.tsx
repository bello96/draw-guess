import { useState, useRef, useCallback } from "react";
import { tx } from "@twind/core";
import { useWebSocket, PLAYER_ID_KEY, TERMINAL_CLOSE_REASONS } from "../hooks/useWebSocket";
import { useCanvas, findDependentFillIndices } from "../hooks/useCanvas";
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
  SerializedStroke,
} from "../types/protocol";
import { useEffect } from "react";

interface Props {
  roomCode: string;
  playerName: string;
  playerId?: string;
  onLeave: () => void;
}

let msgIdCounter = 0;
function nextMsgId() {
  return `msg-${++msgIdCounter}`;
}

// 设答案后本地锁定画布的最长时间，正常一个 RTT 就解除了。
const ANSWER_LOCK_MAX_MS = 5000;

// 文本编辑会话 id（见 Canvas.tsx 的 EditingText.id）。模块级自增，
// StrictMode remount 不重置也无妨——只要求单调变化。
let editingTextIdCounter = 0;

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
  // 框选工具的元素选中态：当前选中的已提交笔画。stroke 对象快照用于删除时的
  // 失效校验 —— 所有会改动 strokes 数组的路径都应先清掉本状态。
  const [picked, setPicked] = useState<{ index: number; stroke: SerializedStroke } | null>(null);
  // hover 提示：浅虚线框暗示"可点击选择"。仅框选工具空闲悬浮时由 useCanvas 上报。
  const [hovered, setHovered] = useState<SerializedStroke | null>(null);
  // Undone strokes, LIFO. Any new stroke invalidates this stack — mirrors the
  // server-side redoStack so both sides stay in sync.
  const redoStackRef = useRef<import("../types/protocol").SerializedStroke[]>([]);
  // Mirror of "strokes / redoStack non-empty" for toolbar enablement. Kept as
  // state so React re-renders buttons when the stacks change.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const isDrawer = myId !== null && myId === drawerId;
  // 答案发出去、phaseChange 还没回来的这一小段时间。服务端一处理 setAnswer 就会丢弃之后的画布
  // 操作，这段时间画的东西只会留在本地，所以先把画布锁住。phase 本身不动，它只听服务端的：
  // 万一答案没送到，界面还在答案模式，用户再回车不会把答案发到公开聊天里。
  const [answerPending, setAnswerPending] = useState(false);
  // 画布这边看到的阶段
  const canvasPhase: GamePhase = answerPending ? "guessing" : phase;
  // 能不能改画布。未提交的编辑内容（文字、形状、框选）提交前都要看它，服务端按同样的条件拒收。
  const canEdit = isDrawer && canvasPhase !== "guessing" && canvasPhase !== "revealed";

  // WebSocket
  const {
    connected,
    terminalReason,
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

  // Bridge: 框选工具单击。hits = 光标下全部可选元素（最上层在前）。
  // 同点再击下钻：当前选中者仍在命中列表里 → 选它下面一层，到底循环回顶。
  const handleStrokePicked = useCallback((hits: number[]) => {
    if (hits.length === 0) {
      setPicked(null);
      return;
    }
    setPicked((prev) => {
      let nextIndex = hits[0];
      if (prev && strokesRef.current[prev.index] === prev.stroke) {
        const pos = hits.indexOf(prev.index);
        if (pos !== -1) {
          nextIndex = hits[(pos + 1) % hits.length];
        }
      }
      const stroke = strokesRef.current[nextIndex];
      return stroke ? { index: nextIndex, stroke } : null;
    });
    // strokesRef 是 useCanvas 返回的稳定 ref 实例（与 syncHistoryFlags 同款约定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bridge: 框选工具空闲悬浮（useCanvas 已按命中变化去抖，只在进出元素时回调）。
  const handleStrokeHovered = useCallback((index: number | null) => {
    setHovered(index !== null ? (strokesRef.current[index] ?? null) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    releaseLocalSelection,
    resetStrokeInProgress,
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
    onStrokePicked: handleStrokePicked,
    onStrokeHovered: handleStrokeHovered,
    phase: canvasPhase,
  });

  // Canvas resize handler — blit the cached offscreen onto the (now resized)
  // visible canvas. O(1) regardless of stroke count.
  const handleCanvasResize = useCallback(() => {
    syncVisibleFromOffscreen();
    // 高亮框基于像素 bbox 计算，resize 后失真 → 直接取消选中
    setPicked(null);
  }, [syncVisibleFromOffscreen]);

  // 选择删除：删除选中笔画 + 级联删除其内部的油漆桶填充（否则重放时种子
  // 落在白底上会把整张画布灌成填充色），本地重建 + 同步对端 + 清空重做栈。
  const handlePickedDelete = useCallback(() => {
    if (!picked) {
      return;
    }
    if (phase === "guessing" || phase === "revealed") {
      setPicked(null);
      return;
    }
    const strokes = strokesRef.current;
    const { index, stroke } = picked;
    // 失效保护：选中后 strokes 已被其他路径改动（正常情况下那些路径都会先清选中态）
    if (strokes[index] !== stroke) {
      setPicked(null);
      return;
    }
    // 降序排列：依次 splice 不会移位。级联数量裁到服务端单次上限（128）以内。
    const indices = [index, ...findDependentFillIndices(strokes, index).slice(0, 127)].sort(
      (a, b) => b - a,
    );
    for (const i of indices) {
      strokes.splice(i, 1);
    }
    replayAll([...strokes]);
    redoStackRef.current = [];
    send({ type: "deleteStrokes", indices });
    syncHistoryFlags();
    setPicked(null);
  }, [picked, phase, strokesRef, replayAll, send, syncHistoryFlags]);

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

  // 是否曾经成功加入过房间。区分「首次加入」和「断线重连」两种状态：
  // 首次加入失败要报错，重连可以无限期等待（网络可能慢）。
  const hasJoinedOnceRef = useRef(false);

  // 首次加入超时兜底：10s 还没收到 roomState（myId 仍为 null）→ 报错，
  // 由下面的 joinError effect 调度退出。重连场景下 hasJoinedOnceRef 已 true，
  // 不应用此超时（避免短暂网络抖动误报）。
  useEffect(() => {
    if (myId !== null) {
      hasJoinedOnceRef.current = true;
      return;
    }
    if (hasJoinedOnceRef.current) {
      return;
    }
    if (joinError) {
      return;
    }
    const timer = window.setTimeout(() => {
      // roomState 可能已经到了，只是处理它的长任务（全量重放）跨过了截止点，effect 还没来得及清定时器
      if (myIdRef.current) {
        return;
      }
      setJoinError("加入房间超时，请检查网络或刷新页面");
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [myId, joinError]);

  // joinError 统一退出 timer：1.5s 后回到首页。case "error" 和 join 超时
  // 都走这条路径，避免多处独立 setTimeout 难以追踪。
  // 版本不符例外：要靠刷新拿新客户端。留在房间 URL、不清身份，刷新后才能带原 id 回来；
  // 回首页会清掉 playerId，提示用户刷新也回不了房间了。
  const needsRefresh = terminalReason === "version mismatch";
  useEffect(() => {
    if (!joinError || needsRefresh) {
      return;
    }
    const timer = window.setTimeout(() => onLeave(), 1500);
    return () => window.clearTimeout(timer);
  }, [joinError, needsRefresh, onLeave]);

  // 连接被服务端终止（不会再重连）：也走 joinError 退出路径。已有 joinError 时
  // 不覆盖，error / roomClosed 消息总是先于 close 到达，文案更具体。
  useEffect(() => {
    if (!terminalReason) {
      return;
    }
    setJoinError((prev) => prev || TERMINAL_CLOSE_REASONS.get(terminalReason) || "连接已断开");
  }, [terminalReason]);

  // Handle incoming messages
  // 关键：用 ref 持有最新 handler，effect 依赖只留 addListener。
  // 之前 effect 依赖里有 editingSelection 等会变化的 state，每次变化都触发
  // add/remove listener；ws.onmessage 是浏览器原生事件，理论上可能撞上 listener
  // 卸载窗口导致 roomState 等关键消息丢失 → 客户端永远卡在「连接中…」。
  // ref 模式下 listener 注册一次，handler 闭包通过 ref 读到最新 state。
  const messageHandlerRef = useRef<(msg: ServerMessage) => void>(() => {});
  messageHandlerRef.current = (msg: ServerMessage) => {
    switch (msg.type) {
      case "roomState":
        setMyId(msg.yourId);
        myIdRef.current = msg.yourId;
        // Persist playerId for reconnection on page refresh
        sessionStorage.setItem(PLAYER_ID_KEY, msg.yourId);
        setPlayers(msg.players);
        setDrawerId(msg.drawerId);
        setPhase(msg.phase);
        setAnswerPending(false);
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
        // 对端的半截笔画作废：重连期间漏了点，再收到的 move 会连成错误的线（end 会带整笔）。
        // 自己正按着鼠标且还是画手时保留，松手时 end 带整笔发出去。
        resetStrokeInProgress(
          msg.yourId === msg.drawerId && msg.phase !== "guessing" && msg.phase !== "revealed",
        );
        // 悬浮的框选作废：replayAll 已把来源区域的像素画回去，再提交就成了重影
        if (editingSelection) {
          releaseLocalSelection();
          setEditingSelection(null);
        }
        // 重做栈以服务端为准：本地可能已过期；刷新后和新人的本地栈是空的，
        // 而后续 redo 广播不带笔画内容，没有它就跟不上。
        redoStackRef.current = msg.redoStack ?? [];
        syncHistoryFlags();
        setPicked(null);
        setHovered(null);
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

      case "playerList":
        setPlayers(msg.players);
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
        setPicked(null);
        break;

      case "textStroke":
        addTextStroke(msg.text, msg.x, msg.y, msg.color, msg.fontSize, msg.colorRanges);
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

      case "deleteStrokes": {
        // indices 按约定降序发送；防御性再排一次，依次 splice 不会移位
        const sorted = [...msg.indices].sort((a, b) => b - a);
        for (const i of sorted) {
          if (i >= 0 && i < strokesRef.current.length) {
            strokesRef.current.splice(i, 1);
          }
        }
        replayAll([...strokesRef.current]);
        redoStackRef.current = [];
        syncHistoryFlags();
        setPicked(null);
        break;
      }

      case "undo": {
        const popped = strokesRef.current.pop();
        if (popped) {
          redoStackRef.current.push(popped);
        }
        replayAll([...strokesRef.current]);
        syncHistoryFlags();
        setPicked(null);
        break;
      }

      case "redo": {
        const redone = redoStackRef.current.pop();
        if (redone) {
          strokesRef.current.push(redone);
          replayAll([...strokesRef.current]);
        }
        syncHistoryFlags();
        setPicked(null);
        break;
      }

      case "phaseChange":
        setPhase(msg.phase);
        setAnswerPending(false);
        setDrawerId(msg.drawerId);
        if (msg.phase === "revealed") {
          setPendingPromotionId(msg.pendingPromotionId ?? null);
        } else {
          setPendingPromotionId(null);
        }
        if (msg.answerLength) {
          setAnswerLength(msg.answerLength);
        }
        if (msg.phase === "guessing") {
          addSystemMessage("答案已设定，开始猜词！");
        } else if (msg.phase === "revealed") {
          // 猜对者离开时服务端会重发 revealed（只是去掉 pendingPromotionId），不是又猜对一次
          if (phase !== "revealed") {
            addSystemMessage("🎉 猜对了！可以继续出题或转让画笔");
          }
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
        setPicked(null);
        break;

      case "error":
        // 未 join 完成时收到 error → 写入 joinError，由统一的 joinError effect
        // 调度 onLeave；运行时错误（已 join）走 toast。
        if (!myIdRef.current) {
          setJoinError(msg.message);
        } else {
          setToast({ message: msg.message, type: "error", id: Date.now() });
        }
        break;

      case "roomClosed":
        // 走 joinError 路径切到全屏错误屏，由统一 joinError effect 调度 1.5s
        // 后退出。否则服务端紧接着 close ws → setConnected(false) → 主 UI 上
        // 闪一下「网络异常，正在重连…」banner，体验上像 bug。
        setJoinError(`房间已关闭：${msg.reason}`);
        break;
    }
  };

  // 注册一次永远不变 —— ws.onmessage 永远命中最新的 ref handler。
  useEffect(() => {
    return addListener((msg) => messageHandlerRef.current(msg));
  }, [addListener]);

  // 答案的本地锁定要能解除：phaseChange 或 roomState 没回来（断线、半开）时不能一直锁着。
  useEffect(() => {
    if (!answerPending) {
      return;
    }
    if (!connected) {
      setAnswerPending(false);
      return;
    }
    const timer = window.setTimeout(() => setAnswerPending(false), ANSWER_LOCK_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [answerPending, connected]);

  // 不能再改画布时（进入猜词阶段、转让出去、掉线回来变猜词方……）丢掉未提交的内容，
  // 否则提交时服务端会拒收，本地永久多一条。waiting 阶段仍允许画手涂鸦，不清。
  useEffect(() => {
    if (canEdit) {
      return;
    }
    setEditingShape(null);
    setEditingText(null);
    setPicked(null);
    setHovered(null);
    if (editingSelection) {
      cancelLocalSelection();
      setEditingSelection(null);
    }
  }, [canEdit, editingSelection, cancelLocalSelection]);

  // 下面三个操作都改画布。键盘能触发工具栏按钮，所以这里也要看 canEdit，否则只改了本地。
  const handleClear = () => {
    if (!canEdit) {
      return;
    }
    setEditingShape(null);
    setEditingSelection(null);
    setPicked(null);
    redoStackRef.current = [];
    send({ type: "clear" });
    clearCanvas();
    syncHistoryFlags();
  };

  // 用键盘操作时没有 mousedown，悬浮的框选不会先提交。replayAll 会把来源像素画回去，要先取消。
  const cancelFloatingSelection = () => {
    if (editingSelection) {
      cancelLocalSelection();
      setEditingSelection(null);
    }
  };

  const handleUndo = () => {
    if (!canEdit || strokesRef.current.length === 0) {
      return;
    }
    cancelFloatingSelection();
    setPicked(null);
    const popped = strokesRef.current[strokesRef.current.length - 1];
    strokesRef.current.pop();
    redoStackRef.current.push(popped);
    replayAll([...strokesRef.current]);
    send({ type: "undo" });
    syncHistoryFlags();
  };

  const handleRedo = () => {
    if (!canEdit || redoStackRef.current.length === 0) {
      return;
    }
    cancelFloatingSelection();
    setPicked(null);
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
    setPicked(null);
    if (editingSelection) {
      cancelLocalSelection();
      setEditingSelection(null);
    }
    // 重做历史不在这里清：服务端可能拒绝（对方刚好掉线），接受时会广播 clear，到时一起清
    if (targetId) {
      send({ type: "transfer", targetId });
    } else {
      send({ type: "transfer" });
    }
  };

  const handleContinueDrawing = () => {
    setEditingShape(null);
    setPicked(null);
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
    if (!canEdit) {
      setEditingText(null);
      return;
    }
    if (!editingText || !editingText.text.trim()) {
      setEditingText(null);
      return;
    }
    const colorRanges = editingText.colorRanges.length > 0 ? editingText.colorRanges : undefined;
    addTextStroke(
      editingText.text,
      editingText.normalizedX,
      editingText.normalizedY,
      color,
      editingText.fontSize,
      colorRanges,
    );
    send({
      type: "textStroke",
      text: editingText.text,
      x: editingText.normalizedX,
      y: editingText.normalizedY,
      color,
      fontSize: editingText.fontSize,
      colorRanges,
    });
    redoStackRef.current = []; // new stroke invalidates redo history
    syncHistoryFlags();
    setEditingText(null);
  }, [canEdit, editingText, color, addTextStroke, send, syncHistoryFlags]);

  // Text tool: click on canvas to create editing text
  const handleCanvasClickForText = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (phase === "guessing" || phase === "revealed") {
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
        id: ++editingTextIdCounter,
        text: "",
        x: offsetX,
        y: offsetY,
        normalizedX: offsetX / rect.width,
        normalizedY: offsetY / rect.height,
        fontSize: TEXT_SIZE_TO_PX[textSize],
        colorRanges: [],
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
    if (!canEdit) {
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
  }, [canEdit, editingShape, addShape, send, syncHistoryFlags]);

  // Drag the overlay around (pixel + normalized both get updated)
  const handleEditingShapeUpdate = useCallback((updates: Partial<EditingShape>) => {
    setEditingShape((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  // --- Selection editing ---

  // Commit the current editing selection: paste patch at final dst + sync peer.
  const commitEditingSelection = useCallback(() => {
    if (!editingSelection) {
      return;
    }
    if (!canEdit) {
      cancelLocalSelection();
      setEditingSelection(null);
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
  }, [
    canEdit,
    editingSelection,
    cancelLocalSelection,
    commitLocalSelection,
    send,
    syncHistoryFlags,
  ]);

  // Drag the selection overlay (pixel offset only — no resize).
  const handleEditingSelectionUpdate = useCallback((updates: Partial<EditingSelection>) => {
    setEditingSelection((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  // --- 编辑态 × 按钮 ---

  // 新建文字/形状尚未 commit，丢弃即可（还没发过任何网络消息）。
  const handleEditingTextDelete = useCallback(() => {
    setEditingText(null);
  }, []);

  const handleEditingShapeDelete = useCallback(() => {
    setEditingShape(null);
  }, []);

  // 框选 ×：删除框住的内容 = 丢弃 patch + 把"src 涂白"固化成一条白色填充
  // 矩形笔画（复用 shape 协议，零新增消息；undo 弹掉白矩形即恢复原内容）。
  const handleEditingSelectionDelete = useCallback(() => {
    if (!editingSelection) {
      return;
    }
    if (!canEdit) {
      cancelLocalSelection();
      setEditingSelection(null);
      return;
    }
    const { srcNorm } = editingSelection;
    releaseLocalSelection();
    addShape(
      { x: srcNorm.x, y: srcNorm.y },
      { x: srcNorm.x + srcNorm.w, y: srcNorm.y + srcNorm.h },
      "#ffffff",
      0,
      "rect",
      true,
    );
    send({
      type: "shape",
      shape: "rect",
      filled: true,
      x: srcNorm.x,
      y: srcNorm.y,
      width: srcNorm.w,
      height: srcNorm.h,
      color: "#ffffff",
      lineWidth: 0,
    });
    redoStackRef.current = [];
    syncHistoryFlags();
    setEditingSelection(null);
  }, [
    editingSelection,
    canEdit,
    cancelLocalSelection,
    releaseLocalSelection,
    addShape,
    send,
    syncHistoryFlags,
  ]);

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
      if (t !== "selection") {
        setPicked(null);
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

  // 自动升级：猜对者本机 6.5s 后自动 claim drawer。
  // 依赖 connected：断线时 send 会被静默丢弃，重连后重新计时再发一次；
  // 服务端只在挂起的晋升仍属于自己时才接受，重复发送无害。
  useEffect(() => {
    if (!connected) {
      return;
    }
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
  }, [connected, phase, pendingPromotionId, myId, send]);

  const handleSendChat = (text: string) => {
    send({ type: "chat", text });
  };

  const handleGuess = (text: string) => {
    send({ type: "guess", text });
  };

  // 返回答案是否发出去了。没发出去时 ChatPanel 保留输入内容，用户可以直接重试。
  const handleSetAnswer = (answer: string): boolean => {
    if (!send({ type: "setAnswer", answer })) {
      setToast({ message: "网络异常，答案没有发出去，请稍后再试", type: "error", id: Date.now() });
      return false;
    }
    setAnswerText(answer);
    setAnswerPending(true);
    return true;
  };

  // 全屏 loading / 错误屏的两种触发：
  //   1. 尚未首次加入完成（myId == null）—— 显示「连接中…」或加入超时报错
  //   2. joinError 已被设置（包括服务端 error / 加入超时 / roomClosed）
  // 已加入会话且无 joinError 时，断线只在主 UI 顶部显示 banner，画板和聊天保留。
  if (!myId || joinError) {
    return (
      <div className={tx("flex items-center justify-center min-h-screen bg-gray-50")}>
        <div className={tx("text-center")}>
          {joinError ? (
            <>
              <div className={tx("text-4xl mb-4")}>😥</div>
              <div className={tx("text-red-600 font-medium")}>{joinError}</div>
              {needsRefresh ? (
                <button
                  onClick={() => window.location.reload()}
                  className={tx(
                    "mt-4 px-6 py-2 bg-primary text-white font-semibold rounded-full",
                    "hover:bg-primary-focus active:scale-95 transition-transform",
                  )}
                >
                  刷新页面
                </button>
              ) : (
                <div className={tx("text-gray-400 text-sm mt-2")}>即将返回首页...</div>
              )}
            </>
          ) : (
            <>
              <div className={tx("text-4xl mb-4 animate-bounce")}>🎨</div>
              <div className={tx("text-ink-muted")}>连接中...</div>
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
      {!connected && (
        <div
          className={tx(
            "bg-yellow-100 text-yellow-800 text-center text-sm py-1.5 rounded-lg",
            "border border-yellow-300 flex items-center justify-center gap-2",
          )}
        >
          <span className={tx("animate-spin")}>✕</span>
          <span>网络异常，正在重连...</span>
        </div>
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
            phase={canvasPhase}
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
            onEditingTextDelete={handleEditingTextDelete}
            onEditingShapeDelete={handleEditingShapeDelete}
            onEditingSelectionDelete={handleEditingSelectionDelete}
            pickedStroke={picked?.stroke ?? null}
            onPickedDelete={handlePickedDelete}
            hoveredStroke={tool === "selection" ? hovered : null}
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
            disabled={!canEdit}
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
