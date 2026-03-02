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

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // POST /api/rooms - Create a new room
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const roomCode = generateRoomCode();
      return new Response(JSON.stringify({ roomCode }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
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
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
