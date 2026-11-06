import { lazy, Suspense, useState, useEffect, useCallback } from "react";
import { tx } from "@twind/core";
import Home from "./pages/Home";
import { PLAYER_ID_KEY, PLAYER_TOKEN_KEY } from "./hooks/useWebSocket";
import bgUrl from "./assets/bg.webp";

const CHUNK_RELOAD_KEY = "draw-guess-chunk-reload";

// 房间页（画板、工具栏、颜色选择器）单独分包，首页不用下载这些代码。
const loadRoom = () => import("./pages/Room");

// 发版后旧标签页再请求旧的 chunk 会失败（文件已经不在了，回退成 HTML）。刷新一次拿新版本；
// 再失败或者断网了，刷新也没用，交给 ErrorBoundary 提示，不能一直自动刷新。
const Room = lazy(async () => {
  try {
    const page = await loadRoom();
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    return page;
  } catch (err) {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) || !navigator.onLine) {
      sessionStorage.removeItem(CHUNK_RELOAD_KEY);
      throw err;
    }
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
    window.location.reload();
    return new Promise<never>(() => {});
  }
});

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

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [playerId, setPlayerId] = useState<string | undefined>(undefined);

  // URL-based join flow
  const [urlJoinCode, setUrlJoinCode] = useState("");
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [modalName, setModalName] = useState("");

  // 空闲时提前下载房间页：进房间不用等，开着首页时发版也不会碰到旧 chunk 失效
  useEffect(() => {
    const preload = () => {
      void loadRoom().catch(() => {
        // 真正进房间时会再试，失败处理在上面
      });
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(preload, { timeout: 3000 });
      return () => cancelIdleCallback(id);
    }
    const timer = window.setTimeout(preload, 1500);
    return () => window.clearTimeout(timer);
  }, []);

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
    // 有保存的昵称（比如进房间时页面代码没下载成功、自动刷新了一次）就沿用
    setModalName(savedName || defaultNickname());
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
    sessionStorage.removeItem(PLAYER_TOKEN_KEY);
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
      <Suspense
        fallback={
          <div className={tx("flex items-center justify-center min-h-screen bg-canvas-parchment")}>
            <div className={tx("text-center")}>
              <div className={tx("text-4xl mb-4 animate-bounce")}>🎨</div>
              <div className={tx("text-ink-muted")}>连接中...</div>
            </div>
          </div>
        }
      >
        <Room roomCode={roomCode} playerName={playerName} playerId={playerId} onLeave={leaveRoom} />
      </Suspense>
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
