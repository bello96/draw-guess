import { useState, useEffect, useCallback } from "react";
import { tx } from "@twind/core";
import Home from "./pages/Home";
import Room from "./pages/Room";
import { apiUrl } from "./api";

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
  const [urlJoinError, setUrlJoinError] = useState("");
  const [urlJoinLoading, setUrlJoinLoading] = useState(false);
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [modalName, setModalName] = useState("");

  // Check URL on mount for room code
  useEffect(() => {
    const code = getRoomCodeFromUrl();
    if (!code) return;

    setUrlJoinCode(code);
    setUrlJoinLoading(true);

    const savedName = sessionStorage.getItem(NICKNAME_KEY);
    const savedPlayerId = sessionStorage.getItem(PLAYER_ID_KEY);

    // If we have a saved playerId, this is a reconnection (page refresh).
    // Skip the room check and try to reconnect directly — the server will validate.
    if (savedName && savedPlayerId) {
      enterRoom(code, savedName, savedPlayerId);
      setUrlJoinCode("");
      setUrlJoinLoading(false);
      return;
    }

    fetch(apiUrl(`/api/rooms/${code}`))
      .then((res) => res.json())
      .then((data) => {
        if (!data.created) {
          setUrlJoinError("房间不存在");
          setTimeout(() => {
            window.history.replaceState(null, "", "/");
            setUrlJoinCode("");
            setUrlJoinError("");
          }, 2000);
        } else if (data.closed || data.playerCount >= 2) {
          setUrlJoinError("房间已满，无法加入");
          setTimeout(() => {
            window.history.replaceState(null, "", "/");
            setUrlJoinCode("");
            setUrlJoinError("");
          }, 2000);
        } else {
          // Room exists and has space — new visitor, show nickname modal
          setModalName(defaultNickname());
          setShowNicknameModal(true);
        }
      })
      .catch(() => {
        setUrlJoinError("检查房间失败，请重试");
        setTimeout(() => {
          window.history.replaceState(null, "", "/");
          setUrlJoinCode("");
          setUrlJoinError("");
        }, 2000);
      })
      .finally(() => setUrlJoinLoading(false));
  }, []);

  const enterRoom = useCallback((code: string, name: string, existingPlayerId?: string) => {
    setPlayerName(name);
    setRoomCode(code);
    if (existingPlayerId) setPlayerId(existingPlayerId);
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

  // URL join: loading or error overlay
  if (urlJoinCode && (urlJoinLoading || urlJoinError)) {
    return (
      <div
        className={tx(
          "flex items-center justify-center min-h-screen bg-gradient-to-br from-indigo-50 to-purple-50",
        )}
      >
        <div className={tx("bg-white rounded-2xl shadow-xl p-8 text-center")}>
          {urlJoinLoading && (
            <>
              <div className={tx("text-4xl mb-4 animate-bounce")}>🎨</div>
              <div className={tx("text-gray-500")}>
                正在检查房间 {urlJoinCode} ...
              </div>
            </>
          )}
          {urlJoinError && (
            <>
              <div className={tx("text-4xl mb-4")}>😥</div>
              <div className={tx("text-red-600 font-medium")}>{urlJoinError}</div>
              <div className={tx("text-gray-400 text-sm mt-2")}>
                即将返回首页...
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // Nickname modal for URL-based join
  if (showNicknameModal) {
    return (
      <div
        className={tx(
          "flex items-center justify-center min-h-screen bg-gradient-to-br from-indigo-50 to-purple-50",
        )}
      >
        <div className={tx("bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm")}>
          <h2 className={tx("text-xl font-bold text-center mb-2 text-indigo-600")}>
            加入房间 {urlJoinCode}
          </h2>
          <p className={tx("text-gray-500 text-center mb-6 text-sm")}>
            请输入你的昵称
          </p>
          <input
            type="text"
            value={modalName}
            onChange={(e) => setModalName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleNicknameConfirm()}
            placeholder="输入昵称..."
            maxLength={10}
            autoFocus
            className={tx(
              "w-full px-4 py-3 border border-gray-300 rounded-lg mb-4",
              "focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
              "outline-none transition",
            )}
          />
          <button
            onClick={handleNicknameConfirm}
            className={tx(
              "w-full py-3 px-4 bg-indigo-600 text-white font-semibold rounded-lg",
              "hover:bg-indigo-700 transition",
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
            className={tx(
              "w-full py-2 text-gray-500 hover:text-gray-700 transition text-sm mt-2",
            )}
          >
            返回首页
          </button>
        </div>
      </div>
    );
  }

  // Default: Home page
  return (
    <div
      className={tx(
        "min-h-screen bg-gradient-to-br from-indigo-50 to-purple-50",
      )}
    >
      <Home onEnterRoom={enterRoom} />
    </div>
  );
}
