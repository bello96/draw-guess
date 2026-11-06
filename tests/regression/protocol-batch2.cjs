// 第二批修复的断言式回归（协议层）。只访问 127.0.0.1。
// 用法：node batch2-protocol.cjs [过滤正则]
//   - 第一部分连本地 Worker（127.0.0.1:8787，真实常量）：worker-ctl.cjs start（run.cjs 会自动处理）
//   - 第二部分自动起一个常量缩短 + 带调试入口的 worker 副本（8792），不改项目文件
// 退出码 = 失败条数。
const WS = require("ws");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const { TMP: scratch } = require("./env.cjs");
const { WORKER_DIR: proj, workerEnv, killTree } = require("./env.cjs");
const HOST = "127.0.0.1:8787";
const PATCHED_PORT = 8792;
const PATCHED_HOST = `127.0.0.1:${PATCHED_PORT}`;
const ORIGIN = "http://localhost:5173";
const HIBERNATE = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createRoom(max = 2, host = HOST) {
  const r = await fetch(`http://${host}/api/rooms?max=${max}`, { method: "POST", headers: { Origin: ORIGIN } });
  return (await r.json()).roomCode;
}

class Client {
  constructor(tag, code, host = HOST) {
    this.tag = tag;
    this.code = code;
    this.host = host;
    this.msgs = [];
    this.all = [];
    this.closed = null;
    this.waiters = [];
    this.me = null;
    this.token = undefined;
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WS(`ws://${this.host}/api/rooms/${this.code}/ws`, { origin: ORIGIN, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on("open", () => {
        this.ws._receiver.on("conclude", (code, reason) => (this.closeFrame = { code, reason: String(reason), at: Date.now() }));
        res();
      });
      this.ws.on("error", rej);
      this.ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        m.__at = Date.now();
        this.msgs.push(m);
        this.all.push(m);
        this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
      });
      this.ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason), at: Date.now() }));
    });
  }
  send(o) {
    this.ws.send(typeof o === "string" ? o : JSON.stringify(o));
  }
  waitFor(pred, ms = 3000) {
    const hit = this.msgs.find(pred);
    if (hit) {
      return Promise.resolve(hit);
    }
    return new Promise((res) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        res(null);
      }, ms);
    });
  }
  // 新客户端自己生成 token，总是带上；legacy=true 模拟不认识 token 的旧客户端
  async join(name, { playerId, token, legacy } = {}) {
    // 先清再连：不存在的房间在连接打开时就会收到 error
    this.msgs = [];
    if (!this.ws) {
      await this.open();
    }
    this.token = legacy ? undefined : (token ?? this.token ?? crypto.randomUUID());
    this.send({
      type: "join",
      playerName: name,
      v: 1,
      ...(playerId ? { playerId } : {}),
      ...(this.token !== undefined ? { playerToken: this.token } : {}),
    });
    const m = await this.waitFor((x) => x.type === "roomState" || x.type === "error", 5000);
    if (m && m.type === "roomState") {
      this.me = m.yourId;
      this.state = m;
    }
    return m;
  }
  kill() {
    this.ws.terminate();
  }
  of(type) {
    return this.msgs.filter((m) => m.type === type);
  }
}

async function room(n, max, host = HOST) {
  const code = await createRoom(max ?? n, host);
  const cs = [];
  for (let i = 0; i < n; i++) {
    const c = new Client("ABCDEF"[i], code, host);
    await c.join("玩家" + "ABCDEF"[i]);
    cs.push(c);
  }
  return { code, cs };
}
const probe = async (code, host = HOST) => {
  const p = new Client("probe", code, host);
  const rs = await p.join("探针");
  return { p, rs };
};
const guessing = async (a, b, answer = "苹果") => {
  a.send({ type: "setAnswer", answer });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
};
const entry = (players, id) => (players || []).find((p) => p.id === id);
const offlineSeen = (c, id, ms = 3000) => c.waitFor((m) => m.type === "playerList" && entry(m.players, id)?.connected === false, ms);
const clean = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const FULL = (color = "#ff0000", lineWidth = 12, brushType) => ({
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
    { x: 0.3, y: 0.3 },
    { x: 0.4, y: 0.4 },
  ],
  color,
  lineWidth,
  ...(brushType ? { brushType } : {}),
});
const dstart = (color = "#111111", lineWidth = 2, extra = {}) => ({ type: "draw", action: "start", x: 0.1, y: 0.1, color, lineWidth, ...extra });
const dmove = (color = "#111111", lineWidth = 2) => ({ type: "draw", action: "move", x: 0.2, y: 0.2, color, lineWidth, points: [{ x: 0.2, y: 0.2 }] });
const dend = (color = "#111111", lineWidth = 2, stroke) => ({ type: "draw", action: "end", x: 0.3, y: 0.3, color, lineWidth, ...(stroke ? { stroke } : {}) });
const shape = (extra = {}) => ({ type: "shape", shape: "rect", filled: false, x: 0.1, y: 0.1, width: 0.2, height: 0.2, color: "#000000", lineWidth: 2, ...extra });

const T = {};

// ========== C05 / H04：end 带完整笔画 ==========
T["E1 end 带 stroke：服务端以它为准存盘，不看内存缓存"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  a.send(dstart("#111111", 2));
  a.send(dend("#111111", 2, FULL("#ff0000", 12, "crayon")));
  await b.waitFor((m) => m.type === "draw" && m.action === "end");
  const { p, rs } = await probe(code);
  ok("存的是 end.stroke", same(rs.strokes[0], FULL("#ff0000", 12, "crayon")), rs.strokes[0]);
  ok("只有一笔", rs.strokes.length === 1, rs.strokes.length);
  p.kill();
};
T["E2 中途加入：迟到者和早到者都从 end 拿到整笔"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  a.send(dstart("#ff0000", 12));
  a.send(dmove("#ff0000", 12));
  await b.waitFor((m) => m.type === "draw" && m.action === "move");
  const c = new Client("C", code);
  await c.join("迟到");
  a.send(dend("#ff0000", 12, FULL("#ff0000", 12)));
  const endC = await c.waitFor((m) => m.type === "draw" && m.action === "end");
  const endB = await b.waitFor((m) => m.type === "draw" && m.action === "end");
  ok("迟到者的 end 带 stroke", same(endC?.stroke, FULL("#ff0000", 12)), endC);
  ok("早到者的 end 带 stroke", same(endB?.stroke, FULL("#ff0000", 12)), endB);
};
T["E3 笔画中途休眠：颜色、线宽、笔型、点都不丢"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const full = FULL("#ff0000", 12, "crayon");
  a.send(dstart("#ff0000", 12, { brushType: "crayon" }));
  a.send(dmove("#ff0000", 12));
  await b.waitFor((m) => m.type === "draw" && m.action === "move");
  await sleep(HIBERNATE);
  a.send(dend("#ff0000", 12, full));
  await b.waitFor((m) => m.type === "draw" && m.action === "end");
  const { p, rs } = await probe(code);
  ok("存盘内容完整", same(rs.strokes[0], full), rs.strokes[0]);
  p.kill();
};
T["E4 start 被丢（只有 move + end）：没有残缺笔画，三端一致"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const full = FULL("#00ff00", 8, "watercolor");
  a.send(dmove("#00ff00", 8));
  a.send(dend("#00ff00", 8, full));
  const end = await b.waitFor((m) => m.type === "draw" && m.action === "end");
  ok("对端拿到整笔", same(end?.stroke, full), end);
  const { p, rs } = await probe(code);
  ok("服务端存整笔", same(rs.strokes[0], full) && rs.strokes.length === 1, rs.strokes);
  p.kill();
};
T["E5 旧客户端的 end 不带 stroke：回退到 start/move 缓存，广播服务端存的内容"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  a.send(dstart("#ff0000", 12, { brushType: "airbrush" }));
  a.send(dmove("#ff0000", 12));
  a.send(dend("#ff0000", 12));
  const end = await b.waitFor((m) => m.type === "draw" && m.action === "end");
  const expect = { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], color: "#ff0000", lineWidth: 12, brushType: "airbrush" };
  ok("对端的 end 带服务端存的笔画", same(end?.stroke, expect), end);
  const { p, rs } = await probe(code);
  ok("服务端存缓存内容", same(rs.strokes[0], expect), rs.strokes[0]);
  p.kill();
};
T["E6 stroke 非法：字段被忽略，回退到缓存，不存垃圾"] = async (ok) => {
  const bad = {
    非数组: { points: "x", color: "#000000", lineWidth: 2 },
    坐标非数字: { points: [{ x: "0", y: 0 }], color: "#000000", lineWidth: 2 },
    颜色非字符串: { points: [{ x: 0, y: 0 }], color: 123, lineWidth: 2 },
    颜色非十六进制: { points: [{ x: 0, y: 0 }], color: "url(x)", lineWidth: 2 },
    线宽过大: { points: [{ x: 0, y: 0 }], color: "#000000", lineWidth: 1e9 },
    空点: { points: [], color: "#000000", lineWidth: 2 },
    点数超限: { points: new Array(30001).fill({ x: 0.1, y: 0.1 }), color: "#000000", lineWidth: 2 },
  };
  await Promise.all(
    Object.entries(bad).map(async ([name, stroke]) => {
      const { cs: [a, b], code } = await room(2, 3);
      a.send(dstart("#123456", 4));
      a.send(dend("#123456", 4, stroke));
      const end = await b.waitFor((m) => m.type === "draw" && m.action === "end", 5000);
      const { p, rs } = await probe(code);
      ok(`${name}：存的是缓存`, rs.strokes.length === 1 && rs.strokes[0].color === "#123456" && rs.strokes[0].lineWidth === 4 && rs.strokes[0].points.length === 2, rs.strokes[0] && { c: rs.strokes[0].color, l: rs.strokes[0].lineWidth, n: rs.strokes[0].points?.length });
      ok(`${name}：广播的不是垃圾`, end?.stroke?.color === "#123456", { keys: end && Object.keys(end), msgs: b.msgs.map((m) => m.type + (m.action ? ":" + m.action : "")).slice(-6), closedA: a.closed, closedB: b.closed });
      p.kill();
    }),
  );
};
T["E7 只有画手的 end 生效；多余字段不落盘"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await sleep(100);
  a.msgs = [];
  b.send(dend("#222222", 2, FULL("#222222", 2)));
  await sleep(400);
  ok("画手没收到猜词方的笔画", a.of("draw").length === 0);
  a.send(dstart("#333333", 2));
  a.send(dend("#333333", 2, { ...FULL("#333333", 2), evil: "x".repeat(1000), points: [{ x: 0.1, y: 0.1, evil: "y" }] }));
  await b.waitFor((m) => m.type === "draw" && m.action === "end");
  const { p, rs } = await probe(code);
  ok("多余字段被丢掉", same(rs.strokes[0], { points: [{ x: 0.1, y: 0.1 }], color: "#333333", lineWidth: 2 }), rs.strokes[0]);
  p.kill();
};

T["E5b 旧客户端笔画中途休眠：存盘用 end 带的颜色和线宽；对端保留自己完整的累积"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  a.send(dstart("#ff0000", 8, { brushType: "crayon" }));
  a.send(dmove("#ff0000", 8));
  await b.waitFor((m) => m.type === "draw" && m.action === "move");
  await sleep(HIBERNATE);
  a.send(dend("#ff0000", 8));
  const end = await b.waitFor((m) => m.type === "draw" && m.action === "end");
  ok("缓存不完整时不广播 stroke（对端用自己累积的点）", end && !end.stroke, end?.stroke);
  const { p, rs } = await probe(code);
  ok("颜色来自 end", rs.strokes[0]?.color === "#ff0000", rs.strokes[0]);
  ok("线宽来自 end", rs.strokes[0]?.lineWidth === 8, rs.strokes[0]);
  p.kill();
};
T["E8 单笔路径超限：end.stroke 被忽略，不存这么长的路径"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const zigzag = [];
  for (let i = 0; i < 40; i++) {
    zigzag.push(i % 2 ? { x: 10, y: 10 } : { x: -10, y: -10 });
  }
  a.send(dstart("#123456", 4));
  a.send(dend("#123456", 4, { points: zigzag, color: "#123456", lineWidth: 4, brushType: "crayon" }));
  const end = await b.waitFor((m) => m.type === "draw" && m.action === "end", 3000);
  ok("广播的不是这条长路径", end?.stroke?.points?.length !== 40, end?.stroke?.points?.length);
  const { p, rs } = await probe(code);
  ok("服务端没存这条长路径", rs.strokes.every((s) => s.points.length !== 40), rs.strokes.map((s) => s.points.length));
  p.kill();
};
T["E8b 合法的长路径（分段阈值以内）照常接受"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const points = [];
  for (let i = 0; i <= 150; i++) {
    points.push({ x: i % 2 ? 1 : 0, y: 0.5 }); // 来回 150 个画布宽
  }
  a.send(dstart("#123456", 4));
  a.send(dend("#123456", 4, { points, color: "#123456", lineWidth: 4 }));
  const end = await b.waitFor((m) => m.type === "draw" && m.action === "end", 3000);
  ok("广播了整笔", end?.stroke?.points?.length === 151, end?.stroke?.points?.length);
  const { p, rs } = await probe(code);
  ok("存了整笔", rs.strokes[0]?.points?.length === 151, rs.strokes[0]?.points?.length);
  p.kill();
};
T["E9 进行中的笔画有累计上限：超过后 move 不再转发"] = async (ok) => {
  const { cs: [a, b] } = await room(2, 3);
  await sleep(100);
  b.msgs = [];
  a.send(dstart("#000000", 4));
  // 每条 move 来回 100 个画布宽，路径很快超限
  for (let i = 0; i < 10; i++) {
    const points = [];
    for (let j = 0; j < 100; j++) {
      points.push({ x: j % 2 ? 1 : 0, y: 0.5 });
    }
    a.send({ type: "draw", action: "move", x: 0, y: 0.5, color: "#000000", lineWidth: 4, points });
  }
  a.send(shape({ color: "#abcdef" }));
  await b.waitFor((m) => m.type === "shape" && m.color === "#abcdef", 3000);
  const moves = b.of("draw").filter((m) => m.action === "move").length;
  ok("只转发了上限以内的 move", moves > 0 && moves <= 3, moves);
};
T["L11 房间笔画总量有预算：超了拒收并提示画手，不广播不落盘"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await sleep(100);
  b.msgs = [];
  // 每笔两个点、一段路径约 181 个画布宽，约 17 笔就到预算
  const heavy = { points: [{ x: -64, y: -64 }, { x: 64, y: 64 }], color: "#000000", lineWidth: 4 };
  for (let i = 0; i < 25; i++) {
    a.send(dstart("#000000", 4));
    a.send(dend("#000000", 4, heavy));
  }
  const err = await a.waitFor((m) => m.type === "error", 4000);
  ok("画手收到提示", typeof err?.message === "string", err);
  await sleep(500);
  ok("连接没被断开", !a.closed, a.closed);
  const { p, rs } = await probe(code);
  ok("存的笔数没到 25", rs.strokes.length < 25 && rs.strokes.length >= 10, rs.strokes.length);
  const endCount = () => b.of("draw").filter((m) => m.action === "end").length;
  await b.waitFor(() => endCount() >= rs.strokes.length, 3000);
  await sleep(300); // 确认没有多出来的
  ok("对端和服务端一致", endCount() === rs.strokes.length, { ends: endCount(), stored: rs.strokes.length });
  p.kill();
  a.send({ type: "clear" });
  await b.waitFor((m) => m.type === "clear", 2000);
  a.msgs = [];
  a.send(shape({ color: "#abcdef" }));
  ok("清除后可以继续画", !!(await b.waitFor((m) => m.type === "shape" && m.color === "#abcdef", 2000)));
};
T["L12 二进制帧也算进限流"] = async (ok) => {
  const { cs: [a] } = await room(1, 2);
  const buf = Buffer.from([1, 2, 3]);
  const t0 = Date.now();
  let sent = 0;
  while (Date.now() - t0 < 30000 && !a.closed && !a.closeFrame) {
    for (let i = 0; i < 500 && sent < 12000 && a.ws.readyState === 1; i++) {
      a.ws.send(buf);
      sent++;
    }
    await sleep(100);
  }
  await sleep(300);
  ok("被 rate limited 关闭", (a.closeFrame || a.closed)?.reason === "rate limited", a.closeFrame || a.closed);
};
T["L13 未加入的连接发垃圾也关掉（文本或二进制）"] = async (ok) => {
  const code = await createRoom(2);
  const x = new Client("X", code);
  await x.open();
  x.send("not json");
  await sleep(500);
  ok("垃圾文本：关闭", !!(x.closeFrame || x.closed), x.closeFrame || x.closed);
  const y = new Client("Y", code);
  await y.open();
  y.ws.send(Buffer.from([1, 2, 3]));
  await sleep(500);
  ok("二进制：关闭", !!(y.closeFrame || y.closed), y.closeFrame || y.closed);
};

// ========== S01 / S02：公开 id 和重连 token 分开 ==========
T["T1 token 由客户端生成，服务端不回传"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 4);
  ok("A 的 roomState 不含 token", !JSON.stringify(a.state).includes(a.token));
  ok("B 的 roomState 不含任何人的 token", !JSON.stringify(b.state).includes(a.token) && !JSON.stringify(b.state).includes(b.token));
  ok("没有 yourToken 字段", a.state.yourToken === undefined && b.state.yourToken === undefined);
  const old = new Client("old", code);
  const r = await old.join("旧客户端", { legacy: true });
  ok("旧客户端能正常加入", r.type === "roomState", r);
};
T["T11 roomState 没送到就断线：不带 id、带同一 token 重试，取回原身份"] = async (ok) => {
  const code = await createRoom(2);
  const a = new Client("A", code);
  await a.open();
  const atk = crypto.randomUUID();
  a.send({ type: "join", playerName: "房主", v: 1, playerToken: atk });
  await a.waitFor((m) => m.type === "roomState");
  const hostId = a.msgs.find((m) => m.type === "roomState").yourId;
  a.msgs = [];
  // B 的 join 服务端已处理（A 收到了 playerJoined），但 B 假装没收到 roomState 就断了
  const b = new Client("B", code);
  await b.open();
  const btk = crypto.randomUUID();
  b.send({ type: "join", playerName: "猜手", v: 1, playerToken: btk });
  const joined = await a.waitFor((m) => m.type === "playerJoined", 2000);
  ok("服务端已处理 B 的 join", !!joined, joined);
  const bid = joined?.player?.id;
  b.kill();
  await offlineSeen(a, bid);
  a.msgs = [];
  const b2 = new Client("B2", code);
  const r = await b2.join("猜手", { token: btk });
  ok("不是 房间已满", r?.type === "roomState", r);
  ok("取回原身份", r?.yourId === bid, { got: r?.yourId, bid });
  ok("房间还是 2 人", r?.players?.length === 2, r?.players?.map((p) => p.name));
  await sleep(200);
  ok("A 没看到多出来的人", a.of("playerJoined").length === 0, a.of("playerJoined"));
  ok("房主还是画手", r?.drawerId === hostId);
};
T["T11b 房主的 roomState 没送到：重试后还是画手"] = async (ok) => {
  const code = await createRoom(2);
  const a = new Client("A", code);
  await a.open();
  const atk = crypto.randomUUID();
  a.send({ type: "join", playerName: "房主", v: 1, playerToken: atk });
  const rs = await a.waitFor((m) => m.type === "roomState");
  a.kill();
  await sleep(300);
  const a2 = new Client("A2", code);
  const r = await a2.join("房主", { token: atk });
  ok("取回原身份", r?.yourId === rs?.yourId, r?.yourId);
  ok("还是画手", r?.drawerId === r?.yourId);
};
T["T2 任何消息都不泄露别人的 token"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3, 4);
  const secrets = [a.token, b.token, c.token];
  const [aid, bid] = [a.me, b.me];
  await guessing(a, b);
  a.send({ type: "chat", text: "hi" });
  b.kill();
  await offlineSeen(c, bid);
  const b2 = new Client("B2", code);
  await b2.join("B", { playerId: bid, token: secrets[1] });
  const a2 = new Client("A2", code);
  await a2.join("A", { playerId: aid, token: secrets[0] });
  await sleep(300);
  const seenByC = JSON.stringify(c.all);
  ok("C 没看到 A 的 token", !seenByC.includes(secrets[0]));
  ok("C 没看到 B 的 token", !seenByC.includes(secrets[1]));
  const seenByB2 = JSON.stringify(b2.all);
  ok("B 没看到 A 的 token", !seenByB2.includes(secrets[0]));
};
T["T3 掉线玩家：只带 id、错 token、装旧客户端都拿不到身份"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 6);
  await guessing(a, b);
  const [aid, atk] = [a.me, a.token];
  a.kill();
  ok("B 看到 A 离线", !!(await offlineSeen(b, aid)));
  const cases = { 另一个token: { playerId: aid }, 空token: { playerId: aid, token: "" }, 错token: { playerId: aid, token: "wrong" }, 装旧客户端: { playerId: aid, legacy: true } };
  for (const [name, opts] of Object.entries(cases)) {
    const x = new Client("X", code);
    const r = await x.join("冒充", opts);
    ok(`${name}：当新玩家`, r.type === "roomState" && r.yourId !== aid, r.yourId);
    ok(`${name}：拿不到答案`, r.answer === undefined, r.answer);
  }
  const a2 = new Client("A2", code);
  const ra = await a2.join("A", { playerId: aid, token: atk });
  ok("本人带 token 能回来", ra.yourId === aid, ra.yourId);
  ok("本人拿到答案", ra.answer === "苹果", ra.answer);
  ok("本人还是画手", ra.drawerId === aid);
};
T["T4 在线玩家：冒充不会接管，也不会把本人踢掉"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 6);
  await guessing(a, b);
  const aid = a.me;
  const cases = { 另一个token: { playerId: aid }, 空token: { playerId: aid, token: "" }, 错token: { playerId: aid, token: "wrong" }, 装旧客户端: { playerId: aid, legacy: true } };
  for (const [name, opts] of Object.entries(cases)) {
    const x = new Client("X", code);
    const r = await x.join("冒充", opts);
    ok(`${name}：当新玩家`, r.type === "roomState" && r.yourId !== aid, r.yourId);
    ok(`${name}：拿不到答案`, r.answer === undefined, r.answer);
  }
  await sleep(300);
  ok("本人连接没被关", !a.closed, a.closed);
};
T["T5 房间满时冒充：房间已满，本人不受影响"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 2);
  const x = new Client("X", code);
  const r = await x.join("冒充", { playerId: a.me });
  ok("房间已满", r?.message === "房间已满", r);
  await sleep(300);
  ok("本人连接没被关", !a.closed, a.closed);
  a.send({ type: "chat", text: "还在" });
  ok("本人还能发消息", !!(await b.waitFor((m) => m.type === "chat", 1500)));
};
T["T6 本人重连：保留期和接管两条路径都认 token"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const [bid, btk] = [b.me, b.token];
  const b2 = new Client("B2", code);
  const r1 = await b2.join("B", { playerId: bid, token: btk });
  ok("接管：身份保留", r1.yourId === bid, r1.yourId);
  await sleep(300);
  ok("接管：旧连接 reconnected", b.closed?.reason === "reconnected", b.closed);
  b2.kill();
  await offlineSeen(a, bid);
  const b3 = new Client("B3", code);
  const r2 = await b3.join("B", { playerId: bid, token: btk });
  ok("保留期：身份保留", r2.yourId === bid, r2.yourId);
};
const quickleave = (code, id, token) =>
  fetch(`http://${HOST}/api/rooms/${code}/quickleave?playerId=${id}`, {
    method: "POST",
    headers: { Origin: ORIGIN, ...(token !== undefined ? { "Content-Type": "text/plain" } : {}) },
    ...(token !== undefined ? { body: token } : {}),
  });
T["T9a quickleave：掉线玩家，错 token 不缩短，对的 token 缩短"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const [bid, btk] = [b.me, b.token];
  a.msgs = [];
  b.kill();
  await offlineSeen(a, bid);
  await quickleave(code, bid);
  await quickleave(code, bid, "wrong");
  await quickleave(code, bid, "x".repeat(5000));
  const weird = await quickleave(code, bid, "bad\r\ntoken");
  ok("请求体里有换行也不报错", weird.status === 200, weird.status);
  const unicode = await quickleave(code, bid, "令牌");
  ok("请求体里有非 ASCII 也不报错", unicode.status === 200, unicode.status);
  await sleep(7500);
  ok("错 token：7.5s 后还在保留期", a.of("playerLeft").length === 0, a.of("playerLeft"));
  const t0 = Date.now();
  await quickleave(code, bid, btk);
  const left = await a.waitFor((m) => m.type === "playerLeft", 9000);
  ok("对的 token：约 5s 后离开", !!left && Date.now() - t0 < 8000, Date.now() - t0);
};
T["T9b quickleave：在线玩家，错 token 不打标记"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const bid = b.me;
  await quickleave(code, bid);
  await quickleave(code, bid, "wrong");
  a.msgs = [];
  b.kill();
  await offlineSeen(a, bid);
  await sleep(7500);
  ok("断线后仍是 30s 保留期", a.of("playerLeft").length === 0, a.of("playerLeft"));
};
T["T9c quickleave：在线玩家，对的 token 打标记"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await quickleave(code, b.me, b.token);
  a.msgs = [];
  b.kill();
  ok("断线后约 5s 离开", !!(await a.waitFor((m) => m.type === "playerLeft", 9000)));
};
T["T9e quickleave 标记会过期：晚到的 beacon 不影响之后的普通断线"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  // 新页面已接管、旧页面的 beacon 才到：标记落在新连接上
  await quickleave(code, b.me, b.token);
  await sleep(11000);
  a.msgs = [];
  const bid = b.me;
  b.kill();
  await offlineSeen(a, bid);
  await sleep(7500);
  ok("过了很久才断线：仍是 30s 保留期", a.of("playerLeft").length === 0, a.of("playerLeft"));
};
T["T10 休眠后 token 校验照常"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 6);
  const [aid, atk] = [a.me, a.token];
  await guessing(a, b);
  a.kill();
  await offlineSeen(b, aid);
  await sleep(HIBERNATE);
  const x = new Client("X", code);
  const rx = await x.join("冒充", { playerId: aid, token: "wrong" });
  ok("保留期路径：错 token 当新玩家", rx.yourId !== aid, rx.yourId);
  const a2 = new Client("A2", code);
  const ra = await a2.join("A", { playerId: aid, token: atk });
  ok("保留期路径：本人回来", ra.yourId === aid, ra.yourId);
  // 在线玩家的 token 在 attachment 里，同样要跨休眠
  await sleep(HIBERNATE);
  const y = new Client("Y", code);
  const ry = await y.join("冒充", { playerId: aid, token: "wrong" });
  ok("接管路径：错 token 当新玩家", ry.yourId !== aid, ry.yourId);
  await sleep(200);
  ok("本人没被踢", !a2.closed, a2.closed);
};

// ========== S03 / S05：消息校验 ==========
T["V1 同一 ws 重复 join 被忽略，不产生第二个身份"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 6);
  const [aid, bid] = [a.me, b.me];
  a.msgs = [];
  b.msgs = [];
  a.send({ type: "join", playerName: "第二次", v: 1, playerToken: "" });
  a.send({ type: "join", playerName: "冒充B", v: 1, playerId: bid, playerToken: b.token });
  await sleep(500);
  ok("A 没再收到 roomState", a.of("roomState").length === 0, a.of("roomState").length);
  ok("B 没收到 playerJoined", b.of("playerJoined").length === 0);
  await sleep(100);
  ok("B 没被踢", !b.closed, b.closed);
  const { p, rs } = await probe(code);
  ok("服务端仍是原来两人 + 探针", rs.players.length === 3, rs.players.map((x) => x.name));
  ok("画手还是 A", rs.drawerId === aid, rs.drawerId);
  p.kill();
};
T["V3 畸形消息不落盘、不广播"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await sleep(100);
  const bad = [
    { type: "fill", x: 0.5, y: 0.5, color: 123, tolerance: 32 },
    { type: "fill", x: 0.5, y: 0.5, color: "#ff0000", tolerance: "abc" },
    { type: "fill", x: "0.5", y: 0.5, color: "#ff0000", tolerance: 32 },
    { type: "fill", x: 0.5, y: 0.5, color: "#ff0000", tolerance: 1e9 },
    { type: "selection", srcX: 0.1, srcY: 0.1, w: 1e12, h: 0.1, dstX: 0.5, dstY: 0.5 },
    { type: "selection", srcX: 0.1, srcY: 0.1, w: 0.1, h: "a", dstX: 0.5, dstY: 0.5 },
    { type: "selection", srcX: 1e9, srcY: 0.1, w: 0.1, h: 0.1, dstX: 0.5, dstY: 0.5 },
    { type: "selection", srcX: 0.1, srcY: 0.1, w: 0.1, h: 0.1, dstX: 1e12, dstY: 0.5 },
    { type: "textStroke", text: "字", x: 0.1, y: 0.1, color: "#".padEnd(50000, "a"), fontSize: 24 },
    { type: "textStroke", text: "字", x: 0.1, y: 0.1, color: "#000000", fontSize: 1e9 },
    { type: "textStroke", text: 123, x: 0.1, y: 0.1, color: "#000000", fontSize: 24 },
    { type: "textStroke", text: "字", x: "a", y: 0.1, color: "#000000", fontSize: 24 },
    shape({ x: "0" }),
    shape({ width: 1e12 }),
    shape({ lineWidth: 1e9 }),
    shape({ lineWidth: -1 }),
    shape({ color: "javascript:alert(1)" }),
    shape({ shape: "evil" }),
    { type: "draw", action: "start", x: 0.1, y: 0.1, color: 123, lineWidth: 2 },
    { type: "draw", action: "start", x: 0.1, y: 0.1, color: "#000000", lineWidth: "big" },
    { type: "draw", action: "start", x: null, y: 0.1, color: "#000000", lineWidth: 2 },
    { type: "draw", action: "evil", x: 0.1, y: 0.1, color: "#000000", lineWidth: 2 },
    { type: "draw", action: "move", x: 0.1, y: 0.1, color: "#000000", lineWidth: 2, points: "nope" },
    { type: "draw", action: "move", x: 0.1, y: 0.1, color: "#000000", lineWidth: 2, points: [{ x: "a", y: 1 }] },
    { type: "draw", action: "move", x: 0.1, y: 0.1, color: "#000000", lineWidth: 2, points: new Array(30001).fill({ x: 0.1, y: 0.1 }) },
    { type: "deleteStrokes", indices: "0" },
  ];
  b.msgs = [];
  for (const m of bad) {
    a.send(m);
  }
  const sentinel = shape({ color: "#abcdef" });
  a.send(sentinel);
  await b.waitFor((m) => m.type === "shape" && m.color === "#abcdef", 8000);
  const leaked = b.msgs.filter((m) => !(m.type === "shape" && m.color === "#abcdef"));
  ok("对端只收到合法的那条", leaked.length === 0, leaked.map((m) => m.type + ":" + (m.action || m.shape || "")));
  const { p, rs } = await probe(code);
  ok("服务端只存了合法的那条", rs.strokes.length === 1 && rs.strokes[0].color === "#abcdef", rs.strokes.length);
  p.kill();
};
T["V4 对照：正常操作的边界值都接受"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await sleep(100);
  const good = [
    shape({ shape: "rect", filled: true, color: "#ffffff", lineWidth: 0 }), // 框选删除固化的白色矩形
    shape({ shape: "arrow", x: 0.9, y: 0.9, width: -0.5, height: -0.7, color: "#10AEFF", lineWidth: 12 }),
    shape({ shape: "line", x: 2.5, y: -1.5, width: 0.2, height: 0.2 }), // 编辑框拖到画布外
    shape({ shape: "ellipse", filled: true }),
    shape({ shape: "triangle" }),
    shape({ shape: "star" }),
    shape({ shape: "heart" }),
    { type: "fill", x: 0.5, y: 0.5, color: "#8b5cf6", tolerance: 32 },
    { type: "fill", x: 1.2, y: -0.1, color: "#000", tolerance: 0 }, // 3 位色、种子在画布外
    { type: "selection", srcX: 0, srcY: 0, w: 1, h: 1, dstX: 2.5, dstY: -1.5 },
    { type: "selection", srcX: 0.5, srcY: 0.5, w: 0.5, h: 0.5, dstX: 0.1, dstY: 0.1 },
    { type: "textStroke", text: "第一行\n第二行", x: 1.5, y: -0.2, color: "#000000", fontSize: 12 },
    { type: "textStroke", text: "大", x: 0.1, y: 0.1, color: "#000000", fontSize: 72 },
    { type: "textStroke", text: "彩色", x: 0.1, y: 0.1, color: "#000000", fontSize: 36, colorRanges: [{ start: 0, end: 1, color: "#ff0000" }] },
  ];
  for (const m of good) {
    a.send(m);
  }
  // 鼠标滑出画布时 offsetX/Y 会越界；笔型四种都要接受
  for (const brushType of ["pen", "airbrush", "crayon", "watercolor"]) {
    a.send({ type: "draw", action: "start", x: -0.02, y: 1.03, color: "#FFFFFF", lineWidth: 12, brushType });
    a.send({ type: "draw", action: "move", x: 3, y: -2, color: "#FFFFFF", lineWidth: 12, points: [{ x: 3, y: -2 }] });
    a.send({ type: "draw", action: "end", x: -5, y: 7, color: "#FFFFFF", lineWidth: 12, stroke: { points: [{ x: -0.02, y: 1.03 }, { x: 3, y: -2 }, { x: -5, y: 7 }], color: "#FFFFFF", lineWidth: 12, ...(brushType !== "pen" ? { brushType } : {}) } });
  }
  a.send(shape({ color: "#abcdef" }));
  await b.waitFor((m) => m.type === "shape" && m.color === "#abcdef", 5000);
  const { p, rs } = await probe(code);
  ok("全部存下", rs.strokes.length === good.length + 5, { stored: rs.strokes.length, expect: good.length + 5 });
  ok("彩色区间保留", rs.strokes.some((s) => s.colorRanges?.[0]?.color === "#ff0000"));
  p.kill();
};
T["V6 join 字段类型错误：不崩，按默认处理"] = async (ok) => {
  const code = await createRoom(3);
  const a = new Client("A", code);
  await a.open();
  a.send({ type: "join", playerName: 12345, playerId: { x: 1 }, playerToken: 5, v: 1 });
  const r = await a.waitFor((m) => m.type === "roomState" || m.type === "error", 3000);
  ok("收到 roomState", r?.type === "roomState", r);
  ok("名字是默认值", typeof entry(r?.players, r?.yourId)?.name === "string" && entry(r?.players, r?.yourId).name.length > 0, entry(r?.players, r?.yourId));
};

// ========== 限流 / S06 / 房间号 ==========
T["L1 写操作洪泛：1008 关闭（draw 的 start/move 不算写操作）"] = async (ok) => {
  const { cs: [a] } = await room(1, 2);
  await sleep(100);
  for (let i = 0; i < 1500 && a.ws.readyState === 1; i++) {
    a.send(shape());
  }
  const t0 = Date.now();
  while (!a.closed && Date.now() - t0 < 8000) {
    await sleep(100);
  }
  ok("被 1008 / rate limited 关闭", a.closed?.code === 1008 && a.closed?.reason === "rate limited", a.closed);
};
T["L1b 对照：正常速度写操作（20 条/秒 × 2 秒 + 突发 200 条）不受影响"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await sleep(100);
  for (let i = 0; i < 200; i++) {
    a.send(shape());
  }
  for (let i = 0; i < 40; i++) {
    a.send({ type: "chat", text: "第" + i + "条" });
    await sleep(50);
  }
  await b.waitFor(() => b.of("chat").length >= 40, 5000);
  ok("连接存活", !a.closed, a.closed);
  const { p, rs } = await probe(code);
  ok("全部存下", rs.strokes.length === 200, rs.strokes.length);
  p.kill();
};
T["L4 不存在的房间：不用发 join 就收到 error + close(room not found)"] = async (ok) => {
  const c = new Client("X", "000001");
  await c.open();
  const e = await c.waitFor((m) => m.type === "error", 2000);
  ok("收到 房间不存在", e?.message === "房间不存在", e);
  await sleep(300);
  ok("连接被关", c.closeFrame?.reason === "room not found", c.closeFrame);
};
T["L5 未 join 就发别的消息：连接被关"] = async (ok) => {
  const code = await createRoom(2);
  const c = new Client("X", code);
  await c.open();
  c.send({ type: "chat", text: "还没加入" });
  await sleep(500);
  ok("连接被关", !!c.closed, c.closed);
  ok("不是终止态原因（客户端会重连）", !["left", "room not found", "room full", "inactivity", "reconnected", "rate limited", "version mismatch"].includes(c.closed?.reason), c.closed);
};
T["L7 info 接口已删：HTTP 探不出房间状态"] = async (ok) => {
  const code = await createRoom(2);
  const r1 = await fetch(`http://${HOST}/api/rooms/${code}`, { headers: { Origin: ORIGIN } });
  ok("GET /api/rooms/:code 是 404", r1.status === 404, r1.status);
  const r2 = await fetch(`http://${HOST}/api/rooms/${code}/ws`, { headers: { Origin: ORIGIN } });
  ok("非升级的 /ws 不返回 200", r2.status !== 200, r2.status);
  const body = await r2.text();
  ok("响应里没有房间信息", !/playerCount|phase|created/.test(body), body.slice(0, 120));
};
T["L10 房间号：Worker 不再用 Math.random"] = async (ok) => {
  const hits = [];
  for (const f of fs.readdirSync(path.join(proj, "src"))) {
    if (fs.readFileSync(path.join(proj, "src", f), "utf8").includes("Math.random")) {
      hits.push(f);
    }
  }
  ok("worker/src 零命中", hits.length === 0, hits);
  const code = await createRoom(2);
  ok("仍是 6 位数字", /^\d{6}$/.test(code), code);
};

// ========== S07 ==========
T["A1 答案归一化后为空：只有标点也要真的匹配才算对"] = async (ok) => {
  const { cs: [a, b] } = await room(2, 3);
  await guessing(a, b, "！！！");
  b.msgs = [];
  b.send({ type: "guess", text: "？" });
  const r1 = await b.waitFor((m) => m.type === "guessResult", 1500);
  ok("猜别的标点不算对", r1?.correct === false, r1);
  b.msgs = [];
  b.send({ type: "guess", text: "!!!" });
  const r2 = await b.waitFor((m) => m.type === "guessResult", 1500);
  ok("全角半角视为相同", r2?.correct === true, r2);
};
T["A2 对照：普通答案的归一化不变"] = async (ok) => {
  const { cs: [a, b] } = await room(2, 3);
  await guessing(a, b, "苹果！");
  b.msgs = [];
  b.send({ type: "guess", text: "苹 果" });
  ok("去掉空格和标点后相同算对", (await b.waitFor((m) => m.type === "guessResult", 1500))?.correct === true);
};
T["A3 只猜标点不算猜对普通答案"] = async (ok) => {
  const { cs: [a, b] } = await room(2, 3);
  await guessing(a, b, "苹果");
  b.msgs = [];
  b.send({ type: "guess", text: "？？" });
  ok("不算对", (await b.waitFor((m) => m.type === "guessResult", 1500))?.correct === false);
};

// ========== M02 / M03 / 下家 ==========
T["M2 客户端主动 close：很快收到 close 帧，不是 10 秒后的 1006"] = async (ok) => {
  const { cs: [a, b] } = await room(2, 3);
  await sleep(100);
  const t0 = Date.now();
  b.ws.close(1000);
  while (!b.closed && Date.now() - t0 < 12000) {
    await sleep(50);
  }
  ok("2 秒内关闭", b.closed && b.closed.at - t0 < 2000, b.closed && b.closed.at - t0);
  ok("close code 不是 1006", b.closed?.code === 1000, b.closed);
  void a;
};
T["M3 向保留期玩家转让：发送者收到错误，状态不变"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3, 4);
  const bid = b.me;
  b.kill();
  await offlineSeen(a, bid);
  a.msgs = [];
  c.msgs = [];
  a.send({ type: "transfer", targetId: bid });
  const e = await a.waitFor((m) => m.type === "error", 1500);
  ok("发送者收到错误", typeof e?.message === "string" && e.message.length > 0, e);
  await sleep(200);
  ok("没有转让", a.of("transferDone").length === 0 && c.of("transferDone").length === 0);
  const { p, rs } = await probe(code);
  ok("画手不变", rs.drawerId === a.me);
  p.kill();
};
T["N1 画手离开：优先选在线玩家，跳过排在前面的保留期玩家"] = async (ok) => {
  const { cs: [a, b, c] } = await room(3, 3);
  const [bid, cid] = [b.me, c.me];
  b.kill();
  await offlineSeen(c, bid);
  c.msgs = [];
  a.send({ type: "leave" });
  const pc = await c.waitFor((m) => m.type === "phaseChange", 2000);
  ok("新画手是在线的 C", pc?.drawerId === cid, { got: pc?.drawerId, bid, cid });
};
T["N2 对照：都不在线时才退到保留期玩家"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3, 3);
  const [bid, cid, btk] = [b.me, c.me, b.token];
  b.kill();
  c.kill();
  await offlineSeen(a, bid);
  await offlineSeen(a, cid);
  a.send({ type: "leave" });
  await sleep(400);
  const b2 = new Client("B2", code);
  const r = await b2.join("B", { playerId: bid, token: btk });
  ok("新画手是排在前面的 B", r.drawerId === bid, r.drawerId);
};

// ========== 第二部分：常量缩短 + 调试入口的副本 ==========
const runId = Date.now();
const dst = path.join(scratch, "b2-runs", String(runId), "worker");
const stateDir = path.join(scratch, "b2-runs", String(runId), "do-state");
const logPath = path.join(scratch, "b2-runs", String(runId), "worker.log");
function patchWorker() {
  fs.mkdirSync(path.join(dst, "src"), { recursive: true });
  for (const f of fs.readdirSync(path.join(proj, "src"))) {
    fs.copyFileSync(path.join(proj, "src", f), path.join(dst, "src", f));
  }
  fs.writeFileSync(
    path.join(dst, "wrangler.toml"),
    fs.readFileSync(path.join(proj, "wrangler.toml"), "utf8").replace(/limit = 30/, "limit = 5").replace(/limit = 240/, "limit = 10"),
  );
  const rep = (file, from, to, optional) => {
    const p = path.join(dst, "src", file);
    const s = fs.readFileSync(p, "utf8");
    const out = s.replace(from, to);
    if (out === s) {
      if (optional) {
        return;
      }
      throw new Error(`补丁没命中: ${file} ${from}`);
    }
    fs.writeFileSync(p, out);
  };
  rep("constants.ts", "INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000", "INACTIVITY_TIMEOUT_MS = 20 * 1000");
  rep("constants.ts", "ACTIVITY_PERSIST_MIN_INTERVAL_MS = 30_000", "ACTIVITY_PERSIST_MIN_INTERVAL_MS = 1_000");
  rep("constants.ts", "RECONNECT_GRACE_MS = 30_000", "RECONNECT_GRACE_MS = 6_000");
  rep("constants.ts", "UNJOINED_TIMEOUT_MS = 30_000", "UNJOINED_TIMEOUT_MS = 3_000", true);
  // 灵敏度核实：MUTATE=closed-guard 时撤掉“已关闭连接的消息不算数”，S6f、S6g 应该变红
  if (process.env.MUTATE === "closed-guard") {
    rep("room.ts", /if \(ws\.deserializeAttachment\(\) === null\) \{\s*return;\s*\}/, "");
  }
  rep("index.ts", 'request.headers.get("CF-Connecting-IP")', 'request.headers.get("X-Test-IP") ?? request.headers.get("CF-Connecting-IP")', true);
  rep(
    "index.ts",
    "const allowedOrigin = origin!;",
    `const allowedOrigin = origin!;
    const dbgMatch = url.pathname.match(/^\\/__debug\\/(\\d{6})$/);
    if (dbgMatch) {
      return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(dbgMatch[1])).fetch(request);
    }`,
  );
  rep(
    "room.ts",
    /private async handleFetch\(request: Request\): Promise<Response> \{\r?\n\s*await this\.ensureLoaded\(\);\r?\n\s*const url = new URL\(request\.url\);/,
    `private async handleFetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    if (url.searchParams.has("__debug")) {
      if (url.searchParams.has("forgetRoster")) {
        // 模拟“名册字段上线前的房间”遇到实例崩溃：断线记录和名册都没有
        this.disconnectedPlayers.clear();
        this.roster.clear();
        await this.saveState();
        this.loaded = false;
        await this.ensureLoaded();
      }
      const keys = Array.from((await this.state.storage.list()).keys());
      return new Response(JSON.stringify({
        keys: keys.filter((k) => !k.startsWith("__")),
        alarm: await this.state.storage.getAlarm(),
        created: this.created,
        lastActivityAt: this.lastActivityAt,
        errors: (await this.state.storage.get<number>("__errors")) ?? 0,
        lastError: (await this.state.storage.get<string>("__lastError")) ?? null,
        sockets: this.state.getWebSockets().length,
      }));
    }`,
  );
  // 统计 webSocketMessage 里未捕获的异常（DO 的日志到不了 wrangler）
  rep(
    "room.ts",
    /private async handleMessage\(ws: WebSocket, message: string \| ArrayBuffer\) \{/,
    `private async handleMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      await this.__onMessage(ws, message);
    } catch (e) {
      const n = ((await this.state.storage.get<number>("__errors")) ?? 0) + 1;
      await this.state.storage.put("__errors", n);
      await this.state.storage.put("__lastError", String(e));
    }
  }

  async __onMessage(ws: WebSocket, message: string | ArrayBuffer) {`,
  );
}
const dbg = async (code) => (await fetch(`http://${PATCHED_HOST}/__debug/${code}?__debug=1`, { headers: { Origin: ORIGIN } })).json();

const P = {};
const until = async (c, ms) => {
  const t0 = Date.now();
  while (!c.closed && Date.now() - t0 < ms) {
    await sleep(100);
  }
};
const JUNK = [
  "null",
  "1",
  '"str"',
  "[]",
  "{}",
  '{"type":123}',
  '{"type":"nonsense"}',
  { type: "chat", text: 123 },
  { type: "chat" },
  { type: "chat", text: {} },
  { type: "guess", text: [] },
  { type: "setAnswer", answer: [] },
  { type: "setAnswer" },
  { type: "draw", action: "move", x: 0.1, y: 0.1, color: "#000000", lineWidth: 2, points: "x" },
  { type: "draw", action: "move", points: 5 },
  { type: "draw" },
  { type: "textStroke", text: 5 },
  { type: "textStroke", text: { a: 1 }, colorRanges: "x" },
  { type: "textStroke", text: "字", colorRanges: [null, 5, { start: "a" }] },
  { type: "shape" },
  { type: "fill" },
  { type: "selection" },
  { type: "deleteStrokes", indices: "a" },
  { type: "deleteStrokes" },
  { type: "transfer", targetId: 5 },
  { type: "join", playerName: 5 },
];
P["V2 类型混淆：各种垃圾消息不抛异常，连接正常"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const b = new Client("B", code, PATCHED_HOST);
  await b.join("B");
  await sleep(100);
  for (const j of JUNK) {
    a.send(j);
    b.send(j);
  }
  await sleep(600);
  const d = await dbg(code);
  ok("没有未捕获异常", d.errors === 0, { errors: d.errors, last: d.lastError });
  ok("连接存活", !a.closed && !b.closed, { a: a.closed, b: b.closed });
  a.send({ type: "chat", text: "还在" });
  ok("之后正常通信", !!(await b.waitFor((m) => m.type === "chat" && m.text === "还在", 1500)));
  a.send({ type: "leave" });
  b.send({ type: "leave" });
};
P["V5 垃圾消息不算活动：房间照常到期"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const start = Date.now();
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const i = setInterval(() => {
    if (a.ws.readyState === 1) {
      a.send({ type: "nonsense" });
      a.send("null");
      a.send({ type: "chat", text: 123 });
    }
  }, 2000);
  await until(a, 35000);
  clearInterval(i);
  const at = a.closed ? a.closed.at - start : null;
  ok("约 20s 关闭（18~25s）", at !== null && at >= 18000 && at <= 25000, at);
};
P["S6a 未 join 的连接：超时后被关，原因不是终止态"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const x = new Client("X", code, PATCHED_HOST);
  await x.open();
  const t0 = Date.now();
  while (!x.closeFrame && Date.now() - t0 < 8000) {
    await sleep(100);
  }
  ok("收到 close 帧", !!x.closeFrame, x.closeFrame);
  ok("约 3 秒（2~6s）", x.closeFrame && x.closeFrame.at - t0 >= 2000 && x.closeFrame.at - t0 <= 6000, x.closeFrame && x.closeFrame.at - t0);
  ok("原因是 join timeout", x.closeFrame?.reason === "join timeout", x.closeFrame);
  await until(x, 15000);
  ok("连接最终真的断开", !!x.closed, x.closed);
  ok("已加入的玩家不受影响", !a.closed, a.closed);
  a.send({ type: "leave" });
};
P["S6b 未 join 的连接有数量上限：超了关最旧的，新人仍能进"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const conns = [];
  for (let i = 0; i < 30; i++) {
    const c = new Client("X" + i, code, PATCHED_HOST);
    await c.open();
    conns.push(c);
  }
  await sleep(300);
  const open = conns.filter((c) => !c.closeFrame).length;
  ok("最多留 16 条", open <= 16, open);
  ok("关的是最旧的", !!conns[0].closeFrame && !conns[29].closeFrame, { first: conns[0].closeFrame, last: conns[29].closeFrame });
  const d0 = await dbg(code);
  ok("服务端连接数受控", d0.sockets <= 20, d0.sockets);
  const a = new Client("A", code, PATCHED_HOST);
  const r = await a.join("A");
  ok("新人能进", r?.type === "roomState", r);
  a.send({ type: "leave" });
};
P["S6c 正常 join 后不算未 join：不会被超时关掉"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  await sleep(5000);
  ok("连接存活", !a.closed, a.closed);
  a.send({ type: "chat", text: "还在" });
  ok("能通信", !!(await a.waitFor((m) => m.type === "chat", 1500)));
  a.send({ type: "leave" });
};
P["S6d 房间销毁时未 join 的连接也被关"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const x = new Client("X", code, PATCHED_HOST);
  await x.open();
  a.send({ type: "leave" });
  await sleep(600);
  ok("未 join 的连接被关", x.closeFrame?.reason === "room not found", x.closeFrame);
};
// 不让 ws 库自动回 close 帧：模拟 close 帧还在路上时，客户端已经发出了 join
const ignoreCloseFrame = (c) => {
  c.ws._receiver.removeAllListeners("conclude");
  c.ws._receiver.on("conclude", (code, reason) => (c.closeFrame = { code, reason: String(reason), at: Date.now() }));
};
P["S6f 服务端已关闭的连接上迟到的 join 不算数：不占座、不广播"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const x = new Client("X", code, PATCHED_HOST);
  await x.open();
  ignoreCloseFrame(x);
  const t0 = Date.now();
  while (!x.closeFrame && Date.now() - t0 < 8000) {
    await sleep(100);
  }
  ok("超时被关", !!x.closeFrame, x.closeFrame);
  a.msgs = [];
  x.msgs = [];
  x.send({ type: "join", playerName: "迟到", v: 1, playerToken: crypto.randomUUID() });
  await sleep(600);
  ok("没收到 roomState", x.of("roomState").length === 0, x.msgs.map((m) => m.type));
  ok("A 没收到 playerJoined", a.of("playerJoined").length === 0, a.msgs.map((m) => m.type));
  const b = new Client("B", code, PATCHED_HOST);
  const r = await b.join("B");
  ok("座位还在，新人能进", r?.type === "roomState", r);
  a.send({ type: "leave" });
  b.send({ type: "leave" });
};
P["S6g 已关闭连接上迟到的 join 带有效 token：不接管新连接"] = async (ok) => {
  const code = await createRoom(3, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const tk = crypto.randomUUID();
  const s1 = new Client("S1", code, PATCHED_HOST);
  await s1.open();
  ignoreCloseFrame(s1);
  const t0 = Date.now();
  while (!s1.closeFrame && Date.now() - t0 < 8000) {
    await sleep(100);
  }
  ok("S1 超时被关", !!s1.closeFrame, s1.closeFrame);
  const s2 = new Client("S2", code, PATCHED_HOST);
  const r = await s2.join("本人", { token: tk });
  ok("S2 正常加入", r?.type === "roomState", r);
  s1.send({ type: "join", playerName: "本人", v: 1, playerToken: tk });
  await sleep(600);
  ok("S2 没被接管", !s2.closed && !s2.closeFrame, s2.closeFrame || s2.closed);
  a.send({ type: "leave" });
  s2.send({ type: "leave" });
};
P["S6e 超时清理不唤醒多余逻辑：alarm 之后房间状态和闲置计时不变"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const before = await dbg(code);
  const x = new Client("X", code, PATCHED_HOST);
  await x.open();
  await sleep(4500);
  ok("确实被清理了", !!x.closeFrame, x.closeFrame);
  const after = await dbg(code);
  ok("闲置计时没被续", after.lastActivityAt === before.lastActivityAt, { before: before.lastActivityAt, after: after.lastActivityAt });
  ok("还有 alarm", typeof after.alarm === "number", after.alarm);
  a.send({ type: "leave" });
};

const IP = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
P["L8 建房限流：同一 IP 超限返回 429（带 CORS 和错误信息），别的 IP 不受影响"] = async (ok) => {
  const ip = IP();
  const post = (addr) => fetch(`http://${PATCHED_HOST}/api/rooms?max=2`, { method: "POST", headers: { Origin: ORIGIN, "X-Test-IP": addr } });
  const rs = [];
  for (let i = 0; i < 12; i++) {
    rs.push(await post(ip));
  }
  const counts = rs.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  ok("有 429", counts[429] > 0, counts);
  ok("有 200（不是全拒）", counts[200] > 0, counts);
  const r429 = rs.find((r) => r.status === 429);
  if (r429) {
    ok("429 带 CORS 头", r429.headers.get("access-control-allow-origin") === ORIGIN, r429.headers.get("access-control-allow-origin"));
    const j = await r429.json();
    ok("429 有错误信息", typeof j.error === "string" && j.error.length > 0, j);
  }
  const other = await post("198.51.100.77");
  ok("别的 IP 不受影响", other.status === 200, other.status);
  const local = [];
  for (let i = 0; i < 12; i++) {
    local.push((await fetch(`http://${PATCHED_HOST}/api/rooms?max=2`, { method: "POST", headers: { Origin: ORIGIN } })).status);
  }
  ok("本机开发不限流", local.every((x) => x === 200), local);
};
P["L8b IPv6 按 /64 计数：同一前缀换地址绕不过去，别的前缀不受影响"] = async (ok) => {
  const post = (addr) => fetch(`http://${PATCHED_HOST}/api/rooms?max=2`, { method: "POST", headers: { Origin: ORIGIN, "X-Test-IP": addr } });
  const statuses = [];
  for (let i = 1; i <= 12; i++) {
    // 同一个 /64 里的不同地址，混用压缩和不压缩的写法
    statuses.push((await post(`2001:db8:aaaa:1:0:0:0:${i.toString(16)}`)).status);
  }
  ok("同一 /64 换地址也会 429", statuses.includes(429), statuses);
  const other = await post("2001:db8:aaaa:2::1");
  ok("别的 /64 不受影响", other.status === 200, other.status);
  const compressed = [];
  for (let i = 1; i <= 12; i++) {
    compressed.push((await post(`2001:db8:bbbb::${i.toString(16)}`)).status);
  }
  ok("压缩写法同样按 /64 计数", compressed.includes(429), compressed);
  // `::` 可能藏住第四段：2001:1::2:3:4:5:6 展开后 /64 是 2001:1:0:2，和 2001:1::3:3:4:5:6 不同
  const hidden = [];
  for (let i = 1; i <= 12; i++) {
    hidden.push((await post(`2001:1::2:3:4:5:${i.toString(16)}`)).status);
  }
  ok("`::` 藏住第四段时同一 /64 也会 429", hidden.includes(429), hidden);
  const hiddenOther = await post("2001:1::3:3:4:5:1");
  ok("`::` 藏住第四段时别的 /64 不受影响", hiddenOther.status === 200, hiddenOther.status);
  const v4 = [];
  for (let i = 1; i <= 3; i++) {
    v4.push((await post(`198.51.100.${200 + i}`)).status);
  }
  ok("IPv4 不受影响（每个地址单独算）", v4.every((s) => s === 200), v4);
};
P["L9 连接限流：同一 IP 超限的升级返回 429，quickleave 也算"] = async (ok) => {
  const ip = IP();
  const up = () =>
    new Promise((res) => {
      const ws = new WS(`ws://${PATCHED_HOST}/api/rooms/000002/ws`, { origin: ORIGIN, headers: { "X-Test-IP": ip } });
      ws.on("unexpected-response", (_q, r) => res(r.statusCode));
      ws.on("open", () => {
        ws.terminate();
        res(101);
      });
      ws.on("error", () => res("error"));
    });
  const rs = [];
  for (let i = 0; i < 25; i++) {
    rs.push(await up());
  }
  const counts = rs.reduce((m, r) => ((m[r] = (m[r] || 0) + 1), m), {});
  ok("有 429", counts[429] > 0, counts);
  ok("有 101", counts[101] > 0, counts);
  const ql = await fetch(`http://${PATCHED_HOST}/api/rooms/000002/quickleave?playerId=x`, { method: "POST", headers: { Origin: ORIGIN, "X-Test-IP": ip } });
  ok("quickleave 也被限流", ql.status === 429, ql.status);
};

async function runSet(set, filter, results) {
  const names = Object.keys(set).filter((n) => filter.test(n));
  // 限制并发：同时建立太多连接时，延迟会超过用例的等待时间。
  // 洪泛类用例会占满 workerd，放到最后单独跑。
  const HEAVY = /^(L1 |L12 )/;
  const queue = names.filter((n) => !HEAVY.test(n));
  const heavy = names.filter((n) => HEAVY.test(n));
  const worker = async () => {
    while (queue.length > 0) {
      const n = queue.shift();
      const r = [];
      results[n] = r;
      const ok = (name, cond, detail) => r.push({ name, ok: !!cond, detail });
      try {
        await set[n](ok);
      } catch (e) {
        r.push({ name: "脚本异常", ok: false, detail: e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.TEST_CONCURRENCY || 16) }, worker));
  queue.push(...heavy);
  await worker();
  return names;
}

(async () => {
  const filter = process.argv[2] ? new RegExp(process.argv[2]) : /./;
  const results = {};
  const started = Date.now();
  const names = await runSet(T, filter, results);

  const pNames = Object.keys(P).filter((n) => filter.test(n));
  let child = null;
  if (pNames.length > 0) {
    patchWorker();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, "w");
    child = spawn(
      process.execPath,
      [path.join(proj, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--port", String(PATCHED_PORT), "--ip", "127.0.0.1", "--inspector-port", "9233", "--persist-to", stateDir, "--log-level", "info"],
      { cwd: dst, detached: process.platform !== "win32", stdio: ["ignore", logFd, logFd], windowsHide: true, env: workerEnv() },
    );
    const up = () =>
      new Promise((res) => {
        const s = net.connect(PATCHED_PORT, "127.0.0.1");
        s.on("connect", () => (s.destroy(), res(true)));
        s.on("error", () => res(false));
      });
    for (let i = 0; i < 80 && !(await up()); i++) {
      await sleep(500);
    }
    await runSet(P, filter, results);
    killTree(child.pid);
  }

  let pass = 0;
  let fail = 0;
  for (const n of [...names, ...pNames]) {
    const bad = results[n].filter((x) => !x.ok);
    console.log(`\n${bad.length === 0 ? "PASS" : "FAIL"} ${n}`);
    for (const x of results[n]) {
      if (x.ok) {
        pass++;
        console.log(`   ok  ${x.name}`);
      } else {
        fail++;
        console.log(`   ✗   ${x.name}${x.detail !== undefined ? "  → " + JSON.stringify(clean(x.detail)).slice(0, 220) : ""}`);
      }
    }
  }
  console.log(`\n合计 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}；用时 ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(fail);
})();
