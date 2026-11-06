// 第一批修复的断言式回归（真实客户端：无头 Edge + 独立 profile）。只访问本机。
// 用法：node batch1-browser.cjs [组名正则]；BUILD_DIR=build-old 可切换被测前端包。
// 依赖：worker-ctl.cjs start、build-client.mjs（run.cjs 会自动处理）。退出码 = 失败条数。
const path = require("path");
const fs = require("fs");
const { sleep, serveStatic, Proxy, Browser, NodeClient, createRoom, joinViaUrl, diffSig, ORIGIN } = require("./harness.cjs");

const { TMP: scratch } = require("./env.cjs");
const shots = path.join(scratch, "shots-b1");
fs.mkdirSync(shots, { recursive: true });

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
const closeAll = async (br, ...ps) => {
  for (const p of ps) {
    try {
      await br.b.send("Target.closeTarget", { targetId: p.id });
    } catch {}
  }
};
async function compare(a, b) {
  const [s1, s2] = await Promise.all([a.eval("T.sig()"), b.eval("T.sig()")]);
  return diffSig(s1, s2);
}
async function createInBrowser(br, name = "画手甲", max = 2) {
  const p1 = await br.newPage();
  await p1.goto(ORIGIN + "/");
  await p1.eval(`T.clickBtn('创建房间')`);
  await sleep(100);
  await p1.eval(`T.typeInto('input[type=text]', ${JSON.stringify(name)})`);
  if (max !== 2) {
    await p1.eval(`T.clickBtn('${max}人')`);
    await sleep(50);
  }
  await p1.eval(`T.clickBtn('确认创建')`);
  // 没进房间就当场报错：不然 code 是空的，后面报的错和原因对不上
  if (!(await p1.waitText("房间号", 6000))) {
    throw new Error(`建房后没进房间：${await p1.eval("location.pathname + ' ' + document.body.innerText.slice(0, 120)")}`);
  }
  await sleep(300);
  const code = await p1.eval(`location.pathname.slice(1)`);
  return { p1, code };
}
async function pagesInRoom(br, max = 2) {
  const { p1, code } = await createInBrowser(br, "画手甲", max);
  const p2 = await br.newPage();
  const t0 = Date.now();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  await sleep(300);
  // 诊断：加入失败时把现场打印出来
  if (!(await p2.eval(`T.text().includes('房间号')`))) {
    console.log("   !! p2 没加入成功，用时", Date.now() - t0, JSON.stringify(await p2.eval(`({text:T.text().slice(0,160),path:location.pathname,created:__ws.created,closes:__ws.closes,state:__ws.instances.map(w=>w.readyState),sent:__ws.sent.slice(-5),recv:__ws.recv,errs:__errs})`)), "p1:", JSON.stringify(await p1.eval(`({text:T.text().slice(0,160),path:location.pathname,created:__ws.created,closes:__ws.closes})`)), "code:", code);
  }
  return { p1, p2, code };
}
// 画手在绘画阶段、猜词方在猜词阶段，输入框默认就是答案 / 猜词模式；旧版默认聊天，要切一下
const leaveChatMode = (p) => p.eval(`(async()=>{ if (T.submitIs('发送')) { T.clickBtn('切换输入模式'); await T.raf(2); } })()`);
const setAnswer = async (p, a) => {
  await leaveChatMode(p);
  await p.eval(`T.chat(${JSON.stringify(a)})`);
};
const guess = async (p, a) => {
  await leaveChatMode(p);
  await p.eval(`T.chat(${JSON.stringify(a)})`);
};
const offline = (p, on) => p.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

const G = {};

// ---------- B 终止态 ----------
G.B1_takeover = async ({ br }) => {
  console.log("\n=== B1 复制标签页接管：旧标签走错误屏回首页，不卡“正在重连”");
  const { p1, p2, code } = await pagesInRoom(br);
  // 复制标签页会复制整个 sessionStorage（包括第二批的 token）
  const sess = await p2.eval(`JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map((k)=>[k,sessionStorage.getItem(k)])))`);
  const p3 = await br.newPage();
  await p3.goto(ORIGIN + "/");
  await p3.eval(`(()=>{const s=JSON.parse(${JSON.stringify(sess)});for(const k of Object.keys(s)){sessionStorage.setItem(k,s[k]);}})()`);
  await p3.goto(`${ORIGIN}/${code}`);
  ok("旧标签显示错误屏", await p2.waitText("其他标签页", 5000), await p2.eval("T.text().slice(0,120)"));
  await p2.shot(path.join(shots, "B1-takeover.png"));
  ok("旧标签回到首页", await p2.waitText("创建房间", 5000));
  ok("旧标签没有发起新连接", (await p2.eval("__ws.created")) === 1, await p2.eval("__ws.created"));
  ok("新标签正常在房间里", await p3.waitText("房间号", 3000), { text: await p3.eval("T.text().slice(0,120)"), closes: await p3.eval("__ws.closes"), created: await p3.eval("__ws.created"), sess: await p3.eval("JSON.stringify(Object.keys(sessionStorage))") });
  ok("新标签没有错误屏", !(await p3.eval(`T.text().includes('即将返回首页')`)));
  await closeAll(br, p1, p2, p3);
};
G.B2_room_gone = async ({ br, proxy }) => {
  console.log("\n=== B2 断网期间房间被销毁：回来后错误屏回首页");
  const { p1 } = await createInBrowser(br);
  await sleep(300);
  proxy.refuse = true;
  proxy.killAll();
  await sleep(35000);
  proxy.refuse = false;
  const shown = await p1.waitText("房间不存在", 40000);
  ok("显示房间不存在", shown, await p1.eval("T.text().slice(0,120)"));
  await p1.shot(path.join(shots, "B2-room-gone.png"));
  ok("回到首页", await p1.waitText("创建房间", 5000));
  await closeAll(br, p1);
};
G.B3_rate_terminal = async ({ br }) => {
  console.log("\n=== B3 被限流踢：错误屏回首页，不再重连");
  const { p1 } = await createInBrowser(br);
  await p1.eval(`(()=>{const w=__ws.instances.at(-1);for(let i=0;i<8000;i++){w.send(JSON.stringify({type:'ping2'}));}})()`);
  const shown = await p1.waitText("消息频率过高", 20000);
  ok("显示频率过高", shown, await p1.eval("T.text().slice(0,120)"));
  ok("回到首页", await p1.waitText("创建房间", 6000));
  ok("close code=1008", (await p1.eval("__ws.closes")).some((c) => c.code === 1008), await p1.eval("__ws.closes"));
  ok("没有重连", (await p1.eval("__ws.created")) === 1, await p1.eval("__ws.created"));
  await closeAll(br, p1);
};

G.B4_room_full = async ({ br }) => {
  console.log("\n=== B4 房间已满：首次加入的提示不被终止态文案覆盖，回首页");
  const { p1, p2, code } = await pagesInRoom(br);
  const p3 = await br.newPage();
  // 不用 joinViaUrl：它会等画布出现（最多 8s），错误屏 1.5s 就过去了
  await p3.goto(`${ORIGIN}/${code}`);
  await p3.waitText("进入房间", 5000);
  await p3.eval(`T.clickBtn('进入房间')`);
  ok("显示房间已满", await p3.waitText("房间已满", 3000), await p3.eval("T.text().slice(0,120)"));
  ok("回到首页", await p3.waitText("创建房间", 5000));
  ok("没有重连", (await p3.eval("__ws.created")) === 1, await p3.eval("__ws.created"));
  await closeAll(br, p1, p2, p3);
};

// 让之后发出的 join 带上不匹配的协议版本（模拟旧前端遇到已升版的 Worker）
const breakVersion = (p) => p.eval(`(()=>{const S=JSON.stringify;JSON.stringify=(o,...r)=>S(o&&o.type==='join'?{...o,v:999}:o,...r);})()`);

G.B5_version_reconnect = async ({ br, proxy }) => {
  console.log("\n=== B5 局中重连遇到版本不符：留在房间 URL，身份不清，刷新能回来");
  const { p1, p2, code } = await pagesInRoom(br);
  const id = await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`);
  await breakVersion(p2);
  proxy.killAll();
  ok("显示版本过旧", await p2.waitText("版本过旧", 6000), await p2.eval("T.text().slice(0,120)"));
  await sleep(2500);
  await p2.shot(path.join(shots, "B5-version.png"));
  ok("没有自动回首页", await p2.eval(`location.pathname === '/${code}'`), await p2.eval("location.pathname"));
  ok("没写“即将返回首页”", !(await p2.eval(`T.text().includes('即将返回首页')`)));
  ok("身份没清", (await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`)) === id);
  ok("有刷新按钮", await p2.eval(`!!T.btn('刷新页面')`));
  const loaded = new Promise((r) => (p2.handlers["Page.loadEventFired"] = r));
  await p2.eval(`T.clickBtn('刷新页面')`);
  await Promise.race([loaded, sleep(8000)]);
  ok("刷新后回到房间", await p2.waitText("房间号", 6000), await p2.eval("T.text().slice(0,120)"));
  ok("身份不变", (await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`)) === id);
  await closeAll(br, p1, p2);
};
G.B6_version_first_join = async ({ br }) => {
  console.log("\n=== B6 首次加入遇到版本不符：同样留在房间 URL");
  const { p1, code } = await createInBrowser(br);
  const p2 = await br.newPage();
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("进入房间", 5000);
  await breakVersion(p2);
  await p2.eval(`T.clickBtn('进入房间')`);
  ok("显示版本过旧", await p2.waitText("版本过旧", 4000), await p2.eval("T.text().slice(0,120)"));
  await sleep(2500);
  ok("没有自动回首页", await p2.eval(`location.pathname === '/${code}'`), await p2.eval("location.pathname"));
  ok("有刷新按钮", await p2.eval(`!!T.btn('刷新页面')`));
  await closeAll(br, p1, p2);
};

// ---------- 重连窗口 ----------
G.W1_reconnect_window = async ({ br, proxy }) => {
  console.log("\n=== W1 重连时 socket 已开、roomState 未到：此时点清除不能让画手和服务端分叉");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.stroke([[0.1,0.1],[0.5,0.5]])`);
  await sleep(300);
  const before = await p1.eval("__ws.created");
  // 每个方向延迟 1.2 秒：连接打开到 roomState 到达有 2 秒多的窗口，够在里面点完清除的两下
  proxy.delay = 1200;
  proxy.killAll();
  // 等新 socket 打开（握手要经过延迟），在 roomState 到达前点清除
  const opened = await p1.eval(`new Promise((res)=>{const t0=Date.now();const i=setInterval(()=>{const w=__ws.instances.at(-1);if((__ws.created>${before}&&w.readyState===1)||Date.now()-t0>15000){clearInterval(i);res(__ws.created>${before}&&w.readyState===1);}},5);})`);
  ok("等到了新连接打开", opened);
  // 清除要点两下（旧版点一下就清，第二下找不到按钮，跳过）
  const r = await p1.eval(
    `(async()=>{const banner0=T.text().includes('正在重连');T.btn('清除').click();await new Promise((s)=>setTimeout(s,700));const b=T.btn('确认清除');if(b)b.click();await T.raf(2);return {banner:banner0&&T.text().includes('正在重连'),ink:T.ink()};})()`,
  );
  ok("roomState 到达前一直显示重连横幅", r.banner, r);
  // 断言真的清了：什么都没点的话，后面的“两端一致”也会成立，测不出 send 提前放行
  ok("窗口里清除生效了（本地画布空了）", r.ink === 0, r);
  await sleep(4000);
  proxy.delay = 0;
  await sleep(600);
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("两端墨量一致", Math.abs(i1 - i2) <= Math.max(i1, i2) * 0.05, { i1, i2 });
  ok("横幅已消失", !(await p1.eval(`T.text().includes('正在重连')`)));
  await p1.eval(`T.stroke([[0.6,0.2],[0.8,0.6]])`);
  await sleep(500);
  const d = await compare(p1, p2);
  ok("之后再画一笔两端仍一致", d.cnt === 0, d);
  await closeAll(br, p1, p2);
};

// ---------- R01 ----------
G.R01_hz = async ({ br, proxy }) => {
  void proxy;
  console.log("\n=== R01 模拟高刷新率显示器（每帧一次 mousemove + 一次 rAF 回调）");
  for (const hz of [60, 120, 144, 165, 240, 360]) {
    const { p1: p, code } = await createInBrowser(br, "甲");
    const r = await p.eval(`(async()=>{
      const w = __ws.instances.at(-1);
      const s0 = w.send;
      const stat = { msgs: 0, pts: 0 };
      w.send = (d) => { const m = JSON.parse(d); if (m.type === 'draw' && m.action === 'move') { stat.msgs++; stat.pts += m.points.length; } s0(d); };
      let queue = [];
      window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
      window.cancelAnimationFrame = () => { queue = []; };
      const c = T.cv();
      const [x0, y0] = T.pt(0.1, 0.5);
      T.fire(c, 'mousedown', x0, y0);
      const mc = new MessageChannel();
      const t0 = performance.now();
      let next = t0, n = 0;
      await new Promise((res) => {
        mc.port1.onmessage = () => {
          const now = performance.now();
          if (now - t0 > 5000) { res(); return; }
          if (now >= next) {
            next += 1000 / ${hz}; n++;
            const [x, y] = T.pt(0.1 + 0.8 * ((n % 300) / 300), 0.5 + 0.2 * Math.sin(n / 10));
            T.fire(c, 'mousemove', x, y);
            const q = queue; queue = []; for (const cb of q) cb(now);
          }
          mc.port2.postMessage(0);
        };
        mc.port2.postMessage(0);
      });
      const [x1, y1] = T.pt(0.5, 0.5);
      T.fire(c, 'mouseup', x1, y1);
      return { n, msgs: stat.msgs, pts: stat.pts, sec: (performance.now() - t0) / 1000 };
    })()`);
    await sleep(800);
    const closes = await p.eval("__ws.closes");
    const perSec = Math.round(r.msgs / r.sec);
    ok(`${hz}Hz：连接没断`, closes.length === 0, closes);
    ok(`${hz}Hz：move ≤ 65 条/秒（实测 ${perSec}）`, perSec <= 65, r);
    ok(`${hz}Hz：不是被节流到太低（实测 ${perSec}，帧 ${r.n}）`, perSec >= Math.min(30, hz * 0.8 - 5), r);
    ok(`${hz}Hz：点数完整（帧 ${r.n} / 发出 ${r.pts}）`, r.pts === r.n, r);
    const probe = new NodeClient(code);
    const rs = await probe.join("探针");
    ok(`${hz}Hz：服务端存的点数 = start + 帧 + end`, rs?.strokes?.[0]?.points?.length === r.n + 2, rs?.strokes?.[0]?.points?.length);
    probe.kill();
    await closeAll(br, p);
  }
};

// ---------- C01 ----------
G.C1_list = async ({ br, proxy }) => {
  console.log("\n=== C1 同时断线后：画手的列表和按钮恢复（两人房 revealed）");
  const { p1, p2 } = await pagesInRoom(br);
  await setAnswer(p1, "苹果");
  await p2.waitText("猜词中", 3000);
  await sleep(100);
  await guess(p2, "苹果");
  await p1.waitText("已揭晓", 3000);
  await sleep(300);
  ok("断线前有 继续/转让", (await p1.eval(`!!T.btn('继续出题')`)) && (await p1.eval(`!!T.btn('转让画笔')`)));
  await offline(p2, true);
  proxy.killAll();
  await sleep(2500);
  ok("对方离线时 p1 看到离线标记", await p1.waitText("离线", 3000), await p1.eval("T.text().slice(0,200)"));
  ok("对方离线时转让按钮禁用", await p1.eval(`T.btn('转让画笔')?.disabled === true`));
  ok("对方离线时继续出题仍可用", await p1.eval(`T.btn('继续出题')?.disabled !== true`));
  await p1.shot(path.join(shots, "C1-peer-offline.png"));
  await offline(p2, false);
  await sleep(9000);
  ok("两端都没有 banner", !(await p1.eval(`T.text().includes('正在重连')`)) && !(await p2.eval(`T.text().includes('正在重连')`)));
  ok("p1 不显示 等待玩家加入", !(await p1.eval(`T.text().includes('等待玩家加入')`)));
  ok("p1 看得到 猜手乙", await p1.eval(`T.text().split('聊天区')[0].includes('猜手乙')`));
  ok("离线标记消失", !(await p1.eval(`T.text().split('聊天区')[0].includes('离线')`)));
  ok("p1 有 继续出题", await p1.eval(`!!T.btn('继续出题')`));
  ok("p1 转让可用", await p1.eval(`T.btn('转让画笔')?.disabled === false`));
  await p1.shot(path.join(shots, "C1-recovered.png"));
  await p1.eval(`T.clickBtn('转让画笔')`);
  ok("转让生效", await p2.waitText("画笔权限已转移", 3000));
  await closeAll(br, p1, p2);
};
G.C2_dropdown = async ({ br }) => {
  console.log("\n=== C2 3+ 人：转让候选里离线玩家禁用，在线玩家可选");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  const c = new NodeClient(code);
  await c.join("丙");
  await sleep(300);
  c.kill();
  await sleep(800);
  await p1.eval(`T.clickBtn('转让画笔')`);
  await sleep(200);
  const items = await p1.eval(`[...document.querySelectorAll('[data-transfer-popover] button')].filter(b=>!b.innerText.includes('转让画笔')).map(b=>({t:b.innerText,d:b.disabled}))`);
  await p1.shot(path.join(shots, "C2-dropdown.png"));
  const off = items.find((i) => i.t.includes("丙"));
  const on = items.find((i) => i.t.includes("猜手乙"));
  ok("丙 显示离线且禁用", off?.d === true && off?.t.includes("离线"), items);
  ok("猜手乙 可选", on?.d === false, items);
  await p1.eval(`[...document.querySelectorAll('[data-transfer-popover] button')].find(b=>b.innerText.includes('猜手乙')).click()`);
  ok("转让给在线玩家成功", await p2.waitText("画笔权限已转移", 3000));
  await closeAll(br, p1, p2);
};

// ---------- C04 ----------
G.C04_stale_id = async ({ br, proxy }) => {
  console.log("\n=== C04 mount 时的 id 已过期，拿到新 id 后再断线：不能用旧 id 重连");
  const { p1, code } = await createInBrowser(br);
  const p2 = await br.newPage();
  await p2.goto(ORIGIN + "/");
  await p2.eval(`sessionStorage.setItem('draw-guess-playerId','stale-id-from-long-ago');sessionStorage.setItem('draw-guess-nickname','猜手乙');`);
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("房间号", 6000);
  await sleep(300);
  const id1 = await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`);
  ok("服务端发了新 id", id1 && id1 !== "stale-id-from-long-ago", id1);
  proxy.killAll();
  await sleep(4000);
  const id2 = await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`);
  ok("重连后 id 不变", id2 === id1, { id1, id2 });
  ok("没有 房间已满", !(await p2.eval(`T.text().includes('房间已满')`)), await p2.eval("T.text().slice(0,120)"));
  ok("仍在房间里", await p2.eval(`T.text().includes('房间号')`));
  ok("p1 仍看到 2 人（无重复）", (await p1.eval(`(T.text().split('聊天区')[0].match(/猜手乙/g)||[]).length`)) === 1);
  await closeAll(br, p1, p2);
};

// ---------- H01 ----------
G.H1_redo = async ({ br }) => {
  console.log("\n=== H1 撤销后停 16s 再重做：两端一致");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.stroke([[0.1,0.1],[0.5,0.5]])`);
  await sleep(300);
  await p1.eval(`T.clickBtn('撤销')`);
  await sleep(16000);
  await p1.eval(`T.clickBtn('重做')`);
  await sleep(800);
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("双方都有墨", i1 > 0 && i2 > 0, { i1, i2 });
  const d = await compare(p1, p2);
  ok("画面一致", d.cnt === 0, d);
  await closeAll(br, p1, p2);
};
G.H2_reload_redo = async ({ br }) => {
  console.log("\n=== H2 撤销后对端刷新 / 新人加入，再重做：都能跟上");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  await p1.eval(`T.stroke([[0.1,0.1],[0.5,0.5]])`);
  await sleep(300);
  await p1.eval(`T.clickBtn('撤销')`);
  await sleep(300);
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("房间号", 6000);
  const late = await br.newPage();
  await joinViaUrl(late, code, ORIGIN, "迟到丙");
  await sleep(500);
  ok("重做前都没有墨", (await p2.eval("T.ink()")) === 0 && (await late.eval("T.ink()")) === 0);
  await p1.eval(`T.clickBtn('重做')`);
  await sleep(800);
  const [i1, i2, i3] = [await p1.eval("T.ink()"), await p2.eval("T.ink()"), await late.eval("T.ink()")];
  ok("刷新的对端跟上", i2 > 0 && Math.abs(i1 - i2) < i1 * 0.05, { i1, i2 });
  ok("新人跟上", i3 > 0 && Math.abs(i1 - i3) < i1 * 0.05, { i1, i3 });
  await closeAll(br, p1, p2, late);
};
G.H3_drawer_reconnect_redo = async ({ br, proxy }) => {
  console.log("\n=== H3 撤销后画手断线重连：重做按钮仍可用，两端一致");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.stroke([[0.1,0.1],[0.5,0.5]])`);
  await sleep(300);
  await p1.eval(`T.clickBtn('撤销')`);
  await sleep(300);
  proxy.killAll();
  await sleep(3500);
  ok("重连后重做按钮可用", await p1.eval(`T.btn('重做')?.disabled === false`));
  await p1.eval(`T.clickBtn('重做')`);
  await sleep(800);
  const d = await compare(p1, p2);
  ok("画面一致且有墨", d.cnt === 0 && (await p2.eval("T.ink()")) > 0, d);
  await closeAll(br, p1, p2);
};

// ---------- claim 重试 ----------
G.H4_claim_retry = async ({ br, proxy }) => {
  console.log("\n=== H4 猜对者在 6.5s 那一刻断线：重连后仍能自动拿到画笔");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  const p3 = await br.newPage();
  await joinViaUrl(p3, code, ORIGIN, "观众丙");
  await sleep(300);
  await setAnswer(p1, "苹果");
  await p2.waitText("猜词中", 3000);
  await sleep(100);
  await guess(p2, "苹果");
  await p1.waitText("已揭晓", 3000);
  await sleep(800);
  proxy.refuse = true;
  proxy.killAll();
  await sleep(7500);
  proxy.refuse = false;
  // 看实际状态，不等“画笔权限已转移”：第二批重连更快，转让可能发生在 p3 回来之前，
  // 这时 p3 靠 roomState 拿到新状态，不会有那条瞬时提示。
  const drawerIsWinner = () => p3.eval(`/🎨\\s*猜手乙/.test(T.text())`);
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 28000 && !done) {
    done = await drawerIsWinner();
    await sleep(200);
  }
  ok("画笔转移给猜对者", done, await p3.eval("T.text().slice(0,200)"));
  if (done) {
    ok("猜对者成为画手（工具栏可用）", await p2.eval(`document.querySelector('canvas') && T.text().includes('绘画中')`));
  }
  await closeAll(br, p1, p2, p3);
};

// ---------- M01 ----------
G.M1_clear_race = async ({ br, proxy }) => {
  console.log("\n=== M1 RTT 600ms 下点清除后立刻画一笔");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.stroke([[0.1,0.1],[0.3,0.3]])`);
  await sleep(300);
  proxy.delay = 300;
  // 清除要点两下：第一下先点好，确认的那一下和紧接着的一笔放在一起（旧版点一下就清，第二下找不到按钮，跳过）
  const clears0 = await p1.eval(`__ws.sent.filter((s)=>s.startsWith('{"type":"clear"')).length`);
  await p1.eval(`T.btn('清除').click()`);
  await sleep(700);
  await p1.eval(`(async()=>{const b=T.btn('确认清除');if(b)T.click(b); await T.stroke([[0.6,0.2],[0.7,0.5],[0.8,0.3]]);})()`);
  await sleep(2000);
  // 断言真的发了 clear：没发的话后面几条也都成立，测不到 clear 的回声擦掉新笔画这个竞态
  ok("发出了 clear", (await p1.eval(`__ws.sent.filter((s)=>s.startsWith('{"type":"clear"')).length`)) === clears0 + 1);
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("画手的新笔画没被擦掉", i1 > 0, { i1, i2 });
  ok("两端一致", Math.abs(i1 - i2) < Math.max(i1, 1) * 0.05, { i1, i2 });
  ok("撤销按钮可用", await p1.eval(`T.btn('撤销').disabled === false`));
  proxy.delay = 0;
  await closeAll(br, p1, p2);
};

// ---------- setLastMessage ----------
G.P1_no_rerender = async ({ br }) => {
  console.log("\n=== P1 观战端收 draw 不触发 React 提交");
  const code = await createRoom(2);
  const d = new NodeClient(code);
  await d.join("画手");
  const p = await br.newPage();
  await joinViaUrl(p, code, ORIGIN, "观众");
  await sleep(800);
  d.send({ type: "draw", action: "start", x: 0.1, y: 0.5, color: "#000", lineWidth: 4 });
  const c0 = await p.eval("__commits");
  for (let i = 0; i < 60; i++) {
    const x = 0.1 + i * 0.01;
    d.send({ type: "draw", action: "move", x, y: 0.5, color: "#000", lineWidth: 4, points: [{ x, y: 0.5 }] });
    await sleep(25);
  }
  const c1 = await p.eval("__commits");
  ok("60 条 move 期间 React 提交 0 次", c1 - c0 === 0, c1 - c0);
  d.kill();
  await closeAll(br, p);
};

(async () => {
  const filter = new RegExp(process.argv[2] || ".");
  const buildDir = process.env.BUILD_DIR || "build-local";
  const server = await serveStatic(path.join(scratch, buildDir), 4173);
  const proxy = new Proxy();
  await proxy.start();
  const br = await new Browser().start(scratch);
  // 字体 CDN 走本地响应：测试只访问本机，也不受 CDN 快慢影响
  const { mockFonts } = require("./browser-batch3-load.cjs");
  const rawNewPage = br.newPage.bind(br);
  br.newPage = async () => {
    const page = await rawNewPage();
    await mockFonts(page);
    return page;
  };
  console.log("浏览器:", br.version, " 前端包:", buildDir);
  for (const [k, fn] of Object.entries(G)) {
    if (!filter.test(k)) {
      continue;
    }
    try {
      await fn({ br, proxy });
    } catch (e) {
      fail++;
      console.log(`   ✗   ${k} 脚本异常:`, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
    }
    proxy.refuse = false;
    proxy.delay = 0;
  }
  await br.stop();
  proxy.stop();
  server.close();
  console.log(`\n合计 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}`);
  process.exit(fail);
})().catch((e) => {
  console.log("致命错误", e);
  process.exit(99);
});
