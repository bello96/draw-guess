// Tunable parameters and protocol constants for the GameRoom DO.
// Grouped here so behavior is adjustable without reading through room logic.

// ---------- Reconnection / lifecycle ----------

export const RECONNECT_GRACE_MS = 30_000; // 30 seconds
export const QUICK_LEAVE_GRACE_MS = 5_000; // 5 seconds (page refresh fast path)
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
// touchActivity 持久化节流间隔。高频 draw 下（60Hz）避免每条都写 storage + 重设 alarm。
// 取 30s 是相对 INACTIVITY_TIMEOUT_MS (10min) 而言的可忽略误差，换 ~1800x 写入降幅。
export const ACTIVITY_PERSIST_MIN_INTERVAL_MS = 30_000;
export const MAX_CHAT_HISTORY = 200;

// ---------- Input length caps ----------
// Defensive truncation against oversized/malicious payloads.
// Frontend input maxLength must mirror these; when changing one, change both.

export const MAX_NAME_LENGTH = 10;
export const MAX_ANSWER_LENGTH = 20;
export const MAX_CHAT_LENGTH = 200; // shared by chat + guess
export const MAX_TEXT_STROKE_LENGTH = 100;
// 文本局部上色：colorRanges 数组长度上限（text ≤ 100 字符，合法区间数不会超过）
export const MAX_TEXT_COLOR_RANGES = 100;

// ---------- Stroke storage (per-key sharding) ----------
// Strokes are stored as individual KV entries under STROKE_KEY_PREFIX so a
// complex drawing can't hit the 128KB per-value limit. Keys are zero-padded
// so lexicographic list() order matches insertion order.

export const STROKE_KEY_PREFIX = "stroke:";
// Undone strokes live under their own prefix; the key's index is the position
// in the LIFO stack, so the same padding keeps list() in stack order.
export const REDO_KEY_PREFIX = "redo:";
export const STROKE_INDEX_PAD = 10;
// DO storage batch delete is capped at 128 keys per call.
export const DELETE_BATCH_SIZE = 128;
// 单条 deleteStrokes 消息允许的最大删除条数（含级联删除的依赖填充笔画）。
export const MAX_DELETE_STROKES = 128;

// ---------- Rate limit ----------
// Token bucket, per WebSocket connection. Exhausting it signals a bug or abuse;
// we close with 1008, which the client treats as terminal.
//
// Sustained rate: current clients send at most ~60 draw messages/s (time-throttled
// in useCanvas) plus chat. The rate stays well above that because older bundles
// send one draw per animation frame, so theirs equals the display's refresh rate,
// and such tabs can stay open for hours after a deploy.
//
// Burst: this counts by arrival time, and a stalled TCP connection delivers
// everything queued at once, so a legitimate drawer can arrive far above the
// sustained rate. The capacity covers about 50s of stall at 60 messages/s.

export const RATE_LIMIT_PER_SECOND = 300;
export const RATE_LIMIT_BURST = 3000;

// ---------- Wire protocol version ----------
// Must stay in sync with `PROTOCOL_VERSION` in `src/types/protocol.ts`.
// Bump only on BREAKING changes (removed fields, changed types, changed
// semantics). Clients send their `v` in the join message and are rejected
// with "version mismatch" when it doesn't equal this value.
// NOTE: while pre-v1 clients are still live, `onJoin` treats a missing `v`
// as a legacy grace. Once all clients are v1+, tighten to strict equality.

export const PROTOCOL_VERSION = 1;

// ---------- Multiplayer room capacity ----------
// Range for `?max=N` query on POST /api/rooms. Values outside this range fall back to MIN_MAX_PLAYERS.
export const MIN_MAX_PLAYERS = 2;
export const MAX_MAX_PLAYERS = 6;
