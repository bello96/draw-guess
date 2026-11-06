import { useState, useRef, useEffect } from "react";
import { tx } from "@twind/core";
import type { ChatMessage, GamePhase } from "../types/protocol";
import { isImeComposing } from "../utils/keyboard";

type InputMode = "chat" | "setAnswer" | "guess";

interface Props {
  messages: ChatMessage[];
  phase: GamePhase;
  isDrawer: boolean;
  myId: string | null;
  answerLength: number | null;
  answerText: string | null;
  playerCount: number;
  // 下面三个都返回是否发出去了。没发出去时输入框保留内容，用户可以直接重试。
  onSendChat: (text: string) => boolean;
  onGuess: (text: string) => boolean;
  onSetAnswer: (answer: string) => boolean;
}

// 这个角色在这个阶段最常用的模式：画手在绘画阶段设答案，猜词方在猜词阶段猜。
// 默认是聊天的话，直接打出来的答案会明文发给所有人。
function preferredMode(phase: GamePhase, isDrawer: boolean): InputMode {
  if (isDrawer && phase === "drawing") {
    return "setAnswer";
  }
  if (!isDrawer && phase === "guessing") {
    return "guess";
  }
  return "chat";
}

const MODE_CONFIG: Record<
  InputMode,
  {
    label: string;
    btnText: string;
    borderColor: string;
    focusRing: string;
    btnBg: string;
    btnHover: string;
    placeholder: string;
  }
> = {
  chat: {
    label: "聊天",
    btnText: "发送",
    borderColor: "border-hairline",
    focusRing: "focus:ring-gray-400",
    btnBg: "bg-gray-600",
    btnHover: "hover:bg-gray-700",
    placeholder: "发送消息...",
  },
  setAnswer: {
    label: "答案",
    btnText: "确认",
    borderColor: "border-primary",
    focusRing: "focus:ring-primary",
    btnBg: "bg-primary",
    btnHover: "hover:bg-primary-focus",
    placeholder: "输入正确答案...",
  },
  guess: {
    label: "答案",
    btnText: "猜测",
    borderColor: "border-green-400",
    focusRing: "focus:ring-green-400",
    btnBg: "bg-green-600",
    btnHover: "hover:bg-green-700",
    placeholder: "输入你的猜测...",
  },
};

export default function ChatPanel({
  messages,
  phase,
  isDrawer,
  myId,
  answerLength,
  answerText,
  playerCount,
  onSendChat,
  onGuess,
  onSetAnswer,
}: Props) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InputMode>(() => preferredMode(phase, isDrawer));
  // 阶段变了但输入框里还有字：先不切，等这些字发出去（输入框空了）再切到这里记的模式
  const pendingModeRef = useRef<InputMode | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 能用的模式：聊天，加上这个阶段的专用模式（画手设答案、猜词方猜）
  const preferred = preferredMode(phase, isDrawer);
  const availableModes: InputMode[] = preferred === "chat" ? ["chat"] : ["chat", preferred];

  // 阶段或角色变了，切到这个阶段最常用的模式；同一阶段里手动切走的模式保持不变。输入框里有字时：
  // - 当前模式还能用：先不切，这条发出去再切。否则正在打的聊天一回车就成了答案或猜测
  // - 当前模式不能用了（打的是答案或猜测）：字丢掉。退回聊天还留着的话，一回车答案就明文发给了所有人
  useEffect(() => {
    if (!input.trim()) {
      pendingModeRef.current = null;
      setMode(preferred);
      return;
    }
    if (availableModes.includes(mode)) {
      pendingModeRef.current = mode === preferred ? null : preferred;
      return;
    }
    pendingModeRef.current = null;
    setInput("");
    setMode(preferred);
  }, [phase, isDrawer]); // eslint-disable-line react-hooks/exhaustive-deps

  // 输入框空了，补上前面推迟的切换
  useEffect(() => {
    const pending = pendingModeRef.current;
    if (pending !== null && !input.trim()) {
      pendingModeRef.current = null;
      if (availableModes.includes(pending)) {
        setMode(pending);
      }
    }
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  // 模式变了把焦点给输入框，但不抢别的输入框（比如画手正在画布上打字时第二个人进来、切到答案模式）。
  // 不滚动页面：body 最小宽度 1200px，窗口窄时输入框在视口外，滚过去会让画布在鼠标底下挪位
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const editingElsewhere =
      !!active &&
      active !== inputRef.current &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (!editingElsewhere) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [mode]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = () => {
    if (!input.trim()) {
      return;
    }
    const text = input.trim();
    setInput("");

    // 没发出去就把内容放回去，重试时不用重打
    const sent =
      mode === "chat" ? onSendChat(text) : mode === "setAnswer" ? onSetAnswer(text) : onGuess(text);
    if (!sent) {
      setInput(text);
    }
  };

  const cycleMode = () => {
    const idx = availableModes.indexOf(mode);
    const next = availableModes[(idx + 1) % availableModes.length];
    // 用户自己选了模式，推迟的自动切换作废
    pendingModeRef.current = null;
    setMode(next);
    setInput("");
  };

  const cfg = MODE_CONFIG[mode];

  return (
    <div
      className={tx(
        "flex flex-col h-full bg-white rounded-lg overflow-hidden border border-hairline",
      )}
    >
      {/* Header */}
      <div className={tx("px-4 py-3 border-b border-gray-100")}>
        <h3 className={tx("font-semibold text-ink")}>聊天区</h3>
        {isDrawer && answerText && (phase === "guessing" || phase === "revealed") && (
          <div className={tx("text-sm text-primary mt-1")}>答案：{answerText}</div>
        )}
        {!isDrawer && phase === "guessing" && answerLength && (
          <div className={tx("text-sm text-green-600 mt-1")}>
            提示：答案共 {answerLength} 个字 {"_ ".repeat(answerLength).trim()}
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={listRef} className={tx("flex-1 overflow-y-auto p-3 space-y-2 min-h-0")}>
        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.kind === "system" ? (
              <div className={tx("text-center text-xs text-gray-400 py-1")}>{msg.text}</div>
            ) : msg.kind === "guess" ? (
              <div
                className={tx(
                  "px-3 py-2 rounded-lg text-sm",
                  msg.correct
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-red-50 text-red-600 border border-red-200",
                )}
              >
                <span className={tx("font-medium")}>
                  {msg.playerName}
                  {msg.playerId === myId && "（你）"}
                </span>
                <span className={tx("mx-1")}>猜：</span>
                <span>{msg.text}</span>
                <span className={tx("ml-2")}>{msg.correct ? "✅ 正确!" : "❌ 不对"}</span>
              </div>
            ) : (
              <div className={tx("text-sm")}>
                <span className={tx("font-medium text-primary")}>
                  {msg.playerName}
                  {msg.playerId === myId && "（你）"}
                </span>
                <span className={tx("text-gray-400 mx-1")}>:</span>
                <span className={tx("text-ink")}>{msg.text}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Unified input */}
      <div className={tx("px-3 py-2 border-t border-gray-100")}>
        {mode === "setAnswer" && (
          <div className={tx("text-xs text-primary mb-1.5")}>
            {playerCount > 2 ? "设置答案后其他玩家才能开始猜" : "设置答案后对方才能开始猜"}
          </div>
        )}
        <div className={tx("flex gap-2 items-center")}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={cfg.placeholder}
            maxLength={mode === "setAnswer" ? 20 : 200}
            className={tx(
              "flex-1 px-3 py-2 text-sm border-2 rounded-lg",
              cfg.borderColor,
              "focus:ring-2",
              cfg.focusRing,
              "focus:border-transparent outline-none",
              "transition-colors",
            )}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) {
                handleSubmit();
              }
            }}
          />
          <button
            onClick={handleSubmit}
            className={tx(
              "px-4 py-2 text-sm text-white rounded-full transition shrink-0",
              cfg.btnBg,
              cfg.btnHover,
            )}
          >
            {cfg.btnText}
          </button>
          {availableModes.length > 1 && (
            <button
              onClick={cycleMode}
              title="切换输入模式"
              className={tx(
                "px-2.5 py-2 text-xs font-medium rounded-full transition shrink-0",
                mode === "chat" && "bg-gray-100 text-gray-600 hover:bg-gray-200",
                mode === "setAnswer" &&
                  "bg-canvas-parchment text-primary-focus hover:bg-canvas-parchment",
                mode === "guess" && "bg-green-100 text-green-700 hover:bg-green-200",
              )}
            >
              {(() => {
                const idx = availableModes.indexOf(mode);
                const next = availableModes[(idx + 1) % availableModes.length];
                return MODE_CONFIG[next].label;
              })()}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
