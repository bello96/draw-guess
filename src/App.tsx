import { useState, useEffect, useCallback } from "react";
import { tx } from "@twind/core";
import Home from "./pages/Home";
import Room from "./pages/Room";
import bgUrl from "./assets/bg.png";

/** Extract a 6-digit room code from the URL path, e.g. /438907 */
function getRoomCodeFromUrl(): string {
  const match = window.location.pathname.match(/^\/(\d{6})$/);
  return match ? match[1] : "";
}

/** Generate a default nickname like "玩家8372" */
function defaultNickname(): string {
  return "玩家" + String(Math.floor(1000 + Math.random() * 9000));
}

const NICKNAME_KEY = "draw-guess-nickname";
const PLAYER_ID_KEY = "draw-guess-playerId";

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [playerId, setPlayerId] = useState<string | undefined>(undefined);

  // URL-based join flow
  const [urlJoinCode, setUrlJoinCode] = useState("");
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [modalName, setModalName] = useState("");

  // Check URL on mount for room code
  useEffect(() => {
    const code = getRoomCodeFromUrl();
    if (!code) {
      return;
    }

    const savedName = sessionStorage.getItem(NICKNAME_KEY);
    const savedPlayerId = sessionStorage.getItem(PLAYER_ID_KEY);

    // Reconnection (page refresh) — go directly, server validates
    if (savedName && savedPlayerId) {
      enterRoom(code, savedName, savedPlayerId);
      return;
    }

    // New visitor — show nickname modal immediately (no HTTP check, server validates on WS join)
    setUrlJoinCode(code);
    setModalName(defaultNickname());
    setShowNicknameModal(true);
  }, []);

  const enterRoom = useCallback((code: string, name: string, existingPlayerId?: string) => {
    setPlayerName(name);
    setRoomCode(code);
    if (existingPlayerId) {
      setPlayerId(existingPlayerId);
    }
    sessionStorage.setItem(NICKNAME_KEY, name);
    window.history.replaceState(null, "", `/${code}`);
  }, []);

  const leaveRoom = useCallback(() => {
    setRoomCode("");
    setPlayerName("");
    setPlayerId(undefined);
    sessionStorage.removeItem(NICKNAME_KEY);
    sessionStorage.removeItem(PLAYER_ID_KEY);
    window.history.replaceState(null, "", "/");
  }, []);

  const handleNicknameConfirm = useCallback(() => {
    const name = modalName.trim() || defaultNickname();
    setShowNicknameModal(false);
    enterRoom(urlJoinCode, name);
    setUrlJoinCode("");
  }, [modalName, urlJoinCode, enterRoom]);

  // In room
  if (roomCode) {
    return (
      <Room roomCode={roomCode} playerName={playerName} playerId={playerId} onLeave={leaveRoom} />
    );
  }

  // Nickname modal for URL-based join
  if (showNicknameModal) {
    return (
      <div
        className={tx(
          "flex items-center justify-center min-h-screen p-4",
          "bg-cover bg-center bg-no-repeat",
        )}
        style={{ backgroundImage: `url(${bgUrl})` }}
      >
        <div className={tx("bg-white rounded-lg p-8 w-full max-w-sm border border-hairline")}>
          <h2 className={tx("text-xl font-bold text-center mb-2 text-primary")}>
            加入房间 {urlJoinCode}
          </h2>
          <p className={tx("text-ink-muted text-center mb-6 text-sm")}>请输入你的昵称</p>
          <input
            type="text"
            value={modalName}
            onChange={(e) => setModalName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleNicknameConfirm()}
            placeholder="输入昵称..."
            maxLength={10}
            autoFocus
            className={tx(
              "w-full px-4 py-3 border border-hairline rounded-lg mb-4",
              "focus:ring-2 focus:ring-primary focus:border-transparent",
              "outline-none transition",
            )}
          />
          <button
            onClick={handleNicknameConfirm}
            className={tx(
              "w-full py-3 px-4 bg-primary text-white font-semibold rounded-full",
              "hover:bg-primary-focus transition",
            )}
          >
            进入房间
          </button>
          <button
            onClick={() => {
              setShowNicknameModal(false);
              setUrlJoinCode("");
              window.history.replaceState(null, "", "/");
            }}
            className={tx("w-full py-2 text-ink-muted hover:text-ink transition text-sm mt-2")}
          >
            返回首页
          </button>
        </div>
      </div>
    );
  }

  // Default: Home page
  return (
    <div className={tx("min-h-screen bg-canvas")}>
      <Home onEnterRoom={enterRoom} />
    </div>
  );
}
