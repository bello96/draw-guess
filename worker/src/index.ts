export { GameRoom } from "./room";
import { MAX_ID_LENGTH, MAX_MAX_PLAYERS, MIN_MAX_PLAYERS, PLAYER_TOKEN_HEADER } from "./constants";
import { logFailure } from "./helpers";

interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ROOM_CREATE_LIMITER: RateLimit;
  CONNECT_LIMITER: RateLimit;
}

function generateRoomCode(): string {
  // 拒绝采样，避免取模带来的偏差
  const range = 1_000_000;
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(buf[0] % range).padStart(6, "0");
}

/**
 * 限流的计数键。IPv6 用户通常拿到整个 /64，按单个地址算的话换个地址就绕过了，所以取前 64 位。
 * 地址可能带 `::`，要先展开成 8 段才能知道前四段是什么。
 */
function rateLimitKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) {
    return ip;
  }
  const [head, tail] = ip.split("::").map((part) => (part ? part.split(":") : []));
  const zeros = new Array(Math.max(0, 8 - head.length - (tail?.length ?? 0))).fill("0");
  return [...head, ...zeros, ...(tail ?? [])].slice(0, 4).join(":");
}

/**
 * 按来源 IP 限流。计数按 Cloudflare 节点各自算、是近似值，防的是洪泛，不是精确配额。
 * NAT 后面可能有很多人，所以 wrangler.toml 里的上限放得很宽。
 * 本机开发不限流；限流服务出错时放行，可用性优先。
 */
async function withinLimit(limiter: RateLimit, request: Request): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || ip === "127.0.0.1" || ip === "::1") {
    return true;
  }
  try {
    return (await limiter.limit({ key: rateLimitKey(ip) })).success;
  } catch {
    return true;
  }
}

/**
 * Allowed origins for API and WebSocket access:
 * - Production domain
 * - Any localhost / 127.0.0.1 port (for `npm run dev`)
 *
 * Requests with a missing or non-whitelisted Origin are rejected with 403.
 * We currently have no server-to-server callers, so "no Origin" is treated as untrusted.
 */
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) {
    return false;
  }
  if (origin === "https://draw-guess.dengjiabei.cn") {
    return true;
  }
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    return true;
  }
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
    return true;
  }
  return false;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");

  // Handle CORS preflight — deny non-whitelisted origins up front.
  if (request.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, { headers: corsHeaders(origin!) });
  }

  // Gate every other route on a known origin. This also blocks non-browser
  // callers (no Origin header) — we have no server-to-server flows.
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden", { status: 403 });
  }
  const allowedOrigin = origin!;

  // POST /api/rooms - Create a new room with collision retry
  if (url.pathname === "/api/rooms" && request.method === "POST") {
    if (!(await withinLimit(env.ROOM_CREATE_LIMITER, request))) {
      return new Response(JSON.stringify({ error: "创建房间太频繁，请稍后再试" }), {
        status: 429,
        headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) },
      });
    }
    const MAX_RETRIES = 5;
    const maxRaw = parseInt(url.searchParams.get("max") || "2", 10);
    const maxPlayers =
      Number.isFinite(maxRaw) && maxRaw >= MIN_MAX_PLAYERS && maxRaw <= MAX_MAX_PLAYERS
        ? maxRaw
        : MIN_MAX_PLAYERS;
    for (let i = 0; i < MAX_RETRIES; i++) {
      const roomCode = generateRoomCode();
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      const initResp = await stub.fetch(
        new Request("http://internal/init?code=" + roomCode + "&max=" + maxPlayers, {
          method: "POST",
        }),
      );
      if (initResp.ok) {
        return new Response(JSON.stringify({ roomCode }), {
          headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) },
        });
      }
      // 409 Conflict — room code already in use, try another one
    }
    return new Response(JSON.stringify({ error: "房间创建失败，请重试" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) },
    });
  }

  // POST /api/rooms/:code/quickleave - Beacon-based quick leave
  const quickleaveMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/quickleave$/);
  if (quickleaveMatch && request.method === "POST") {
    if (!(await withinLimit(env.CONNECT_LIMITER, request))) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: corsHeaders(allowedOrigin),
      });
    }
    const roomCode = quickleaveMatch[1];
    const doId = env.GAME_ROOM.idFromName(roomCode);
    const stub = env.GAME_ROOM.get(doId);
    // 请求体是 token，长度不合理的不读（没有 Content-Length 的也一样）。
    // 不是 token 的格式就当没带：它还要放进请求头，非法字符会抛异常。
    const length = Number(request.headers.get("Content-Length") ?? 0);
    const body = length > 0 && length <= MAX_ID_LENGTH ? await request.text() : "";
    const token = /^[\w-]+$/.test(body) ? body : "";
    const internal = new URL("http://internal/quickleave");
    internal.search = url.search;
    await stub.fetch(
      new Request(internal, { method: "POST", headers: { [PLAYER_TOKEN_HEADER]: token } }),
    );
    return new Response("OK", { headers: corsHeaders(allowedOrigin) });
  }

  // GET /api/rooms/:code/ws - WebSocket upgrade
  const wsMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/ws$/);
  if (wsMatch) {
    // 被拒绝的升级在客户端表现为连接失败，会按退避重试，不是终止态
    if (!(await withinLimit(env.CONNECT_LIMITER, request))) {
      return new Response("Too Many Requests", { status: 429 });
    }
    const roomCode = wsMatch[1];
    const doId = env.GAME_ROOM.idFromName(roomCode);
    const stub = env.GAME_ROOM.get(doId);
    return stub.fetch(request);
  }

  return new Response("Not found", { status: 404 });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return logFailure("Worker.fetch", () => handleRequest(request, env));
  },
} satisfies ExportedHandler<Env>;
