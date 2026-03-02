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
  onSetAnswer: (answer: string, timerSeconds?: number) => void;
}

const TIMER_OPTIONS = [
  { label: "不限时", value: 0 },
  { label: "30秒", value: 30 },
  { label: "1分钟", value: 60 },
  { label: "3分钟", value: 180 },
  { label: "5分钟", value: 300 },
];

export default function ChatPanel({
  messages,
  phase,
  isDrawer,
  answerLength,
  onSendChat,
  onGuess,
  onSetAnswer,
}: Props) {
  const [chatInput, setChatInput] = useState("");
  const [guessInput, setGuessInput] = useState("");
  const [answer, setAnswer] = useState("");
  const [timerOption, setTimerOption] = useState(60);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendChat = () => {
    if (!chatInput.trim()) return;
    onSendChat(chatInput.trim());
    setChatInput("");
  };

  const handleGuess = () => {
    if (!guessInput.trim()) return;
    onGuess(guessInput.trim());
    setGuessInput("");
  };

  const handleSetAnswer = () => {
    if (!answer.trim()) return;
    onSetAnswer(answer.trim(), timerOption || undefined);
    setAnswer("");
  };

  const showGuessInput = !isDrawer && phase === "guessing";

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
          <div className={tx("flex gap-2 mb-2")}>
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
          <div className={tx("flex items-center gap-2")}>
            <span className={tx("text-xs text-indigo-500")}>倒计时:</span>
            <select
              value={timerOption}
              onChange={(e) => setTimerOption(Number(e.target.value))}
              className={tx(
                "text-xs px-2 py-1 border border-indigo-200 rounded-lg bg-white",
                "focus:ring-2 focus:ring-indigo-400 outline-none",
              )}
            >
              {TIMER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Guess input (guesser only, during guessing phase) */}
      {showGuessInput && (
        <div className={tx("px-3 py-2 border-t border-green-200 bg-green-50")}>
          <div className={tx("flex gap-2")}>
            <input
              type="text"
              value={guessInput}
              onChange={(e) => setGuessInput(e.target.value)}
              placeholder="输入你的猜测..."
              className={tx(
                "flex-1 px-3 py-2 text-sm border border-green-300 rounded-lg",
                "focus:ring-2 focus:ring-green-400 focus:border-transparent outline-none",
              )}
              onKeyDown={(e) => e.key === "Enter" && handleGuess()}
            />
            <button
              onClick={handleGuess}
              className={tx(
                "px-4 py-2 text-sm bg-green-600 text-white rounded-lg",
                "hover:bg-green-700 transition",
              )}
            >
              猜
            </button>
          </div>
        </div>
      )}

      {/* Chat input (always visible) */}
      <div className={tx("px-3 py-2 border-t border-gray-100")}>
        <div className={tx("flex gap-2")}>
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="发送消息..."
            className={tx(
              "flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg",
              "focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none",
            )}
            onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
          />
          <button
            onClick={handleSendChat}
            className={tx(
              "px-4 py-2 text-sm bg-gray-600 text-white rounded-lg",
              "hover:bg-gray-700 transition",
            )}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
