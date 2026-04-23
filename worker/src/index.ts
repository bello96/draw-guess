export { GameRoom } from "./room";

interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

function generateRoomCode(): string {
  const chars = "0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      const MAX_RETRIES = 5;
      for (let i = 0; i < MAX_RETRIES; i++) {
        const roomCode = generateRoomCode();
        const doId = env.GAME_ROOM.idFromName(roomCode);
        const stub = env.GAME_ROOM.get(doId);
        const initResp = await stub.fetch(
          new Request("http://internal/init?code=" + roomCode, { method: "POST" }),
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
      const roomCode = quickleaveMatch[1];
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      await stub.fetch(request);
      return new Response("OK", { headers: corsHeaders(allowedOrigin) });
    }

    // GET /api/rooms/:code/ws - WebSocket upgrade
    const wsMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/ws$/);
    if (wsMatch) {
      const roomCode = wsMatch[1];
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      return stub.fetch(request);
    }

    // GET /api/rooms/:code - Room info
    const infoMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})$/);
    if (infoMatch) {
      const roomCode = infoMatch[1];
      const doId = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(doId);
      const resp = await stub.fetch(request);
      const body = await resp.text();
      return new Response(body, {
        headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
