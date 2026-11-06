// D01：DO 实例死亡且 close handler 没运行（杀 workerd 进程）后，身份和房间能否恢复。
// 会杀掉并重启本地 Worker（8787），别和其他测试同时跑。退出码 = 失败条数。
const WS = require("ws");
const { workerdPids, killPid } = require("./env.cjs");
const worker = require("./worker-ctl.cjs");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const HOST = "127.0.0.1:8787";
const ORIGIN = "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = worker.stateDir;

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`   ok  ${name}`);
  } else {
    fail++;
    console.log(`   ✗   ${name}${detail !== undefined ? "  → " + JSON.stringify(detail).slice(0, 260) : ""}`);
  }
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (e.name.endsWith(".sqlite")) {
      out.push(p);
    }
  }
  return out;
}
function kvOfRoom(code) {
  for (const f of walk(stateDir)) {
    try {
      fs.copyFileSync(f, f + ".copy");
      for (const ext of ["-wal", "-shm"]) {
        if (fs.existsSync(f + ext)) {
          fs.copyFileSync(f + ext, f + ".copy" + ext);
        }
      }
      const db = new DatabaseSync(f + ".copy", { readOnly: true });
      const rows = db.prepare("select key, value from _cf_KV").all();
      db.close();
      const m = {};
      for (const r of rows) {
        m[r.key] = Buffer.from(r.value);
      }
      if (m.roomCode && m.roomCode.toString("latin1").includes(code)) {
        return { dp: m.disconnectedPlayers };
      }
    } catch {}
  }
  return null;
}

class Client {
  constructor(code) {
    this.code = code;
    this.msgs = [];
    this.closed = null;
    this.waiters = [];
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WS(`ws://${HOST}/api/rooms/${this.code}/ws`, { origin: ORIGIN, perMessageDeflate: false });
      this.ws.on("open", res);
      this.ws.on("error", rej);
      this.ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        this.msgs.push(m);
        this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
      });
      this.ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason) }));
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
  async join(name, { playerId, token, legacy } = {}) {
    if (!this.ws) {
      await this.open();
    }
    this.msgs = [];
    this.token = legacy ? undefined : (token ?? this.token ?? crypto.randomUUID());
    this.send({ type: "join", playerName: name, v: 1, ...(playerId ? { playerId } : {}), ...(this.token ? { playerToken: this.token } : {}) });
    const m = await this.waitFor((x) => x.type === "roomState" || x.type === "error", 5000);
    if (m?.type === "roomState") {
      this.me = m.yourId;
    }
    return m;
  }
}
const mkRoom = async (max) => (await (await fetch(`http://${HOST}/api/rooms?max=${max}`, { method: "POST", headers: { Origin: ORIGIN } })).json()).roomCode;
const entry = (players, id) => (players || []).find((p) => p.id === id);

// 杀掉所有本地 workerd（大的先杀），确认 close handler 没机会写存储，再重启
async function crashAndRestart(code, playerIds, attempt = 0) {
  await sleep(600);
  // 要先杀 DO 所在进程。先杀代理的话 close handler 有机会运行，这次就不算数。哪个进程是 DO
  // 分不出来，所以重试时轮流换顺序。
  const pids = workerdPids();
  for (const pid of attempt % 2 === 0 ? pids : [...pids].reverse()) {
    killPid(pid);
  }
  await sleep(500);
  const after = kvOfRoom(code);
  const leaked = playerIds.filter((id) => after?.dp?.toString("latin1").includes(id));
  worker.stop();
  await sleep(800);
  await worker.start();
  await sleep(500);
  return leaked.length === 0;
}

// 前提（close handler 没运行）不成立的那次不算数，重新来
async function withRealCrash(setup) {
  for (let i = 0; i < 8; i++) {
    const st = await setup();
    if (await crashAndRestart(st.code, st.ids, i)) {
      ok("前提：close handler 没运行（存储里没有断线记录）", true);
      return st;
    }
    console.log("    close handler 抢先运行了，这次不算，重来");
  }
  ok("前提：close handler 没运行（存储里没有断线记录）", false);
  throw new Error("没能制造出干净的崩溃");
}

(async () => {
  console.log("\n=== D1 实例死亡后：两人都回来，身份、答案、画手都还在；冒充不行");
  {
    const { code, aid, atk, bid, btk } = await withRealCrash(async () => {
      const code = await mkRoom(3);
      const a = new Client(code);
      await a.join("画手甲");
      const b = new Client(code);
      await b.join("猜手乙");
      a.send({ type: "setAnswer", answer: "苹果" });
      await b.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing");
      return { code, aid: a.me, atk: a.token, bid: b.me, btk: b.token, ids: [a.me, b.me] };
    });

    const x = new Client(code);
    const rx = await x.join("冒充", { playerId: aid, token: "wrong" });
    ok("错 token 拿不到身份", rx?.type === "roomState" && rx.yourId !== aid, rx && rx.yourId);
    ok("错 token 拿不到答案", rx?.answer === undefined, rx?.answer);
    ok("冒充者看到的人数包含两位离线玩家", rx?.players?.length === 3, rx?.players?.map((p) => [p.name, p.connected]));
    x.send({ type: "leave" });
    await sleep(300);

    const a2 = new Client(code);
    const ra = await a2.join("画手甲", { playerId: aid, token: atk });
    ok("A 身份保留", ra?.yourId === aid, ra && ra.yourId);
    ok("A 还是画手", ra?.drawerId === aid, ra && ra.drawerId);
    ok("phase 还是 guessing", ra?.phase === "guessing", ra && ra.phase);
    ok("答案还在", ra?.answer === "苹果", ra && ra.answer);
    ok("B 显示离线，名字没丢", entry(ra?.players, bid)?.connected === false && entry(ra?.players, bid)?.name === "猜手乙", entry(ra?.players, bid));

    const b2 = new Client(code);
    const rb = await b2.join("猜手乙", { playerId: bid, token: btk });
    ok("B 身份保留", rb?.yourId === bid, rb && rb.yourId);
    ok("B 的名字没丢", entry(rb?.players, bid)?.name === "猜手乙", entry(rb?.players, bid));
    ok("A 收到全员在线列表", !!(await a2.waitFor((m) => m.type === "playerList" && m.players.length === 2 && m.players.every((p) => p.connected === true), 2000)));

    b2.send({ type: "guess", text: "苹果" });
    ok("B 能猜对", !!(await a2.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed", 2000)));
    a2.send({ type: "continueDrawing" });
    ok("A 能继续出题", !!(await b2.waitFor((m) => m.type === "phaseChange" && m.phase === "drawing", 2000)));
    a2.send({ type: "leave" });
    b2.send({ type: "leave" });
    await sleep(300);
  }

  console.log("\n=== D2 实例死亡后：画手没回来，保留期到了交给回来的人，房间不卡死");
  {
    const { code, aid, bid, btk } = await withRealCrash(async () => {
      const code = await mkRoom(2);
      const a = new Client(code);
      await a.join("画手甲");
      const b = new Client(code);
      await b.join("猜手乙");
      return { code, aid: a.me, bid: b.me, btk: b.token, ids: [a.me, b.me] };
    });

    const b2 = new Client(code);
    const rb = await b2.join("猜手乙", { playerId: bid, token: btk });
    ok("B 身份保留", rb?.yourId === bid, rb && rb.yourId);
    ok("画手暂时还是离线的 A", rb?.drawerId === aid, rb && rb.drawerId);
    const left = await b2.waitFor((m) => m.type === "playerLeft" && m.playerId === aid, 36000);
    ok("保留期到后 A 被移除", !!left);
    const pc = await b2.waitFor((m) => m.type === "phaseChange", 2000);
    ok("B 接任画手", pc?.drawerId === bid, pc);
    b2.send({ type: "draw", action: "start", x: 0.1, y: 0.1, color: "#000000", lineWidth: 4 });
    b2.send({ type: "draw", action: "end", x: 0.2, y: 0.2, color: "#000000", lineWidth: 4 });
    await sleep(300);
    const c = new Client(code);
    const rc = await c.join("新人");
    ok("B 画的笔存下来了", rc?.strokes?.length === 1, rc?.strokes?.length);
    ok("新人进房后可以开始", rc?.phase === "drawing", rc?.phase);
    b2.send({ type: "leave" });
    c.send({ type: "leave" });
    await sleep(300);
  }

  console.log("\n=== D3 对照：普通休眠不会把在线玩家当成幽灵");
  {
    const code = await mkRoom(2);
    const a = new Client(code);
    await a.join("画手甲");
    const b = new Client(code);
    await b.join("猜手乙");
    a.msgs = [];
    await sleep(16000);
    a.send({ type: "chat", text: "醒醒" });
    ok("唤醒后正常通信", !!(await b.waitFor((m) => m.type === "chat", 2000)));
    await sleep(300);
    ok("A 没收到任何列表变化（没人被当成离线）", a.msgs.filter((m) => m.type === "playerList").length === 0, a.msgs.map((m) => m.type));
    a.send({ type: "leave" });
    b.send({ type: "leave" });
  }

  console.log("\n=== D4 断线记录已落盘后实例死亡：回来的人凭 token 恢复；有活动就能把到期的玩家清掉");
  {
    const code = await mkRoom(2);
    const a = new Client(code);
    await a.join("画手甲");
    const b = new Client(code);
    await b.join("猜手乙");
    const [aid, bid, btk] = [a.me, b.me, b.token];
    a.ws.terminate();
    b.ws.terminate();
    await sleep(800);
    await crashAndRestart(code, []);
    const b2 = new Client(code);
    const rb = await b2.join("猜手乙", { playerId: bid, token: btk });
    ok("B 身份保留", rb?.yourId === bid, rb && rb.yourId);
    ok("A 显示离线", entry(rb?.players, aid)?.connected === false, rb?.players);
    await sleep(31000);
    b2.send({ type: "chat", text: "还有人吗" });
    ok("保留期到后 A 被移除", !!(await b2.waitFor((m) => m.type === "playerLeft" && m.playerId === aid, 6000)));
    ok("B 接任画手", (await b2.waitFor((m) => m.type === "phaseChange", 2000))?.drawerId === bid);
    b2.send({ type: "leave" });
    await sleep(300);
  }

  console.log(`\n合计 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}`);
  process.exit(fail);
})().catch((e) => {
  console.log("异常", e);
  process.exit(99);
});
