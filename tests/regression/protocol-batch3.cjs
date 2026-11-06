// 第三批服务端改动的断言式回归：错误日志、兼容日期带来的行为。
// 自带一份打了调试补丁的 worker 副本（端口 8793），不依赖 8787。退出码 = 失败条数。
const path = require("path");
const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const WS = require("ws");

const { TMP: scratch } = require("./env.cjs");
const { WORKER_DIR: proj, workerEnv, killTree } = require("./env.cjs");
const dst = path.join(scratch, "worker-b3");
const PORT = 8793;
const ORIGIN = "http://localhost:4173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`   ok  ${name}`);
  } else {
    fail++;
    console.log(`   ✗   ${name}${detail !== undefined ? "  → " + JSON.stringify(detail).slice(0, 300) : ""}`);
  }
};

function patchWorker() {
  fs.mkdirSync(path.join(dst, "src"), { recursive: true });
  for (const f of fs.readdirSync(path.join(proj, "src"))) {
    fs.copyFileSync(path.join(proj, "src", f), path.join(dst, "src", f));
  }
  fs.copyFileSync(path.join(proj, "wrangler.toml"), path.join(dst, "wrangler.toml"));
  const rep = (file, from, to) => {
    const p = path.join(dst, "src", file);
    const s = fs.readFileSync(p, "utf8").split(String.fromCharCode(13)).join("");
    const out = s.replace(from, to);
    if (out === s) {
      throw new Error(`补丁没命中: ${file} ${from}`);
    }
    fs.writeFileSync(p, out);
  };
  rep("constants.ts", "INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000", "INACTIVITY_TIMEOUT_MS = 6 * 1000");
  rep("constants.ts", "ACTIVITY_PERSIST_MIN_INTERVAL_MS = 30_000", "ACTIVITY_PERSIST_MIN_INTERVAL_MS = 1_000");
  // 记下 console.error 的调用（这套环境里 DO 的日志到不了 wrangler 输出）
  rep(
    "room.ts",
    "export class GameRoom",
    `const __errs: string[] = [];
const __origError = console.error;
console.error = (...args: unknown[]) => {
  __errs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  __origError(...args);
};
export class GameRoom`,
  );
  // 调试入口：读日志和存储
  rep(
    "room.ts",
    /private async handleFetch\(request: Request\): Promise<Response> \{\s*await this\.ensureLoaded\(\);\s*const url = new URL\(request\.url\);/,
    `private async handleFetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    if (url.searchParams.has("__debug")) {
      const all = await this.state.storage.list();
      const alarm = await this.state.storage.getAlarm();
      return new Response(JSON.stringify({ errs: __errs, keys: [...all.keys()], alarm, created: this.created }));
    }`.replace(/\n/g, "\n"),
  );
  // 让某条聊天抛异常，模拟 handler 出错
  rep(
    "room.ts",
    "      case \"chat\":\n        await this.onChat(ws, msg.text);",
    `      case "chat":
        if (msg.text === "__boom__") {
          throw new Error("boom in handler");
        }
        await this.onChat(ws, msg.text);`,
  );
  rep(
    "index.ts",
    /return new Response\("Not found", \{ status: 404 \}\);/,
    `    const dbg = url.pathname.match(/^\\/__debug\\/(\\d{6})$/);
    if (dbg) {
      return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(dbg[1])).fetch(new Request("http://internal/?__debug=1"));
    }
return new Response("Not found", { status: 404 });`,
  );
}

let errBase = 0;
const dbg = async (code) => {
  const r = await (await fetch(`http://127.0.0.1:${PORT}/__debug/${code}`, { headers: { Origin: ORIGIN } })).json();
  return { ...r, allErrs: r.errs, errs: r.errs.slice(errBase) };
};
async function createRoom(max = 2) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/rooms?max=${max}`, { method: "POST", headers: { Origin: ORIGIN } });
  return (await r.json()).roomCode;
}
function client(code) {
  const ws = new WS(`ws://127.0.0.1:${PORT}/api/rooms/${code}/ws`, { origin: ORIGIN, perMessageDeflate: false });
  const c = { ws, msgs: [], closeFrame: null, closed: null };
  ws.on("message", (d) => c.msgs.push(JSON.parse(String(d))));
  ws.on("close", (code2, reason) => (c.closed = { code: code2, reason: String(reason), at: Date.now() }));
  ws.on("error", () => {});
  c.open = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = c.msgs.find(pred);
      if (hit) {
        return hit;
      }
      await sleep(20);
    }
    return null;
  };
  return c;
}
const join = async (code, name) => {
  const c = client(code);
  await c.open;
  c.send({ type: "join", playerName: name, v: 1, playerToken: "tok-" + name + "-" + Math.random().toString(36).slice(2) });
  c.rs = await c.wait((m) => m.type === "roomState");
  return c;
};

const T = {};

T.E1_handler_error_logged = async () => {
  console.log("\n=== E1 消息处理出错：写进错误日志（线上不记调用日志，只能靠它）");
  const code = await createRoom();
  const a = await join(code, "甲");
  const before = await dbg(code);
  ok("开始时没有错误", before.errs.length === 0, before.errs);
  a.send({ type: "chat", text: "__boom__" });
  await sleep(500);
  const after = await dbg(code);
  ok("handler 抛的异常进了 console.error", after.errs.some((e) => e.includes("boom in handler")), after.errs);
  ok("日志里能看出是哪个入口", after.errs.some((e) => e.includes("webSocketMessage")), after.errs);
  ok("没有把消息内容写进日志", !after.errs.some((e) => e.includes("__boom__")), after.errs);
  a.ws.terminate();
};

T.E2_normal_no_error = async () => {
  console.log("\n=== E2 正常使用不产生错误日志");
  const code = await createRoom(3);
  const a = await join(code, "甲");
  const b = await join(code, "乙");
  a.send({ type: "chat", text: "你好" });
  a.send({ type: "draw", action: "start", x: 0.1, y: 0.1, color: "#000000", lineWidth: 4 });
  a.send({ type: "draw", action: "end", x: 0.2, y: 0.2, color: "#000000", lineWidth: 4, stroke: { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], color: "#000000", lineWidth: 4 } });
  a.send({ type: "undo" });
  a.send({ type: "redo" });
  await sleep(300);
  a.send({ type: "leave" });
  await sleep(200);
  b.ws.close(1000, "bye");
  await sleep(500);
  const r = await dbg(code);
  ok("没有错误日志", r.errs.length === 0, r.errs);
  a.ws.terminate();
  b.ws.terminate();
};

T.C1_client_close_reply = async () => {
  console.log("\n=== C1 客户端主动关闭：服务端马上回 close 帧（Hibernation 下运行时不会自动回，要靠 webSocketClose 里的 ws.close）");
  const code = await createRoom(2);
  const a = await join(code, "甲");
  const t0 = Date.now();
  a.ws.close(1000, "bye");
  for (let i = 0; i < 200 && !a.closed; i++) {
    await sleep(25);
  }
  ok("很快完成关闭握手", a.closed && a.closed.at - t0 < 2000, { closed: a.closed, ms: a.closed && a.closed.at - t0 });
  ok("close code 是发出去的那个", a.closed && a.closed.code === 1000, a.closed);
  await sleep(300);
  const r = await dbg(code);
  ok("没有错误日志", r.errs.length === 0, r.errs);
};

T.C2_long_reason = async () => {
  console.log("\n=== C2 客户端用很长的 reason 关闭：服务端不出错");
  const code = await createRoom(2);
  const a = await join(code, "甲");
  a.ws.close(4000, "x".repeat(123));
  await sleep(600);
  const r = await dbg(code);
  ok("没有错误日志", r.errs.length === 0, r.errs);
  ok("连接关了", !!a.closed, a.closed);
};

T.D1_reset_clears_everything = async () => {
  console.log("\n=== D1 房间闲置销毁：存储和 alarm 都清掉（deleteAll 现在连 alarm 一起删）");
  const code = await createRoom(2);
  const a = await join(code, "甲");
  a.send({ type: "chat", text: "你好" });
  await sleep(300);
  const before = await dbg(code);
  ok("销毁前有存储和 alarm", before.keys.length > 0 && before.alarm !== null, before);
  // 闲置阈值在副本里是 6 秒，alarm 最多再晚 1 秒左右
  let after;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    after = await dbg(code);
    if (!after.created) {
      break;
    }
  }
  ok("房间被回收了", after && !after.created, after);
  ok("存储清空", after && after.keys.length === 0, after);
  ok("alarm 清掉了", after && after.alarm === null, after);
  ok("回收过程没有错误日志（这里 errs 跟着实例，可能已被重置）", after.errs.length === 0, after.errs);
  await sleep(1500);
  const later = await dbg(code);
  ok("之后也没有被写回去", later.keys.length === 0 && later.alarm === null, later);
  a.ws.terminate();
};

(async () => {
  const filter = new RegExp(process.argv[2] || ".");
  patchWorker();
  const logFd = fs.openSync(path.join(scratch, "worker-b3.log"), "w");
  const child = spawn(
    process.execPath,
    [path.join(proj, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--inspector-port", "9234", "--persist-to", path.join(scratch, "do-state-b3"), "--log-level", "warn"],
    { cwd: dst, detached: process.platform !== "win32", stdio: ["ignore", logFd, logFd], windowsHide: true, env: workerEnv() },
  );
  const up = () =>
    new Promise((res) => {
      const s = net.connect(PORT, "127.0.0.1");
      s.on("connect", () => (s.destroy(), res(true)));
      s.on("error", () => res(false));
    });
  let started = false;
  for (let i = 0; i < 120 && !started; i++) {
    started = await up();
    if (!started) {
      await sleep(500);
    }
  }
  if (!started) {
    console.log("worker 没起来", fs.readFileSync(path.join(scratch, "worker-b3.log"), "utf8").slice(-1500));
    process.exit(100);
  }
  await sleep(500);
  for (const [k, fn] of Object.entries(T)) {
    if (!filter.test(k)) {
      continue;
    }
    try {
      const probeCode = await createRoom();
      errBase = (await dbg(probeCode)).allErrs.length;
      await fn();
    } catch (e) {
      fail++;
      console.log(`   ✗   ${k} 脚本异常:`, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
    }
  }
  console.log(`\n合计: ${pass} 通过, ${fail} 失败`);
  killTree(child.pid);
  process.exit(fail);
})();
