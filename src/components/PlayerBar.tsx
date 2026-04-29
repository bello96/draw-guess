import { useState, useRef, useEffect } from "react";
import { tx } from "@twind/core";
import type { PlayerInfo, GamePhase } from "../types/protocol";

interface Props {
  roomCode: string;
  players: PlayerInfo[];
  drawerId: string | null;
  myId: string | null;
  phase: GamePhase;
  maxPlayers: number;
  pendingPromotionId?: string | null;
  onTransfer: (targetId?: string) => void;
  onContinueDrawing: () => void;
  onLeave: () => void;
}

function PlayerOverflow({ players, myId }: { players: PlayerInfo[]; myId: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className={tx("relative")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={tx(
          "flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm bg-gray-100 text-gray-600 hover:bg-gray-200 transition",
        )}
      >
        <span>+{players.length}</span>
        <span className={tx("text-xs")}>▼</span>
      </button>
      {open && (
        <div
          className={tx(
            "absolute left-1/2 -translate-x-1/2 top-full mt-1 z-30",
            "bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[140px]",
          )}
        >
          {players.map((p) => (
            <div
              key={p.id}
              className={tx(
                "px-3 py-1.5 text-sm text-gray-700 flex items-center gap-1.5",
              )}
            >
              <span>🤔</span>
              <span>{p.name}</span>
              {p.id === myId && <span className={tx("text-xs text-gray-400")}>(你)</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TransferDropdown({
  candidates,
  onPick,
}: {
  candidates: PlayerInfo[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className={tx("relative")} data-transfer-popover>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={tx(
          "px-3 py-1.5 text-sm bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-lg transition flex items-center gap-1",
        )}
      >
        <span>转让画笔</span>
        <span className={tx("text-xs")}>▼</span>
      </button>
      {open && (
        <div
          className={tx(
            "absolute right-0 top-full mt-1 z-30",
            "bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[160px]",
          )}
        >
          {candidates.length === 0 && (
            <div className={tx("px-3 py-1.5 text-sm text-gray-400")}>无可转让玩家</div>
          )}
          {candidates.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(p.id);
              }}
              className={tx(
                "w-full px-3 py-1.5 text-sm text-left text-gray-700 hover:bg-amber-50 flex items-center gap-1.5",
              )}
            >
              <span>🤔</span>
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlayerBar({
  roomCode,
  players,
  drawerId,
  myId,
  phase,
  maxPlayers,
  pendingPromotionId,
  onTransfer,
  onContinueDrawing,
  onLeave,
}: Props) {
  const isDrawer = myId === drawerId;
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    const url = `${window.location.origin}/${roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className={tx("flex items-center justify-between p-3 bg-white rounded-xl shadow-sm")}>
      {/* Room info */}
      <div className={tx("flex items-center gap-4 w-[300px]")}>
        <div className={tx("flex items-center gap-2")}>
          <span className={tx("text-sm text-gray-500")}>房间号</span>
          <span className={tx("font-mono text-lg font-bold text-indigo-600 tracking-wider")}>
            {roomCode}
          </span>
          {players.length < maxPlayers && (
            <button
              onClick={handleCopyLink}
              className={tx(
                "px-2 py-0.5 text-xs rounded-md transition",
                copied
                  ? "bg-green-100 text-green-700"
                  : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100",
              )}
              title="复制房间链接分享给好友"
            >
              {copied ? "已复制" : "分享房间"}
            </button>
          )}
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
        {phase === "revealed" &&
          pendingPromotionId &&
          (() => {
            const winner = players.find((p) => p.id === pendingPromotionId);
            if (!winner) {
              return null;
            }
            return (
              <div className={tx("text-xs text-purple-700 ml-2")}>
                🏆 {winner.name} 即将获得画笔...
              </div>
            );
          })()}
      </div>

      {/* Players */}
      <div className={tx("flex items-center gap-3")}>
        {(() => {
          const drawerPlayer = drawerId ? players.find((p) => p.id === drawerId) : undefined;
          let visible: PlayerInfo[];
          let overflow: PlayerInfo[];
          if (drawerPlayer) {
            const others = players.filter((p) => p.id !== drawerId);
            visible = others.length > 0 ? [drawerPlayer, others[0]] : [drawerPlayer];
            overflow = others.slice(1);
          } else {
            visible = players.slice(0, 2);
            overflow = players.slice(2);
          }
          return (
            <>
              {visible.map((p) => (
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
                  {p.id === myId && <span className={tx("text-xs text-gray-400")}>(你)</span>}
                </div>
              ))}
              {overflow.length > 0 && <PlayerOverflow players={overflow} myId={myId} />}
              {players.length < 2 && (
                <div className={tx("text-sm text-gray-400 animate-pulse")}>等待玩家加入...</div>
              )}
            </>
          );
        })()}
      </div>

      {/* Actions */}
      <div className={tx("flex items-center justify-end gap-2 w-[300px]")}>
        {isDrawer && players.length === 2 && phase === "revealed" && (
          <button
            onClick={onContinueDrawing}
            className={tx(
              "px-3 py-1.5 text-sm bg-indigo-50 text-indigo-700",
              "hover:bg-indigo-100 rounded-lg transition",
            )}
          >
            继续出题
          </button>
        )}
        {isDrawer && players.length === 2 && (
          <button
            onClick={() => onTransfer()}
            className={tx(
              "px-3 py-1.5 text-sm bg-amber-50 text-amber-700",
              "hover:bg-amber-100 rounded-lg transition",
            )}
          >
            转让画笔
          </button>
        )}
        {isDrawer && players.length >= 3 && phase !== "revealed" && (
          <TransferDropdown
            candidates={players.filter((p) => p.id !== myId)}
            onPick={(id) => onTransfer(id)}
          />
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
