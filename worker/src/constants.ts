// Tunable parameters and protocol constants for the GameRoom DO.
// Grouped here so behavior is adjustable without reading through room logic.

// ---------- Reconnection / lifecycle ----------

export const RECONNECT_GRACE_MS = 30_000; // 30 seconds
export const QUICK_LEAVE_GRACE_MS = 5_000; // 5 seconds (page refresh fast path)
// quickleave 标记的有效期。页面卸载时 beacon 和断线几乎同时发生，过了这么久再断线就是普通断线。
export const QUICK_LEAVE_MARK_TTL_MS = 10_000;
// 查不到名字的玩家（名册字段上线前的房间遇到实例崩溃）在玩家列表里显示这个
export const UNKNOWN_PLAYER_NAME = "玩家";
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

// 单笔手绘的最大点数，和 src/types/protocol.ts 保持一致。draw end 带整笔，存盘单值上限 2 MB，
// 3 万个点约 1.5 MB JSON（存储里是更紧凑的二进制）。客户端到这个数会自动分段。
export const MAX_STROKE_POINTS = 30_000;
// 单笔手绘路径长度上限（归一化坐标下的累计距离，1 约等于一个画布宽），和 protocol.ts 保持一致。
// 蜡笔、喷枪的渲染成本和路径长度成正比，不限的话一笔就能卡死所有人。客户端到 3/4 就分段，
// 连续乱涂也要几分钟才到得了，用户看不出来。
export const MAX_STROKE_PATH = 200;
// 房间笔画总量预算，单位见 helpers.ts 的 strokeCost。全部笔画都常驻内存，每次唤醒和每个新人
// 都要全量处理。最坏情况约 60 万个点（约 60 MB 内存）或约 28 秒的全量重放。普通一笔成本约 3，
// 要连续画半小时以上才到得了，一轮清一次画板就回到 0。
export const MAX_ROOM_STROKE_COST = 3000;

// ---------- Message validation bounds (see validate.ts) ----------
// 这些是防滥用的上限，都比前端能发出的值宽很多：合法消息被丢弃会造成分叉。

// 最大的合法消息是带整笔的 draw end（约 1.5 MB）。更大的不解析，直接丢弃。
export const MAX_MESSAGE_LENGTH = 4 * 1024 * 1024;
// 归一化坐标的绝对值上限。编辑框按屏幕拖动，多显示器下能到画布宽度的十几倍。
export const MAX_COORDINATE = 64;
// 框选的来源矩形：只能在画布内开始，留一点余量给舍入。
export const MAX_SELECTION_EXTENT = 1.05;
export const MAX_LINE_WIDTH = 200; // UI 里最大 12
export const MAX_FONT_SIZE = 512; // UI 里最大 72
export const MAX_TOLERANCE = 255; // 填充容差是单通道差值
// playerId 和重连 token 都是 UUID（36 字符）
export const MAX_ID_LENGTH = 64;

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

// 写存储的消息（聊天、猜词、落笔等）另算一个桶：上面的限额按消息数算，防不住写入额度被刷光。
// 人的操作远低于持续速率；突发按卡顿 50 秒、每秒几次操作的积压来留。
export const WRITE_RATE_LIMIT_PER_SECOND = 20;
export const WRITE_RATE_LIMIT_BURST = 600;

// ---------- Connections that never join ----------
// 连上后要马上发 join。超时或超过数量上限就关掉（最旧的先关），挡不住新人进房。
// close reason 不在客户端的终止态名单里：真有慢客户端被关，它会自己重连。
export const UNJOINED_TIMEOUT_MS = 30_000;
export const MAX_UNJOINED_CONNECTIONS = 16;

// ---------- Wire protocol version ----------
// Must stay in sync with `PROTOCOL_VERSION` in `src/types/protocol.ts`.
// Bump only on BREAKING changes (removed fields, changed types, changed
// semantics). Clients send their `v` in the join message and are rejected
// with "version mismatch" when it doesn't equal this value.
// NOTE: while pre-v1 clients are still live, `onJoin` treats a missing `v`
// as a legacy grace. Once all clients are v1+, tighten to strict equality.

export const PROTOCOL_VERSION = 1;

// ---------- Internal Worker → DO ----------
// quickleave 的 token 走 beacon 的请求体（不进 URL，免得出现在日志里）。Worker 读出来后
// 放进这个头转给 DO，这样超长的请求体不用读，也不用把请求流接到 DO 上。
export const PLAYER_TOKEN_HEADER = "X-Player-Token";

// ---------- Multiplayer room capacity ----------
// Range for `?max=N` query on POST /api/rooms. Values outside this range fall back to MIN_MAX_PLAYERS.
export const MIN_MAX_PLAYERS = 2;
export const MAX_MAX_PLAYERS = 6;
