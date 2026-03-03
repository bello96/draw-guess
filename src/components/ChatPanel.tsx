import { useState, useRef, useEffect } from "react";
import { tx } from "@twind/core";
import type { ChatMessage, GamePhase } from "../types/protocol";

type InputMode = "chat" | "setAnswer" | "guess";

interface Props {
  messages: ChatMessage[];
  phase: GamePhase;
  isDrawer: boolean;
  answerLength: number | null;
  onSendChat: (text: string) => void;
  onGuess: (text: string) => void;
  onSetAnswer: (answer: string) => void;
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
    borderColor: "border-gray-300",
    focusRing: "focus:ring-gray-400",
    btnBg: "bg-gray-600",
    btnHover: "hover:bg-gray-700",
    placeholder: "发送消息...",
  },
  setAnswer: {
    label: "答案",
    btnText: "确认",
    borderColor: "border-indigo-400",
    focusRing: "focus:ring-indigo-400",
    btnBg: "bg-indigo-600",
    btnHover: "hover:bg-indigo-700",
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
  answerLength,
  onSendChat,
  onGuess,
  onSetAnswer,
}: Props) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InputMode>("chat");
  const listRef = useRef<HTMLDivElement>(null);

  // Compute available modes based on game state
  const availableModes: InputMode[] = ["chat"];
  if (isDrawer && phase === "drawing") {
    availableModes.push("setAnswer");
  }
  if (!isDrawer && phase === "guessing") {
    availableModes.push("guess");
  }

  // Auto-switch to chat if current mode is no longer available
  useEffect(() => {
    if (!availableModes.includes(mode)) {
      setMode("chat");
    }
  }, [phase, isDrawer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");

    switch (mode) {
      case "chat":
        onSendChat(text);
        break;
      case "setAnswer":
        onSetAnswer(text);
        break;
      case "guess":
        onGuess(text);
        break;
    }
  };

  const cycleMode = () => {
    const idx = availableModes.indexOf(mode);
    const next = availableModes[(idx + 1) % availableModes.length];
    setMode(next);
    setInput("");
  };

  const cfg = MODE_CONFIG[mode];

  return (
    <div
      className={tx(
        "flex flex-col h-full bg-white rounded-xl shadow-sm overflow-hidden",
      )}
    >
      {/* Header */}
      <div className={tx("px-4 py-3 border-b border-gray-100")}>
        <h3 className={tx("font-semibold text-gray-700")}>聊天</h3>
        {!isDrawer && phase === "guessing" && answerLength && (
          <div className={tx("text-sm text-green-600 mt-1")}>
            提示：答案共 {answerLength} 个字 {"_ ".repeat(answerLength).trim()}
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className={tx("flex-1 overflow-y-auto p-3 space-y-2 min-h-0")}
      >
        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.kind === "system" ? (
              <div className={tx("text-center text-xs text-gray-400 py-1")}>
                {msg.text}
              </div>
            ) : msg.kind === "guess" ? (
              <div
                className={tx(
                  "px-3 py-2 rounded-lg text-sm",
                  msg.correct
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-red-50 text-red-600 border border-red-200",
                )}
              >
                <span className={tx("font-medium")}>{msg.playerName}</span>
                <span className={tx("mx-1")}>猜：</span>
                <span>{msg.text}</span>
                <span className={tx("ml-2")}>
                  {msg.correct ? "✅ 正确!" : "❌ 不对"}
                </span>
              </div>
            ) : (
              <div className={tx("text-sm")}>
                <span className={tx("font-medium text-indigo-600")}>
                  {msg.playerName}
                </span>
                <span className={tx("text-gray-400 mx-1")}>:</span>
                <span className={tx("text-gray-700")}>{msg.text}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Unified input */}
      <div className={tx("px-3 py-2 border-t border-gray-100")}>
        {mode === "setAnswer" && (
          <div className={tx("text-xs text-indigo-600 mb-1.5")}>
            设置答案后对方才能开始猜
          </div>
        )}
        <div className={tx("flex gap-2 items-center")}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={cfg.placeholder}
            className={tx(
              "flex-1 px-3 py-2 text-sm border-2 rounded-lg",
              cfg.borderColor,
              "focus:ring-2",
              cfg.focusRing,
              "focus:border-transparent outline-none",
              "transition-colors",
            )}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
          <button
            onClick={handleSubmit}
            className={tx(
              "px-4 py-2 text-sm text-white rounded-lg transition shrink-0",
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
                "px-2.5 py-2 text-xs font-medium rounded-lg transition shrink-0",
                mode === "chat" &&
                  "bg-gray-100 text-gray-600 hover:bg-gray-200",
                mode === "setAnswer" &&
                  "bg-indigo-100 text-indigo-700 hover:bg-indigo-200",
                mode === "guess" &&
                  "bg-green-100 text-green-700 hover:bg-green-200",
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
