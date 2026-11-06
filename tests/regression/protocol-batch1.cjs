// 第一批修复的断言式回归（协议层）。只访问 127.0.0.1。
// 用法：node batch1-protocol.cjs [过滤正则]
//   - 第一部分连本地 Worker（127.0.0.1:8787，真实常量）：worker-ctl.cjs start（run.cjs 会自动处理）
//   - 第二部分（IDLE / PING）自动起一个常量缩短 + 带调试入口的 worker 副本（8790），不改项目文件
// 退出码 = 失败条数。修复前应当是 RED。
const WS = require("ws");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const { TMP: scratch } = require("./env.cjs");
const { WORKER_DIR: proj, workerEnv, killTree } = require("./env.cjs");
const HOST = "127.0.0.1:8787";
const PATCHED_PORT = 8790;
const PATCHED_HOST = `127.0.0.1:${PATCHED_PORT}`;
const ORIGIN = "http://localhost:5173";
const HIBERNATE = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createRoom(max = 2, host = HOST, forceCode) {
  const q = forceCode ? `&forceCode=${forceCode}` : "";
  const r = await fetch(`http://${host}/api/rooms?max=${max}${q}`, { method: "POST", headers: { Origin: ORIGIN } });
  const j = await r.json();
  return forceCode ? { status: r.status, roomCode: j.roomCode } : j.roomCode;
}

class Client {
  constructor(tag, code, host = HOST) {
    this.tag = tag;
    this.code = code;
    this.host = host;
    this.msgs = [];
    this.closed = null;
    this.waiters = [];
    this.me = null;
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WS(`ws://${this.host}/api/rooms/${this.code}/ws`, { origin: ORIGIN, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on("open", res);
      this.ws.on("error", rej);
      this.ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        m.__at = Date.now();
        this.msgs.push(m);
        this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
      });
      this.ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason), at: Date.now() }));
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
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
  async join(name, playerId) {
    // 先清再连：不存在的房间在连接打开时就会收到 error
    this.msgs = [];
    if (!this.ws) {
      await this.open();
    }
    this.send({ type: "join", playerName: name, v: 1, ...(playerId ? { playerId } : {}) });
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

const stroke = (c, color = "#ff0000") => {
  c.send({ type: "draw", action: "start", x: 0.1, y: 0.1, color, lineWidth: 12 });
  c.send({ type: "draw", action: "move", x: 0.2, y: 0.2, color, lineWidth: 12, points: [{ x: 0.2, y: 0.2 }] });
  c.send({ type: "draw", action: "end", x: 0.3, y: 0.3, color, lineWidth: 12 });
};
const ends = (c, n) => c.waitFor(() => c.msgs.filter((m) => m.type === "draw" && m.action === "end").length >= n);
const entry = (players, id) => (players || []).find((p) => p.id === id);
const listWhere = (c, pred, ms = 3000) => c.waitFor((m) => m.type === "playerList" && pred(m.players), ms);
const probe = async (code, host = HOST) => {
  // 用一个占位身份读 roomState。要求房间有空位（调用方建房时留够 max）。
  const p = new Client("probe", code, host);
  const rs = await p.join("探针");
  return { p, rs };
};
const colors = (arr) => (arr || []).map((s) => s.color).join(",");

const T = {};

// ---------- R01 ----------
T["R01a 服务端：240 条/秒持续 3 秒不被踢（旧 JS 过渡期）"] = async (ok) => {
  const { cs: [a] } = await room(1, 2);
  a.send({ type: "draw", action: "start", x: 0, y: 0, color: "#000", lineWidth: 2 });
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && !a.closed) {
    for (let i = 0; i < 24 && a.ws.readyState === 1; i++) {
      a.send({ type: "draw", action: "move", x: 0.5, y: 0.5, color: "#000", lineWidth: 2, points: [{ x: 0.5, y: 0.5 }] });
    }
    await sleep(100);
  }
  await sleep(300);
  ok("连接存活", !a.closed, a.closed);
};
T["R01b 服务端：持续洪泛仍以 1008 关闭（限流没被放没）"] = async (ok) => {
  const { cs: [a] } = await room(1, 2);
  const t0 = Date.now();
  let sent = 0;
  // 服务端处理不过来时积压会拖很久，发够耗尽令牌桶的量就等结果，别一直发
  while (Date.now() - t0 < 30000 && !a.closed) {
    // 用不写存储的消息：chat 每条都写存储，处理速度本身就到不了上限
    for (let i = 0; i < 500 && sent < 12000 && a.ws.readyState === 1; i++) {
      a.send({ type: "nonsense" });
      sent++;
    }
    await sleep(100);
  }
  await sleep(300);
  ok("被 1008 / rate limited 关闭", a.closed?.code === 1008 && a.closed?.reason === "rate limited", a.closed);
};
T["R01c 网络卡顿后积压的 draw 一次到达：不踢人，点也不丢"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await sleep(200);
  a.send({ type: "draw", action: "start", x: 0.1, y: 0.1, color: "#000000", lineWidth: 4 });
  // 60 条/秒 × 30 秒（保留期长度）的积压，一次性发出
  const N = 1800;
  for (let i = 0; i < N; i++) {
    a.send({ type: "draw", action: "move", x: 0.2, y: 0.2, color: "#000000", lineWidth: 4, points: [{ x: 0.2, y: 0.2 }] });
  }
  a.send({ type: "draw", action: "end", x: 0.3, y: 0.3, color: "#000000", lineWidth: 4 });
  const end = await b.waitFor((m) => m.type === "draw" && m.action === "end", 15000);
  ok("画手没被关", !a.closed, a.closed);
  ok("对端收到 end", !!end);
  const { p, rs } = await probe(code);
  ok("服务端存下全部点", rs.strokes[0]?.points?.length === N + 2, rs.strokes[0]?.points?.length);
  p.kill();
};

// ---------- C01 ----------
T["C01a 断线后其他人收到全量列表，断线者 connected=false"] = async (ok) => {
  const { cs: [a, b] } = await room(2, 3);
  a.msgs = [];
  b.kill();
  const m = await listWhere(a, (ps) => entry(ps, b.me)?.connected === false);
  ok("收到 playerList(connected=false)", !!m, m);
  ok("列表仍是 2 人", m?.players?.length === 2, m?.players?.length);
  ok("自己标记 connected=true", entry(m?.players, a.me)?.connected === true);
};
T["C01b 重连的 roomState 含 grace 玩家并标记离线"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3);
  const [bid, cid] = [b.me, c.me];
  b.kill();
  c.kill();
  await sleep(500);
  const b2 = new Client("B2", code);
  const rb = await b2.join("B", bid);
  ok("身份保留", rb.yourId === bid);
  ok("列表 3 人", rb.players.length === 3, rb.players.map((p) => p.name));
  ok("C 标记离线", entry(rb.players, cid)?.connected === false, entry(rb.players, cid));
  ok("B 标记在线", entry(rb.players, bid)?.connected === true);
  void a;
};
T["C01c 重连时向其他人广播全量列表，不发 playerJoined"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3);
  const [bid, cid] = [b.me, c.me];
  b.kill();
  c.kill();
  await sleep(500);
  a.msgs = [];
  const b2 = new Client("B2", code);
  await b2.join("B", bid);
  const m1 = await listWhere(a, (ps) => entry(ps, bid)?.connected === true && entry(ps, cid)?.connected === false);
  ok("B 回来后 A 收到列表（B 在线 / C 离线）", !!m1);
  a.msgs = [];
  b2.msgs = [];
  const c2 = new Client("C2", code);
  const rc = await c2.join("C", cid);
  ok("C 的 roomState 全员在线", rc.players.every((p) => p.connected === true), rc.players);
  const all = (ps) => ps.length === 3 && ps.every((p) => p.connected === true);
  ok("C 回来后 A 收到全员在线列表", !!(await listWhere(a, all)));
  ok("C 回来后 B 收到全员在线列表", !!(await listWhere(b2, all)));
  await sleep(300);
  ok("没有 playerJoined（旧客户端会重复加人）", a.of("playerJoined").length === 0 && b2.of("playerJoined").length === 0);
};
T["C01d take-over：旧连接 reconnected，其他人收到列表，无 playerJoined"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const bid = b.me;
  // B 第一次加入的 playerJoined 可能比 B 的 roomState 晚到，等它到了再清
  await a.waitFor((m) => m.type === "playerJoined", 1000);
  a.msgs = [];
  const b2 = new Client("B2", code);
  const rb = await b2.join("B", bid);
  ok("身份保留", rb.yourId === bid);
  await sleep(300);
  ok("旧连接 close=reconnected", b.closed?.reason === "reconnected", b.closed);
  const m = await listWhere(a, (ps) => ps.length === 2 && entry(ps, bid)?.connected === true);
  ok("A 收到全量列表", !!m);
  ok("没有 playerJoined", a.of("playerJoined").length === 0);
};
T["C01e 新人的 roomState 也含 grace 玩家"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  const bid = b.me;
  b.kill();
  await sleep(300);
  const c = new Client("C", code);
  const rc = await c.join("C");
  ok("列表 3 人", rc.players.length === 3, rc.players);
  ok("B 标记离线", entry(rc.players, bid)?.connected === false);
  void a;
};
T["C01f grace 到期 → playerLeft，列表移除"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3);
  const bid = b.me;
  a.msgs = [];
  b.kill();
  const left = await a.waitFor((m) => m.type === "playerLeft" && m.playerId === bid, 36000);
  ok("收到 playerLeft", !!left);
  const { p, rs } = await probe(code);
  ok("之后的 roomState 不含 B", !entry(rs.players, bid), rs.players);
  p.kill();
  void c;
};

// ---------- C02 / C02b / C03 ----------
T["C02 drawer 离开 + 其余人都在 grace：回来后可出题"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  const [bid, cid] = [b.me, c.me];
  b.kill();
  c.kill();
  await sleep(300);
  a.send({ type: "leave" });
  await sleep(500);
  const b2 = new Client("B2", code);
  await b2.join("B", bid);
  const c2 = new Client("C2", code);
  const rc = await c2.join("C", cid);
  ok("phase=drawing", rc.phase === "drawing", rc.phase);
  ok("drawer 是 B", rc.drawerId === bid);
  ok("列表 2 人", rc.players.length === 2, rc.players);
  b2.msgs = [];
  b2.send({ type: "setAnswer", answer: "香蕉" });
  ok("新 drawer 能出题", !!(await c2.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing", 2000)));
};
T["C02b 非 drawer 离开 + 另一人在 grace：不降级、不清答案"] = async (ok) => {
  const { cs: [a, b, c], code } = await room(3);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  const bid = b.me;
  b.kill();
  await sleep(200);
  a.msgs = [];
  c.send({ type: "leave" });
  await sleep(1200);
  ok("A 没收到 phaseChange", a.of("phaseChange").length === 0, a.of("phaseChange"));
  ok("A 收到 playerLeft(C)", a.of("playerLeft").length === 1);
  const b2 = new Client("B2", code);
  const rb = await b2.join("B", bid);
  ok("B 回来 phase 仍是 guessing", rb.phase === "guessing", rb.phase);
  ok("答案长度还在", rb.answerLength === 2, rb.answerLength);
  b2.send({ type: "guess", text: "苹果" });
  ok("B 能继续猜对", !!(await a.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed", 2000)));
};
T["C02c 唯一的对手 grace 到期才降级 waiting；之后新人进入回到 drawing"] = async (ok) => {
  const { cs: [a, b], code } = await room(2);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  a.msgs = [];
  b.kill();
  await sleep(3000);
  ok("grace 内不降级", a.of("phaseChange").filter((m) => m.phase !== "guessing").length === 0, a.of("phaseChange"));
  const w = await a.waitFor((m) => m.type === "phaseChange" && m.phase === "waiting", 34000);
  ok("grace 到期后 waiting", !!w);
  a.msgs = [];
  const c = new Client("C", code);
  const rc = await c.join("C");
  ok("新人 roomState=drawing", rc.phase === "drawing", rc.phase);
  ok("A 收到 phaseChange(drawing)", !!(await a.waitFor((m) => m.type === "phaseChange" && m.phase === "drawing", 2000)));
};
T["C02d 猜对者离开后只剩 drawer：回 waiting，不留在 revealed"] = async (ok) => {
  const { cs: [a, b, c] } = await room(3);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  b.send({ type: "guess", text: "苹果" });
  const pc = await a.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed");
  ok("猜对时 pending=B", pc?.pendingPromotionId === b.me, pc);
  c.send({ type: "leave" });
  await sleep(300);
  a.msgs = [];
  b.send({ type: "leave" });
  const w = await a.waitFor((m) => m.type === "phaseChange", 2000);
  ok("phaseChange=waiting", w?.phase === "waiting", w);
};
T["C03 第 2 位在 grace 时第 3 人加入：不发 phaseChange"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  b.kill();
  await sleep(300);
  a.msgs = [];
  const c = new Client("C", code);
  const rc = await c.join("C");
  ok("新人 phase=guessing", rc.phase === "guessing", rc.phase);
  await sleep(1200);
  ok("A 收到 playerJoined", a.of("playerJoined").length === 1);
  ok("A 没收到 phaseChange", a.of("phaseChange").length === 0, a.of("phaseChange"));
};
T["C03b 对照：第 2 人正常加入仍广播 drawing"] = async (ok) => {
  const { cs: [a], code } = await room(1, 3);
  a.msgs = [];
  const b = new Client("B", code);
  const rb = await b.join("B");
  ok("B 的 roomState=drawing", rb.phase === "drawing", rb.phase);
  ok("A 收到 phaseChange(drawing)", !!(await a.waitFor((m) => m.type === "phaseChange" && m.phase === "drawing", 2000)));
  ok("B 自己不重复收到", b.of("phaseChange").length === 0);
};
T["C03c 对照：第 3 人在满员在线的 drawing 阶段加入不发 phaseChange"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  await sleep(200);
  a.msgs = [];
  b.msgs = [];
  const c = new Client("C", code);
  await c.join("C");
  await sleep(800);
  ok("A、B 都没收到 phaseChange", a.of("phaseChange").length + b.of("phaseChange").length === 0);
};

// ---------- H01 ----------
T["H01a undo 后休眠再 redo：对端收到，服务端恢复"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  stroke(a);
  await ends(b, 1);
  a.send({ type: "undo" });
  await b.waitFor((m) => m.type === "undo");
  b.msgs = [];
  await sleep(HIBERNATE);
  a.send({ type: "redo" });
  ok("B 收到 redo", !!(await b.waitFor((m) => m.type === "redo", 2500)));
  const { p, rs } = await probe(code);
  ok("服务端 1 笔", rs.strokes.length === 1, rs.strokes.length);
  ok("redoStack 已空", (rs.redoStack || []).length === 0, rs.redoStack);
  p.kill();
};
T["H01b roomState 下发 redoStack（顺序 LIFO），休眠后仍在"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 6);
  stroke(a, "#111111");
  stroke(a, "#222222");
  await ends(b, 2);
  a.send({ type: "undo" });
  a.send({ type: "undo" });
  await b.waitFor(() => b.of("undo").length >= 2);
  const { p, rs } = await probe(code);
  ok("立刻读：redoStack=[#222,#111]", colors(rs.redoStack) === "#222222,#111111", colors(rs.redoStack));
  p.kill();
  await sleep(HIBERNATE);
  const p2 = new Client("p2", code);
  const rs2 = await p2.join("探针二");
  ok("休眠后读：顺序不变", colors(rs2.redoStack) === "#222222,#111111", colors(rs2.redoStack));
  a.send({ type: "redo" });
  a.send({ type: "redo" });
  await b.waitFor(() => b.of("redo").length >= 2, 2500);
  const p3 = new Client("p3", code);
  const rs3 = await p3.join("探针三");
  ok("两次 redo 后笔画顺序 #111,#222", colors(rs3.strokes) === "#111111,#222222", rs3.type === "error" ? rs3 : colors(rs3.strokes));
  ok("redoStack 空", (rs3.redoStack || []).length === 0);
  p2.kill();
  p3.kill();
};
T["H01c 新笔画使 redo 失效，休眠后也不会复活"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 3);
  stroke(a, "#111111");
  await ends(b, 1);
  a.send({ type: "undo" });
  await b.waitFor((m) => m.type === "undo");
  stroke(a, "#333333");
  await ends(b, 2);
  await sleep(HIBERNATE);
  b.msgs = [];
  a.send({ type: "redo" });
  await sleep(1500);
  ok("B 没收到 redo", b.of("redo").length === 0);
  const { p, rs } = await probe(code);
  ok("服务端只有新笔画", colors(rs.strokes) === "#333333", colors(rs.strokes));
  ok("redoStack 空", (rs.redoStack || []).length === 0, rs.redoStack);
  p.kill();
};
T["H01d 所有写操作都清 redo（text/shape/fill/selection/delete/clear）"] = async (ok) => {
  const ops = {
    textStroke: (c) => c.send({ type: "textStroke", text: "字", x: 0.1, y: 0.1, color: "#000000", fontSize: 24 }),
    shape: (c) => c.send({ type: "shape", shape: "rect", filled: false, x: 0.1, y: 0.1, width: 0.2, height: 0.2, color: "#000000", lineWidth: 2 }),
    fill: (c) => c.send({ type: "fill", x: 0.5, y: 0.5, color: "#ff0000", tolerance: 32 }),
    selection: (c) => c.send({ type: "selection", srcX: 0.1, srcY: 0.1, w: 0.1, h: 0.1, dstX: 0.5, dstY: 0.5 }),
    deleteStrokes: (c) => c.send({ type: "deleteStrokes", indices: [0] }),
    clear: (c) => c.send({ type: "clear" }),
  };
  await Promise.all(
    Object.entries(ops).map(async ([name, op]) => {
      const { cs: [a, b], code } = await room(2, 4);
      stroke(a, "#111111");
      stroke(a, "#222222");
      await ends(b, 2);
      a.send({ type: "undo" });
      await b.waitFor((m) => m.type === "undo");
      b.msgs = [];
      op(a);
      await b.waitFor((m) => m.type === name);
      const { p, rs } = await probe(code);
      ok(`${name} 后 redoStack 空`, (rs.redoStack || []).length === 0, colors(rs.redoStack));
      p.kill();
      await sleep(HIBERNATE);
      const p2 = new Client("p2", code);
      const rs2 = await p2.join("探针二");
      ok(`${name} 后休眠 redoStack 仍空`, (rs2.redoStack || []).length === 0, colors(rs2.redoStack));
      p2.kill();
    }),
  );
};
T["H01e continue / transfer 也清 redo"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 4);
  stroke(a, "#111111");
  await ends(b, 1);
  a.send({ type: "undo" });
  await b.waitFor((m) => m.type === "undo");
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  b.send({ type: "guess", text: "苹果" });
  await a.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed");
  b.msgs = [];
  a.send({ type: "continueDrawing" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "drawing");
  let { p, rs } = await probe(code);
  ok("continue 后 redoStack 空", (rs.redoStack || []).length === 0, rs.redoStack);
  p.kill();
  await sleep(200);
  a.msgs = [];
  b.msgs = [];
  stroke(a, "#222222");
  await b.waitFor((m) => m.type === "draw" && m.action === "end");
  a.send({ type: "undo" });
  await b.waitFor((m) => m.type === "undo");
  a.send({ type: "transfer", targetId: b.me });
  await b.waitFor((m) => m.type === "transferDone");
  ({ p, rs } = await probe(code));
  ok("transfer 后 redoStack 空", (rs.redoStack || []).length === 0, rs.redoStack);
  p.kill();
};
T["H01f 对照：undo 后立刻 redo"] = async (ok) => {
  const { cs: [a, b] } = await room(2);
  stroke(a);
  await ends(b, 1);
  a.send({ type: "undo" });
  await b.waitFor((m) => m.type === "undo");
  a.send({ type: "redo" });
  ok("B 收到 redo", !!(await b.waitFor((m) => m.type === "redo", 2500)));
};

T["H01g 超过单次删除上限（130 条 redo）：新笔画后全部清掉，休眠后也不复活"] = async (ok) => {
  const { cs: [a, b], code } = await room(2, 4);
  for (let i = 0; i < 130; i++) {
    a.send({ type: "shape", shape: "rect", filled: false, x: 0.1, y: 0.1, width: 0.2, height: 0.2, color: "#000000", lineWidth: 2 });
    if (i % 50 === 49) {
      await sleep(250);
    }
  }
  await b.waitFor(() => b.of("shape").length >= 130, 5000);
  for (let i = 0; i < 130; i++) {
    a.send({ type: "undo" });
    if (i % 50 === 49) {
      await sleep(250);
    }
  }
  await b.waitFor(() => b.of("undo").length >= 130, 5000);
  const { p, rs } = await probe(code);
  ok("undo 后 redoStack=130", (rs.redoStack || []).length === 130, (rs.redoStack || []).length);
  ok("undo 后 strokes=0", rs.strokes.length === 0, rs.strokes.length);
  p.kill();
  stroke(a, "#333333");
  await ends(b, 1);
  await sleep(HIBERNATE);
  const p2 = new Client("p2", code);
  const rs2 = await p2.join("探针二");
  ok("休眠后 redoStack 空", (rs2.redoStack || []).length === 0, (rs2.redoStack || []).length);
  ok("休眠后只有新笔画", colors(rs2.strokes) === "#333333", rs2.strokes.length);
  p2.kill();
};

// ---------- H02 / H03 ----------
const winner = async (n = 3) => {
  const { cs, code } = await room(n);
  const [a, b] = cs;
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  b.send({ type: "guess", text: "苹果" });
  const pc = await a.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed");
  return { cs, code, pc };
};
T["H02a 猜对后休眠再 claim 成功"] = async (ok) => {
  const { cs: [a, b], pc } = await winner();
  ok("pendingPromotionId=B", pc?.pendingPromotionId === b.me);
  a.msgs = [];
  await sleep(HIBERNATE);
  b.send({ type: "claimDrawer" });
  const td = await a.waitFor((m) => m.type === "transferDone", 2500);
  ok("claim 成功", td?.newDrawerId === b.me, td);
};
T["H02b 猜对后休眠，重连的 roomState 带 pendingPromotionId"] = async (ok) => {
  const { cs: [a, b, c], code } = await winner();
  const cid = c.me;
  c.kill();
  await sleep(HIBERNATE);
  const c2 = new Client("C2", code);
  const rc = await c2.join("C", cid);
  ok("pendingPromotionId=B", rc.pendingPromotionId === b.me, rc.pendingPromotionId);
  void a;
};
T["H02c 对照：6.5s 内 claim 成功；非猜对者 claim 无效"] = async (ok) => {
  const { cs: [a, b, c] } = await winner();
  a.msgs = [];
  c.send({ type: "claimDrawer" });
  await sleep(500);
  ok("C 的 claim 无效", a.of("transferDone").length === 0);
  b.send({ type: "claimDrawer" });
  ok("B 的 claim 成功", !!(await a.waitFor((m) => m.type === "transferDone", 2500)));
};
T["H02d 三人房 drawer 在保留期时猜对：照常挂起晋升，能 claim"] = async (ok) => {
  const { cs: [a, b, c] } = await room(3);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  a.kill();
  await sleep(300);
  b.msgs = [];
  c.msgs = [];
  b.send({ type: "guess", text: "苹果" });
  const pc = await c.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed");
  ok("pendingPromotionId=猜对者", pc?.pendingPromotionId === b.me, pc);
  b.send({ type: "claimDrawer" });
  const td = await c.waitFor((m) => m.type === "transferDone", 2000);
  ok("claim 成功", td?.newDrawerId === b.me, td);
};
T["H02e 三人房第三人在保留期时猜对：照常挂起晋升"] = async (ok) => {
  const { cs: [a, b, c] } = await room(3);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  c.kill();
  await sleep(300);
  a.msgs = [];
  b.send({ type: "guess", text: "苹果" });
  const pc = await a.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed");
  ok("pendingPromotionId=猜对者", pc?.pendingPromotionId === b.me, pc);
};
T["H02f 对照：两人房猜对不挂起晋升"] = async (ok) => {
  const { cs: [a, b] } = await room(2);
  a.send({ type: "setAnswer", answer: "苹果" });
  await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
  b.send({ type: "guess", text: "苹果" });
  const pc = await a.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed");
  ok("没有 pendingPromotionId", !!pc && !pc.pendingPromotionId, pc);
};
T["H03 猜对者断网，休眠后 grace 到期：其余人收到 revealed 且无 pending"] = async (ok) => {
  const { cs: [a, b, c] } = await winner(3);
  a.msgs = [];
  c.msgs = [];
  await sleep(800);
  b.kill();
  const left = await a.waitFor((m) => m.type === "playerLeft", 36000);
  ok("playerLeft", !!left);
  const pc = await a.waitFor((m) => m.type === "phaseChange", 1500);
  ok("A 收到 phaseChange(revealed)", pc?.phase === "revealed", pc);
  ok("不带 pendingPromotionId", pc && !pc.pendingPromotionId, pc);
  ok("C 也收到", !!(await c.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed", 1500)));
};

// ---------- M01 ----------
T["M01a clear 不回给发送者，对端收到"] = async (ok) => {
  const { cs: [a, b] } = await room(2);
  await sleep(200);
  a.msgs = [];
  b.msgs = [];
  a.send({ type: "clear" });
  ok("B 收到 clear", !!(await b.waitFor((m) => m.type === "clear", 1500)));
  await sleep(400);
  ok("A 没收到回声", a.of("clear").length === 0);
};
T["M01b continue / transfer 的发送者仍收到 clear"] = async (ok) => {
  const { cs: [a, b] } = await winner(2);
  await sleep(200);
  a.msgs = [];
  a.send({ type: "continueDrawing" });
  ok("continue：发送者收到 clear", !!(await a.waitFor((m) => m.type === "clear", 1500)));
  await a.waitFor((m) => m.type === "phaseChange" && m.phase === "drawing");
  a.msgs = [];
  a.send({ type: "transfer", targetId: b.me });
  ok("transfer：发送者收到 clear", !!(await a.waitFor((m) => m.type === "clear", 1500)));
};

// ---------- ping ----------
T["P0 休眠后 ping 仍回 pong；ping 不进聊天、不影响其他人"] = async (ok) => {
  const { cs: [a, b] } = await room(2);
  await sleep(HIBERNATE);
  a.msgs = [];
  b.msgs = [];
  a.ws.send('{"type":"ping"}');
  ok("收到 pong", !!(await a.waitFor((m) => m.type === "pong", 1500)));
  await sleep(200);
  ok("B 什么都没收到", b.msgs.length === 0, b.msgs);
};

// ========== 第二部分：常量缩短 + 调试入口的副本 ==========
const runId = Date.now();
const dst = path.join(scratch, "b1-runs", String(runId), "worker");
const stateDir = path.join(scratch, "b1-runs", String(runId), "do-state");
const logPath = path.join(scratch, "b1-runs", String(runId), "worker.log");
function patchWorker() {
  fs.mkdirSync(path.join(dst, "src"), { recursive: true });
  for (const f of fs.readdirSync(path.join(proj, "src"))) {
    fs.copyFileSync(path.join(proj, "src", f), path.join(dst, "src", f));
  }
  fs.copyFileSync(path.join(proj, "wrangler.toml"), path.join(dst, "wrangler.toml"));
  const rep = (file, from, to) => {
    const p = path.join(dst, "src", file);
    const s = fs.readFileSync(p, "utf8");
    const out = s.replace(from, to);
    if (out === s) {
      throw new Error(`补丁没命中: ${file} ${from}`);
    }
    fs.writeFileSync(p, out);
  };
  rep("constants.ts", "INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000", "INACTIVITY_TIMEOUT_MS = 20 * 1000");
  rep("constants.ts", "ACTIVITY_PERSIST_MIN_INTERVAL_MS = 30_000", "ACTIVITY_PERSIST_MIN_INTERVAL_MS = 1_000");
  rep("constants.ts", "RECONNECT_GRACE_MS = 30_000", "RECONNECT_GRACE_MS = 6_000");
  rep("index.ts", "const roomCode = generateRoomCode();", 'const roomCode = url.searchParams.get("forceCode") || generateRoomCode();');
  // info 路由已删（第二批），调试入口单独走一条路由
  rep(
    "index.ts",
    "const allowedOrigin = origin!;",
    `const allowedOrigin = origin!;
    const dbgMatch = url.pathname.match(/^\\/api\\/rooms\\/(\\d{6})$/);
    if (dbgMatch && url.searchParams.has("__debug")) {
      return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(dbgMatch[1])).fetch(request);
    }`,
  );
  // 调试入口：读存储 key / alarm；种一个“遗留孤儿房”（created=true，无 lastActivityAt，无 alarm）
  rep(
    "room.ts",
    /private async handleFetch\(request: Request\): Promise<Response> \{\r?\n\s*await this\.ensureLoaded\(\);\r?\n\s*const url = new URL\(request\.url\);/,
    `private async handleFetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    if (url.searchParams.has("__debug")) {
      if (url.searchParams.has("seedLegacy")) {
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        await this.state.storage.put({ created: true, roomCode: url.searchParams.get("seedLegacy"), maxPlayers: 2 });
        this.loaded = false;
        await this.ensureLoaded();
        return new Response(JSON.stringify({ seeded: true }));
      }
      const keys = Array.from((await this.state.storage.list()).keys());
      const alarm = await this.state.storage.getAlarm();
      const pingSeen = (await this.state.storage.get<number>("__pingSeen")) ?? 0;
      return new Response(JSON.stringify({ keys: keys.filter((k) => k !== "__pingSeen"), alarm, created: this.created, lastActivityAt: this.lastActivityAt, pingSeen }));
    }`,
  );
  rep(
    "room.ts",
    /private async handleMessage\(ws: WebSocket, message: string \| ArrayBuffer\) \{\r?\n\s*await this\.ensureLoaded\(\);/,
    `private async handleMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.ensureLoaded();
    if (typeof message === "string" && message.includes('"ping"')) {
      const seen = ((await this.state.storage.get<number>("__pingSeen")) ?? 0) + 1;
      await this.state.storage.put("__pingSeen", seen);
    }`,
  );
}
const dbg = async (code, extra = "") => (await fetch(`http://${PATCHED_HOST}/api/rooms/${code}?__debug=1${extra}`, { headers: { Origin: ORIGIN } })).json();
let logFd;

const P = {};
const until = async (c, ms) => {
  const t0 = Date.now();
  while (!c.closed && Date.now() - t0 < ms) {
    await sleep(100);
  }
};

P["IDLE1 加入后只有 ping：约 20s 关闭，房间号释放"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const start = Date.now();
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const b = new Client("B", code, PATCHED_HOST);
  await b.join("B");
  const i = setInterval(() => {
    if (a.ws.readyState === 1) {
      a.send({ type: "ping" });
      b.send({ type: "ping" });
    }
  }, 3000);
  await until(a, 30000);
  clearInterval(i);
  const at = a.closed ? a.closed.at - start : null;
  ok("收到 roomClosed", a.of("roomClosed").length === 1);
  ok("close=inactivity", a.closed?.reason === "inactivity", a.closed);
  ok("约 20s（18~25s）", at !== null && at >= 18000 && at <= 25000, at);
  const again = new Client("X", code, PATCHED_HOST);
  const r = await again.join("X");
  ok("再加入 → 房间不存在", r?.message === "房间不存在", r);
  const d = await dbg(code);
  ok("存储已清空", d.keys.length === 0, d.keys);
  ok("alarm 已清除", d.alarm === null, d.alarm);
};
P["IDLE2 第 12s 聊一句：约 32s 关闭"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const start = Date.now();
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const b = new Client("B", code, PATCHED_HOST);
  await b.join("B");
  await sleep(12000);
  a.send({ type: "chat", text: "hi" });
  await until(a, 45000);
  const at = a.closed ? a.closed.at - start : null;
  ok("约 32s（30~37s）", at !== null && at >= 30000 && at <= 37000, at);
};
P["IDLE3 未 join 的连接发消息不续命：约 20s 关闭"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const start = Date.now();
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const stranger = new Client("S", code, PATCHED_HOST);
  await stranger.open();
  const i = setInterval(() => stranger.ws.readyState === 1 && stranger.send({ type: "nonsense" }), 3000);
  await until(a, 35000);
  clearInterval(i);
  const at = a.closed ? a.closed.at - start : null;
  ok("约 20s（18~25s）", at !== null && at >= 18000 && at <= 25000, at);
  stranger.kill();
};
P["IDLE3b 满员时被拒绝的 join 不续命：约 20s 关闭"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const start = Date.now();
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const b = new Client("B", code, PATCHED_HOST);
  await b.join("B");
  let rejected = 0;
  const i = setInterval(async () => {
    const s = new Client("S", code, PATCHED_HOST);
    const r = await s.join("陌生人").catch(() => null);
    if (r?.message === "房间已满") {
      rejected++;
    }
  }, 3000);
  await until(a, 35000);
  clearInterval(i);
  const at = a.closed ? a.closed.at - start : null;
  ok("确实有被拒绝的 join", rejected >= 3, rejected);
  ok("约 20s（18~25s）", at !== null && at >= 18000 && at <= 25000, at);
};
P["IDLE4 创建后从未加入：到期回收，存储和 alarm 都干净"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const d0 = await dbg(code);
  ok("/init 后有 alarm", typeof d0.alarm === "number", d0.alarm);
  ok("/init 后记录 lastActivityAt", d0.lastActivityAt > 0, d0.lastActivityAt);
  await sleep(26000);
  const d = await dbg(code);
  ok("created=false", d.created === false, d);
  ok("存储已清空", d.keys.length === 0, d.keys);
  ok("alarm 已清除", d.alarm === null, d.alarm);
};
P["IDLE5 最后一人主动离开：存储和 alarm 都干净"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  a.send({ type: "chat", text: "留点数据" });
  stroke(a);
  a.send({ type: "undo" });
  await sleep(300);
  const d0 = await dbg(code);
  ok("离开前有 stroke/redo/chat 之外的 key", d0.keys.includes("chatHistory"), d0.keys);
  a.send({ type: "leave" });
  await sleep(500);
  const d = await dbg(code);
  ok("created=false", d.created === false);
  ok("存储已清空", d.keys.length === 0, d.keys);
  ok("alarm 已清除", d.alarm === null, d.alarm);
};
P["IDLE6 全员断线 grace 到期：存储和 alarm 都干净"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const b = new Client("B", code, PATCHED_HOST);
  await b.join("B");
  a.kill();
  b.kill();
  await sleep(9000);
  const d = await dbg(code);
  ok("created=false", d.created === false, d);
  ok("存储已清空", d.keys.length === 0, d.keys);
  ok("alarm 已清除", d.alarm === null, d.alarm);
};
P["IDLE7 回收后同一房间号可以重建，且是全新状态"] = async (ok) => {
  const code = "700001";
  const first = await createRoom(2, PATCHED_HOST, code);
  ok("首次创建 200", first.status === 200 && first.roomCode === code, first);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  a.send({ type: "chat", text: "旧房间聊天" });
  stroke(a, "#111111");
  await sleep(300);
  a.send({ type: "leave" });
  await sleep(500);
  const second = await createRoom(2, PATCHED_HOST, code);
  ok("回收后重建 200", second.status === 200, second);
  const d = await dbg(code);
  ok("重建后有 alarm", typeof d.alarm === "number", d);
  const b = new Client("B", code, PATCHED_HOST);
  const r = await b.join("B");
  ok("没有旧笔画", r?.strokes?.length === 0, r?.strokes?.length);
  ok("没有旧聊天", (r?.chatHistory || []).length === 0, r?.chatHistory);
  ok("新人是 drawer", r?.drawerId === r?.yourId);
  b.send({ type: "leave" });
};
P["IDLE8 活跃房间的房间号不被抢（/init 仍 409）"] = async (ok) => {
  const code = "700002";
  await createRoom(2, PATCHED_HOST, code);
  const empty = await createRoom(2, PATCHED_HOST, code);
  ok("刚创建没人也不能抢", empty.status === 500, empty);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const busy = await createRoom(2, PATCHED_HOST, code);
  ok("有人时不能抢", busy.status === 500, busy);
  a.send({ type: "leave" });
};
P["IDLE9 遗留孤儿房（created、无 lastActivityAt、无 alarm）：/init 可复用"] = async (ok) => {
  const code = "700003";
  await dbg(code, `&seedLegacy=${code}`);
  const d0 = await dbg(code);
  ok("种子状态：created=true 无 alarm", d0.created === true && d0.alarm === null, d0);
  const r = await createRoom(2, PATCHED_HOST, code);
  ok("/init 复用成功", r.status === 200 && r.roomCode === code, r);
  const d = await dbg(code);
  ok("复用后有 alarm", typeof d.alarm === "number", d);
};
P["IDLE10 对照：有人在玩的房间不被闲置逻辑误杀（持续聊天 25s 不关闭）"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  const i = setInterval(() => a.ws.readyState === 1 && a.send({ type: "chat", text: "还在" }), 4000);
  await sleep(25000);
  clearInterval(i);
  ok("连接存活", !a.closed, a.closed);
  a.send({ type: "leave" });
};
P["PING1 ping 由运行时自动回复：不进 webSocketMessage（醒着和休眠都一样）"] = async (ok) => {
  const code = await createRoom(2, PATCHED_HOST);
  const a = new Client("A", code, PATCHED_HOST);
  await a.join("A");
  await sleep(300);
  a.msgs = [];
  a.ws.send('{"type":"ping"}');
  ok("醒着：收到 pong", !!(await a.waitFor((m) => m.type === "pong", 1500)));
  await sleep(300);
  const d1 = await dbg(code);
  ok("醒着：webSocketMessage 没收到 ping", d1.pingSeen === 0, d1.pingSeen);
  await sleep(13000);
  a.msgs = [];
  a.ws.send('{"type":"ping"}');
  ok("休眠：收到 pong", !!(await a.waitFor((m) => m.type === "pong", 1500)));
  await sleep(300);
  const d2 = await dbg(code);
  ok("休眠：webSocketMessage 没收到 ping", d2.pingSeen === 0, d2.pingSeen);
  a.send({ type: "leave" });
};

async function runSet(set, filter, results) {
  const names = Object.keys(set).filter((n) => filter.test(n));
  // 限制并发：同时建立太多连接时，延迟会超过用例的等待时间。
  // 洪泛类用例会占满 workerd，放到最后单独跑。
  const HEAVY = /^R01/;
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
    logFd = fs.openSync(logPath, "w");
    child = spawn(
      process.execPath,
      [path.join(proj, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--port", String(PATCHED_PORT), "--ip", "127.0.0.1", "--inspector-port", "9232", "--persist-to", stateDir, "--log-level", "info"],
      { cwd: dst, detached: process.platform !== "win32", stdio: ["ignore", logFd, logFd], windowsHide: true, env: workerEnv() },
    );
    const up = () => new Promise((res) => {
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
        console.log(`   ✗   ${x.name}${x.detail !== undefined ? "  → " + JSON.stringify(x.detail).slice(0, 220) : ""}`);
      }
    }
  }
  console.log(`\n合计 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}；用时 ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(fail);
})();
