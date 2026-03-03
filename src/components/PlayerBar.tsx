import { tx } from "@twind/core";
import type { PlayerInfo, GamePhase } from "../types/protocol";

interface Props {
  roomCode: string;
  players: PlayerInfo[];
  drawerId: string | null;
  myId: string | null;
  phase: GamePhase;
  onTransfer: () => void;
  onLeave: () => void;
}

export default function PlayerBar({
  roomCode,
  players,
  drawerId,
  myId,
  phase,
  onTransfer,
  onLeave,
}: Props) {
  const isDrawer = myId === drawerId;

  return (
    <div
      className={tx(
        "flex items-center justify-between p-3 bg-white rounded-xl shadow-sm",
      )}
    >
      {/* Room info */}
      <div className={tx("flex items-center gap-4 w-[300px]")}>
        <div className={tx("flex items-center gap-2")}>
          <span className={tx("text-sm text-gray-500")}>房间号</span>
          <span
            className={tx(
              "font-mono text-lg font-bold text-indigo-600 tracking-wider",
            )}
          >
            {roomCode}
          </span>
        </div>

        {/* Phase indicator */}
        <div
          className={tx(
            "px-2.5 py-1 rounded-full text-xs font-medium",
            phase === "waiting" && "bg-yellow-100 text-yellow-700",
            phase === "drawing" && "bg-blue-100 text-blue-700",
            phase === "guessing" && "bg-green-100 text-green-700",
            phase === "revealed" && "bg-purple-100 text-purple-700",
          )}
        >
          {phase === "waiting" && "等待中"}
          {phase === "drawing" && "绘画中"}
          {phase === "guessing" && "猜词中"}
          {phase === "revealed" && "已揭晓"}
        </div>
      </div>

      {/* Players */}
      <div className={tx("flex items-center gap-3")}>
        {players.map((p) => (
          <div
            key={p.id}
            className={tx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm",
              p.id === drawerId
                ? "bg-indigo-50 text-indigo-700"
                : "bg-gray-50 text-gray-700",
              p.id === myId && "font-semibold",
            )}
          >
            <span>{p.id === drawerId ? "🎨" : "🤔"}</span>
            <span>{p.name}</span>
            {p.id === myId && (
              <span className={tx("text-xs text-gray-400")}>(你)</span>
            )}
          </div>
        ))}
        {players.length < 2 && (
          <div className={tx("text-sm text-gray-400 animate-pulse")}>
            等待对方加入...
          </div>
        )}
      </div>

      {/* Actions */}
      <div className={tx("flex items-center justify-end gap-2 w-[300px]")}>
        {isDrawer && players.length === 2 && (
          <button
            onClick={onTransfer}
            className={tx(
              "px-3 py-1.5 text-sm bg-amber-50 text-amber-700",
              "hover:bg-amber-100 rounded-lg transition",
            )}
          >
            转让画笔
          </button>
        )}
        <button
          onClick={onLeave}
          className={tx(
            "px-3 py-1.5 text-sm bg-gray-100 text-gray-600",
            "hover:bg-gray-200 rounded-lg transition",
          )}
        >
          离开
        </button>
      </div>
    </div>
  );
}
