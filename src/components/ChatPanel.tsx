import { useState, useRef, useEffect } from "react";
import { tx } from "@twind/core";
import type { ChatMessage, GamePhase } from "../types/protocol";

interface Props {
  messages: ChatMessage[];
  phase: GamePhase;
  isDrawer: boolean;
  answerLength: number | null;
  onSendChat: (text: string) => void;
  onGuess: (text: string) => void;
  onSetAnswer: (answer: string) => void;
}

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
  const [answer, setAnswer] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    if (!isDrawer && phase === "guessing") {
      onGuess(input.trim());
    } else {
      onSendChat(input.trim());
    }
    setInput("");
  };

  const handleSetAnswer = () => {
    if (!answer.trim()) return;
    onSetAnswer(answer.trim());
    setAnswer("");
  };

  return (
    <div className={tx("flex flex-col h-full bg-white rounded-xl shadow-sm overflow-hidden")}>
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
                <span className={tx("font-medium")}>{msg.playerName}</span>
                <span className={tx("mx-1")}>猜：</span>
                <span>{msg.text}</span>
                <span className={tx("ml-2")}>{msg.correct ? "✅ 正确!" : "❌ 不对"}</span>
              </div>
            ) : (
              <div className={tx("text-sm")}>
                <span className={tx("font-medium text-indigo-600")}>{msg.playerName}</span>
                <span className={tx("text-gray-400 mx-1")}>:</span>
                <span className={tx("text-gray-700")}>{msg.text}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Answer input (drawer only, during drawing phase) */}
      {isDrawer && phase === "drawing" && (
        <div className={tx("px-3 py-2 border-t border-gray-100 bg-indigo-50")}>
          <div className={tx("text-xs text-indigo-600 mb-1.5")}>设置答案后对方才能开始猜</div>
          <div className={tx("flex gap-2")}>
            <input
              type="text"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="输入正确答案..."
              className={tx(
                "flex-1 px-3 py-2 text-sm border border-indigo-200 rounded-lg",
                "focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none",
              )}
              onKeyDown={(e) => e.key === "Enter" && handleSetAnswer()}
            />
            <button
              onClick={handleSetAnswer}
              className={tx(
                "px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg",
                "hover:bg-indigo-700 transition",
              )}
            >
              确认
            </button>
          </div>
        </div>
      )}

      {/* Chat / Guess input */}
      <div className={tx("px-3 py-2 border-t border-gray-100")}>
        <div className={tx("flex gap-2")}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              !isDrawer && phase === "guessing" ? "输入你的猜测..." : "发送消息..."
            }
            className={tx(
              "flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg",
              "focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none",
            )}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
          />
          <button
            onClick={handleSend}
            className={tx(
              "px-4 py-2 text-sm rounded-lg transition",
              !isDrawer && phase === "guessing"
                ? "bg-green-600 text-white hover:bg-green-700"
                : "bg-gray-600 text-white hover:bg-gray-700",
            )}
          >
            {!isDrawer && phase === "guessing" ? "猜" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
