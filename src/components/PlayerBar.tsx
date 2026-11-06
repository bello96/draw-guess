import { useState, useRef, useEffect } from "react";
import { tx } from "@twind/core";
import type { PlayerInfo, GamePhase } from "../types/protocol";
import { copyText } from "../utils/clipboard";

function IconDropdown() {
  return (
    <svg viewBox="0 0 1024 1024" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M512 652.8c-9.728 0-19.456-3.584-27.136-11.264l-204.8-204.8c-14.848-14.848-14.848-39.424 0-54.272s39.424-14.848 54.272 0l177.664 177.664 177.664-177.664c14.848-14.848 39.424-14.848 54.272 0s14.848 39.424 0 54.272l-204.8 204.8c-7.68 7.68-17.408 11.264-27.136 11.264z" />
    </svg>
  );
}

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
          "flex items-center gap-1 px-2.5 py-1.5 rounded-full text-sm bg-gray-100 text-gray-600 hover:bg-gray-200 transition",
        )}
      >
        <span>+{players.length}</span>
        <IconDropdown />
      </button>
      {open && (
        <div
          className={tx(
            "absolute left-1/2 -translate-x-1/2 top-full mt-1 z-30",
            "bg-white rounded-lg border border-hairline py-1 min-w-[140px]",
          )}
        >
          {players.map((p) => (
            <div
              key={p.id}
              className={tx("px-3 py-1.5 text-sm text-ink flex items-center gap-1.5")}
            >
              <span>🤔</span>
              <span>{p.name}</span>
              {p.id === myId && <span className={tx("text-xs text-gray-400")}>(你)</span>}
              {p.connected === false && <span className={tx("text-xs text-ink-muted")}>离线</span>}
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
          "px-3 py-1.5 text-sm bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-full transition flex items-center gap-1",
        )}
      >
        <span>转让画笔</span>
        <IconDropdown />
      </button>
      {open && (
        <div
          className={tx(
            "absolute right-0 top-full mt-1 z-30",
            "bg-white rounded-lg border border-hairline py-1 min-w-[160px]",
          )}
        >
          {candidates.length === 0 && (
            <div className={tx("px-3 py-1.5 text-sm text-gray-400")}>无可转让玩家</div>
          )}
          {candidates.map((p) => {
            // 服务端只接受转给在线玩家，离线候选禁用，否则点了没反应
            const offline = p.connected === false;
            return (
              <button
                key={p.id}
                type="button"
                disabled={offline}
                title={offline ? "该玩家已离线，暂时无法转让" : undefined}
                onClick={() => {
                  setOpen(false);
                  onPick(p.id);
                }}
                className={tx(
                  "w-full px-3 py-1.5 text-sm text-left flex items-center gap-1.5",
                  offline ? "text-ink-muted cursor-not-allowed" : "text-ink hover:bg-amber-50",
                )}
              >
                <span>🤔</span>
                <span>{p.name}</span>
                {offline && <span className={tx("text-xs")}>离线</span>}
              </button>
            );
          })}
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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );
  // 两人房里对方掉线时不能转让（服务端只接受在线目标），按钮禁用而不是点了没反应
  const hasOnlineOther = players.some((p) => p.id !== myId && p.connected !== false);

  // Actions 区是否有按钮（继续出题 / 2 人转让 / 3+ 转让下拉）。
  // 仅在有按钮时才在按钮和「离开」之间显示分割线，避免出现裸 divider。
  const hasContinueButton =
    isDrawer &&
    phase === "revealed" &&
    (players.length === 2 || (players.length >= 3 && !pendingPromotionId));
  const has2pTransferButton = isDrawer && players.length === 2;
  const has3pTransferDropdown =
    isDrawer && players.length >= 3 && (phase !== "revealed" || !pendingPromotionId);
  const hasAnyActionButton = hasContinueButton || has2pTransferButton || has3pTransferDropdown;

  const roomUrl = `${window.location.origin}/${roomCode}`;
  const handleCopyLink = async () => {
    const ok = await copyText(roomUrl);
    setCopyState(ok ? "copied" : "failed");
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 2000);
  };

  return (
    <div
      className={tx(
        "flex items-center justify-between p-3 bg-white rounded-lg border border-hairline",
      )}
    >
      {/* Room info */}
      <div className={tx("flex items-center gap-4 flex-shrink-0")}>
        <div className={tx("flex items-center gap-2 whitespace-nowrap")}>
          <span className={tx("text-sm text-ink-muted")}>房间号</span>
          <span className={tx("font-mono text-lg font-bold text-primary tracking-wider")}>
            {roomCode}
          </span>
          {players.length < maxPlayers && (
            <button
              onClick={handleCopyLink}
              className={tx(
                "px-2 py-0.5 text-xs rounded-full transition whitespace-nowrap",
                copyState === "copied" && "bg-green-100 text-green-700",
                copyState === "failed" && "bg-red-50 text-red-600",
                copyState === "idle" &&
                  "bg-canvas-parchment text-primary hover:bg-canvas-parchment",
              )}
              title={
                copyState === "failed"
                  ? `复制失败，请手动复制：${roomUrl}`
                  : "复制房间链接分享给好友"
              }
            >
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "分享房间"}
            </button>
          )}
        </div>

        {/* Divider: 房间 | 状态 */}
        <div className={tx("w-px h-5 bg-gray-200")} />

        {/* Phase indicator */}
        <div
          className={tx(
            "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap",
            phase === "waiting" && "bg-yellow-100 text-yellow-700",
            phase === "drawing" && "bg-blue-100 text-blue-700",
            phase === "guessing" && "bg-green-100 text-green-700",
            phase === "revealed" && "bg-canvas-parchment text-ink",
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
              <div className={tx("text-xs text-ink whitespace-nowrap")}>
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
                      ? "bg-canvas-parchment text-primary-focus"
                      : "bg-gray-50 text-ink",
                    p.id === myId && "font-semibold",
                  )}
                >
                  <span>{p.id === drawerId ? "🎨" : "🤔"}</span>
                  <span>{p.name}</span>
                  {p.id === myId && <span className={tx("text-xs text-gray-400")}>(你)</span>}
                  {p.connected === false && (
                    <span className={tx("text-xs text-ink-muted")}>离线</span>
                  )}
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
      <div className={tx("flex items-center justify-end gap-2 flex-shrink-0")}>
        {isDrawer &&
          phase === "revealed" &&
          (players.length === 2 || (players.length >= 3 && !pendingPromotionId)) && (
            <button
              onClick={onContinueDrawing}
              className={tx(
                "px-3 py-1.5 text-sm bg-canvas-parchment text-primary-focus",
                "hover:bg-canvas-parchment rounded-full transition",
              )}
            >
              继续出题
            </button>
          )}
        {isDrawer && players.length === 2 && (
          <button
            onClick={() => onTransfer()}
            disabled={!hasOnlineOther}
            title={hasOnlineOther ? undefined : "对方已离线，暂时无法转让"}
            className={tx(
              "px-3 py-1.5 text-sm bg-amber-50 text-amber-700 rounded-full transition",
              hasOnlineOther ? "hover:bg-amber-100" : "opacity-50 cursor-not-allowed",
            )}
          >
            转让画笔
          </button>
        )}
        {isDrawer && players.length >= 3 && (phase !== "revealed" || !pendingPromotionId) && (
          <TransferDropdown
            candidates={players.filter((p) => p.id !== myId)}
            onPick={(id) => onTransfer(id)}
          />
        )}

        {/* Divider: 转让 | 离开（仅在有动作按钮时显示） */}
        {hasAnyActionButton && <div className={tx("w-px h-5 bg-gray-200")} />}

        <button
          onClick={onLeave}
          className={tx(
            "px-3 py-1.5 text-sm bg-gray-100 text-gray-600",
            "hover:bg-gray-200 rounded-full transition",
          )}
        >
          离开
        </button>
      </div>
    </div>
  );
}
