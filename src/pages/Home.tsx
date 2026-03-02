import { useState } from "react";
import { tx } from "@twind/core";
import { apiUrl } from "../api";

interface Props {
  onEnterRoom: (roomCode: string, playerName: string) => void;
}

export default function Home({ onEnterRoom }: Props) {
  const [mode, setMode] = useState<"menu" | "join">("menu");
  const [joinCode, setJoinCode] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("请输入昵称");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl("/api/rooms"), { method: "POST" });
      const data = await res.json();
      onEnterRoom(data.roomCode, name.trim());
    } catch {
      setError("创建房间失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!name.trim()) {
      setError("请输入昵称");
      return;
    }
    if (joinCode.length !== 6) {
      setError("请输入6位房间号");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl(`/api/rooms/${joinCode}`));
      const data = await res.json();
      if (!data.created) {
        setError("房间不存在");
        setLoading(false);
        return;
      }
      if (data.closed || data.playerCount >= 2) {
        setError("房间已满，无法加入");
        setLoading(false);
        return;
      }
      onEnterRoom(joinCode, name.trim());
    } catch {
      setError("加入房间失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={tx("flex flex-col items-center justify-center min-h-screen p-4")}>
      <div className={tx("bg-white rounded-2xl shadow-xl p-8 w-full max-w-md")}>
        <h1 className={tx("text-4xl font-bold text-center mb-2 text-indigo-600")}>
          🎨 我画你猜
        </h1>
        <p className={tx("text-gray-500 text-center mb-8")}>
          和朋友一起画画猜词吧！
        </p>

        {/* Name input */}
        <div className={tx("mb-6")}>
          <label className={tx("block text-sm font-medium text-gray-700 mb-1")}>
            你的昵称
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入昵称..."
            maxLength={10}
            className={tx(
              "w-full px-4 py-3 border border-gray-300 rounded-lg",
              "focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
              "outline-none transition",
            )}
          />
        </div>

        {error && (
          <div className={tx("bg-red-50 text-red-600 px-4 py-2 rounded-lg mb-4 text-sm")}>
            {error}
          </div>
        )}

        {mode === "menu" ? (
          <div className={tx("space-y-3")}>
            <button
              onClick={handleCreate}
              disabled={loading}
              className={tx(
                "w-full py-3 px-4 bg-indigo-600 text-white font-semibold rounded-lg",
                "hover:bg-indigo-700 transition disabled:opacity-50",
              )}
            >
              {loading ? "创建中..." : "创建房间"}
            </button>
            <button
              onClick={() => setMode("join")}
              className={tx(
                "w-full py-3 px-4 bg-white text-indigo-600 font-semibold rounded-lg",
                "border-2 border-indigo-600 hover:bg-indigo-50 transition",
              )}
            >
              加入房间
            </button>
          </div>
        ) : (
          <div className={tx("space-y-3")}>
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="输入6位房间号"
              maxLength={6}
              className={tx(
                "w-full px-4 py-3 border border-gray-300 rounded-lg text-center text-2xl tracking-[0.5em]",
                "focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
                "outline-none transition",
              )}
            />
            <button
              onClick={handleJoin}
              disabled={loading}
              className={tx(
                "w-full py-3 px-4 bg-indigo-600 text-white font-semibold rounded-lg",
                "hover:bg-indigo-700 transition disabled:opacity-50",
              )}
            >
              {loading ? "加入中..." : "加入房间"}
            </button>
            <button
              onClick={() => {
                setMode("menu");
                setJoinCode("");
                setError("");
              }}
              className={tx("w-full py-2 text-gray-500 hover:text-gray-700 transition text-sm")}
            >
              返回
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
