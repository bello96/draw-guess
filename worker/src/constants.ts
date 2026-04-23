// Tunable parameters and protocol constants for the GameRoom DO.
// Grouped here so behavior is adjustable without reading through room logic.

// ---------- Reconnection / lifecycle ----------

export const RECONNECT_GRACE_MS = 30_000; // 30 seconds
export const QUICK_LEAVE_GRACE_MS = 5_000; // 5 seconds (page refresh fast path)
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_CHAT_HISTORY = 200;

// ---------- Input length caps ----------
// Defensive truncation against oversized/malicious payloads.
// Frontend input maxLength must mirror these; when changing one, change both.

export const MAX_NAME_LENGTH = 10;
export const MAX_ANSWER_LENGTH = 20;
export const MAX_CHAT_LENGTH = 200; // shared by chat + guess
export const MAX_TEXT_STROKE_LENGTH = 100;

// ---------- Stroke storage (per-key sharding) ----------
// Strokes are stored as individual KV entries under STROKE_KEY_PREFIX so a
// complex drawing can't hit the 128KB per-value limit. Keys are zero-padded
// so lexicographic list() order matches insertion order.

export const STROKE_KEY_PREFIX = "stroke:";
export const STROKE_INDEX_PAD = 10;
// DO storage batch delete is capped at 128 keys per call.
export const DELETE_BATCH_SIZE = 128;

// ---------- Rate limit ----------
// Rolling window, per WebSocket connection. Legitimate traffic ceiling is
// ~60/s (RAF-throttled draw) + ping/chat. Exceeding this signals a bug or
// abuse; we close with 1008.

export const RATE_LIMIT_WINDOW_MS = 1000;
export const RATE_LIMIT_MAX_MSGS = 150;

// ---------- Wire protocol version ----------
// Must stay in sync with `PROTOCOL_VERSION` in `src/types/protocol.ts`.
// Bump only on BREAKING changes (removed fields, changed types, changed
// semantics). Clients send their `v` in the join message and are rejected
// with "version mismatch" when it doesn't equal this value.
// NOTE: while pre-v1 clients are still live, `onJoin` treats a missing `v`
// as a legacy grace. Once all clients are v1+, tighten to strict equality.

export const PROTOCOL_VERSION = 1;
