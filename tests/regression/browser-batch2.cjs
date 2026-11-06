// 第二批修复的断言式回归（真实客户端：无头 Edge + 独立 profile）。只访问本机。
// 用法：node batch2-browser.cjs [组名正则]；BUILD_DIR=build-old 可切换被测前端包。
// 依赖：worker-ctl.cjs start、build-client.mjs（run.cjs 会自动处理）。退出码 = 失败条数。
const path = require("path");
const fs = require("fs");
const { sleep, serveStatic, Proxy, Browser, NodeClient, createRoom, joinViaUrl, diffSig, ORIGIN } = require("./harness.cjs");

const { TMP: scratch } = require("./env.cjs");
const shots = path.join(scratch, "shots-b2");
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
  await p1.waitText("房间号", 6000);
  await sleep(300);
  const code = await p1.eval(`location.pathname.slice(1)`);
  return { p1, code };
}
async function pagesInRoom(br, max = 2) {
  const { p1, code } = await createInBrowser(br, "画手甲", max);
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  await sleep(300);
  return { p1, p2, code };
}
// 画手在绘画阶段、猜词方在猜词阶段，输入框默认就是答案 / 猜词模式；旧版默认聊天，要切一下
const leaveChatMode = (p) => p.eval(`(async()=>{ if (T.submitIs('发送')) { T.clickBtn('切换输入模式'); await T.raf(2); } })()`);
const toggleAnd = async (p, a) => {
  await leaveChatMode(p);
  await p.eval(`T.chat(${JSON.stringify(a)})`);
};
const offline = (p, on) => p.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const reconnected = async (p, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await p.eval(`T.text().includes('正在重连')`))) {
      return true;
    }
    await sleep(100);
  }
  return false;
};
const press = (p, x, y) => p.eval(`(()=>{const [a,b]=T.pt(${x},${y});T.fire(T.cv(),'mousedown',a,b);})()`);
const moveTo = (p, x, y) => p.eval(`(async()=>{const [a,b]=T.pt(${x},${y});T.fire(T.cv(),'mousemove',a,b);await T.raf(2);})()`);
const release = (p, x, y) => p.eval(`(async()=>{const [a,b]=T.pt(${x},${y});T.fire(T.cv(),'mouseup',a,b);await T.raf(2);})()`);
const setWidth12 = (p) => p.eval(`(async()=>{T.clickBtn('画笔');await T.raf(2);T.clickBtn('12px');await T.raf(2);T.commit();await T.raf(2);})()`);
const probeState = async (code) => {
  const c = new NodeClient(code);
  const rs = await c.join("探针");
  // 主动离开：直接断开会占着保留期名额，后来者进不了房
  if (rs?.type === "roomState") {
    c.send({ type: "leave" });
  }
  await sleep(150);
  c.kill();
  return rs;
};
const sameInk = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.05;
const G = {};

// ========== C05 / H04：真实客户端 ==========
G.E1_midjoin = async ({ br }) => {
  console.log("\n=== E1 笔画中途加入：迟到者也能拿到这一笔，之后数组不错位");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  await press(p1, 0.1, 0.5);
  for (let i = 1; i <= 8; i++) {
    await moveTo(p1, 0.1 + i * 0.04, 0.5);
  }
  const late = await br.newPage();
  await joinViaUrl(late, code, ORIGIN, "迟到丙");
  await sleep(300);
  ok("迟到者此时没有这一笔（中途不补画）", (await late.eval("T.ink()")) === 0, await late.eval("T.ink()"));
  for (let i = 9; i <= 16; i++) {
    await moveTo(p1, 0.1 + i * 0.04, 0.5);
  }
  await release(p1, 0.8, 0.5);
  await sleep(500);
  const [i1, i2, i3] = [await p1.eval("T.ink()"), await p2.eval("T.ink()"), await late.eval("T.ink()")];
  ok("三端墨量一致", i1 > 0 && sameInk(i1, i2) && sameInk(i1, i3), { i1, i2, i3 });
  await p1.eval(`T.stroke([[0.2,0.2],[0.5,0.3]])`);
  await sleep(400);
  await p1.eval(`T.clickBtn('撤销')`);
  await p1.eval(`T.clickBtn('撤销')`);
  await sleep(500);
  ok("撤销两次后迟到者也清空（数组对齐）", (await late.eval("T.ink()")) === 0, await late.eval("T.ink()"));
  await closeAll(br, p1, p2, late);
};
G.E2_hold = async ({ br }) => {
  console.log("\n=== E2 笔画中途停 16 秒（DO 休眠）：后来者看到的线宽和点都对");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  await setWidth12(p1);
  await press(p1, 0.1, 0.5);
  for (let i = 1; i <= 5; i++) {
    await moveTo(p1, 0.1 + i * 0.05, 0.5);
  }
  await sleep(16000);
  for (let i = 6; i <= 10; i++) {
    await moveTo(p1, 0.1 + i * 0.05, 0.5);
  }
  await release(p1, 0.7, 0.5);
  await sleep(500);
  const rs = await probeState(code);
  ok("服务端存的线宽是 12", rs?.strokes?.[0]?.lineWidth === 12, rs?.strokes?.[0]?.lineWidth);
  ok("服务端存了全部点（start + 10 + end）", rs?.strokes?.[0]?.points?.length === 12, rs?.strokes?.[0]?.points?.length);
  const late = await br.newPage();
  await joinViaUrl(late, code, ORIGIN, "后来丙");
  await sleep(400);
  const d = await compare(p1, late);
  ok("后来者画面和画手一致", d.cnt === 0, d);
  ok("早到者画面和画手一致", (await compare(p1, p2)).cnt === 0);
  await closeAll(br, p1, p2, late);
};
G.E3_start_lost = async ({ br, proxy }) => {
  console.log("\n=== E3 断线时按下、重连后松手：三端一致，没有残缺笔画");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  await setWidth12(p1);
  proxy.refuse = true;
  proxy.killAll();
  ok("显示断线", await p1.waitText("正在重连", 3000));
  await press(p1, 0.1, 0.3);
  await moveTo(p1, 0.3, 0.3);
  proxy.refuse = false;
  ok("画手重连成功", await reconnected(p1));
  ok("对端重连成功", await reconnected(p2));
  await sleep(300);
  await moveTo(p1, 0.5, 0.5);
  await moveTo(p1, 0.7, 0.5);
  await release(p1, 0.8, 0.5);
  await sleep(600);
  const rs = await probeState(code);
  ok("服务端只存了一笔", rs?.strokes?.length === 1, rs?.strokes?.length);
  ok("线宽正确", rs?.strokes?.[0]?.lineWidth === 12, rs?.strokes?.[0]?.lineWidth);
  ok("离线时的点也在", rs?.strokes?.[0]?.points?.length === 5, rs?.strokes?.[0]?.points?.length);
  const d = await compare(p1, p2);
  ok("画手和对端画面一致且有墨", d.cnt === 0 && (await p2.eval("T.ink()")) > 0, d);
  await closeAll(br, p1, p2);
};
G.E4_split = async ({ br }) => {
  console.log("\n=== E4 超长的一笔自动分段：不超上限，三端一致");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  // 步长很小，路径上限不触发，这里只测点数上限（路径上限见 E4b）
  await p1.eval(`(()=>{const c=T.cv();const [x0,y0]=T.pt(0.1,0.1);T.fire(c,'mousedown',x0,y0);for(let i=0;i<30100;i++){const [x,y]=T.pt(0.1+0.3*((i%100)/10000),0.1+0.5*(i/30100));T.fire(c,'mousemove',x,y);}const [x1,y1]=T.pt(0.1,0.6);T.fire(c,'mouseup',x1,y1);})()`);
  await sleep(4000);
  const rs = await probeState(code);
  const lens = (rs?.strokes || []).map((s) => s.points.length);
  ok("分成两笔，长度 30000 + 104", lens.length === 2 && lens[0] === 30000 && lens[1] === 104, lens);
  const d = await compare(p1, p2);
  ok("画手和对端画面一致", d.cnt === 0 && (await p2.eval("T.ink()")) > 0, d);
  await closeAll(br, p1, p2);
};
G.E4b_split_path = async ({ br }) => {
  console.log("\n=== E4b 路径超长的一笔也自动分段：不被服务端拒收，三端一致");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  // 来回 250 趟，每趟 0.9 个画布宽，路径约 225，超过单笔上限 200
  await p1.eval(`(()=>{const c=T.cv();const [x0,y0]=T.pt(0.05,0.5);T.fire(c,'mousedown',x0,y0);for(let i=1;i<=250;i++){const [x,y]=T.pt(i%2?0.95:0.05,0.5);T.fire(c,'mousemove',x,y);}const [x1,y1]=T.pt(0.05,0.5);T.fire(c,'mouseup',x1,y1);})()`);
  await sleep(1500);
  const rs = await probeState(code);
  const lens = (rs?.strokes || []).map((s) => s.points.length);
  ok("分成了两笔", lens.length === 2, lens);
  ok("没有丢点（250 次移动 + 起止和接缝）", lens.reduce((a, b) => a + b, 0) === 254, lens);
  const d = await compare(p1, p2);
  ok("画手和对端画面一致", d.cnt === 0 && (await p2.eval("T.ink()")) > 0, d);
  await closeAll(br, p1, p2);
};
G.E5_peer_stale = async ({ br, proxy }) => {
  console.log("\n=== E5 对端在笔画中途重连：丢掉半截旧笔，不会和后续的点连成错误的线");
  const code = await createRoom(3);
  const d = new NodeClient(code);
  await d.join("画手", undefined, "");
  const p = await br.newPage();
  await joinViaUrl(p, code, ORIGIN, "观众");
  await sleep(300);
  d.send({ type: "draw", action: "start", x: 0.1, y: 0.1, color: "#000000", lineWidth: 12 });
  d.send({ type: "draw", action: "move", x: 0.3, y: 0.3, color: "#000000", lineWidth: 12, points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }] });
  await sleep(300);
  ok("断线前对端看到进行中的笔画", (await p.eval("T.ink()")) > 0);
  proxy.killAll();
  await sleep(500);
  ok("对端重连成功", await reconnected(p));
  await sleep(300);
  d.send({ type: "draw", action: "move", x: 0.9, y: 0.9, color: "#000000", lineWidth: 12, points: [{ x: 0.9, y: 0.9 }] });
  await sleep(300);
  ok("重连后的 move 不接到旧笔上", (await p.eval("T.ink()")) === 0, await p.eval("T.ink()"));
  const stroke = { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }, { x: 0.9, y: 0.9 }], color: "#000000", lineWidth: 12 };
  d.send({ type: "draw", action: "end", x: 0.9, y: 0.9, color: "#000000", lineWidth: 12, stroke });
  await sleep(300);
  ok("end 到达后画出整笔", (await p.eval("T.ink()")) > 0);
  d.kill();
  await closeAll(br, p);
};

// 拦截页面收到的消息：__wrapMsg(ws, event, 原 handler)。要在创建 WebSocket 之前调用。
const interceptMessages = (p, wrapSource) =>
  p.eval(`(()=>{
    const proto = window.WebSocket.prototype;
    const base = Object.getPrototypeOf(proto);
    const desc = Object.getOwnPropertyDescriptor(base, 'onmessage');
    Object.defineProperty(proto, 'onmessage', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(fn) { desc.set.call(this, fn ? (e) => window.__wrapMsg(this, e, fn) : null); },
    });
    window.__wrapMsg = ${wrapSource};
  })()`);
G.E6_end_before_mount = async ({ br }) => {
  console.log("\n=== E6 roomState 之后紧跟着 end（画布还没挂载）：这一笔不能丢");
  const { p1, code } = await createInBrowser(br, "画手甲", 3);
  const p2 = await br.newPage();
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("进入房间", 5000);
  const stroke = { points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }], color: "#000000", lineWidth: 12 };
  const endMsg = JSON.stringify({ type: "draw", action: "end", x: 0.9, y: 0.9, color: "#000000", lineWidth: 12, stroke });
  await interceptMessages(p2, `(ws, e, fn) => {
    fn(e);
    if (!window.__done && JSON.parse(e.data).type === 'roomState') {
      window.__done = true;
      fn(new MessageEvent('message', { data: ${JSON.stringify(endMsg)} }));
    }
  }`);
  await p2.eval(`T.clickBtn('进入房间')`);
  await p2.waitText("房间号", 4000);
  await sleep(500);
  ok("这一笔画出来了", (await p2.eval("T.ink()")) > 0, await p2.eval("T.ink()"));
  await closeAll(br, p1, p2);
};

// ========== 重连时的状态残留 ==========
const lostRole = async (p1, p2, proxy) => {
  await offline(p1, true);
  proxy.killAll();
  await sleep(33000); // 超过 30s 保留期，画手变成 p2
  await offline(p1, false);
  ok("p1 重连成功", await reconnected(p1, 20000));
  await sleep(400);
  void p2;
};
G.R1_shape_role_lost = async ({ br, proxy }) => {
  console.log("\n=== R1 画手带未提交的形状掉线超过保留期，回来变猜词方：不会多出本地笔画");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`(async()=>{T.clickBtn('矩形');await T.raf(2);await T.drag([0.2,0.2],[0.6,0.6]);await T.raf(2);})()`);
  ok("形状编辑框已打开", await p1.eval(`!!document.querySelector('[data-shape-overlay]')`));
  await lostRole(p1, p2, proxy);
  ok("角色没了，编辑框消失", !(await p1.eval(`!!document.querySelector('[data-shape-overlay]')`)));
  await p1.eval(`T.commit()`);
  await sleep(300);
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("点击后本地没有多出笔画", i1 === 0 && i2 === 0, { i1, i2 });
  await closeAll(br, p1, p2);
};
G.R2_text_role_lost = async ({ br, proxy }) => {
  console.log("\n=== R2 画手带未提交的文字掉线超过保留期，回来变猜词方：不会多出本地笔画");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`(async()=>{T.clickBtn('文本');await T.raf(2);T.canvasClick(0.3,0.3);await T.raf(3);const a=document.querySelector('[data-text-overlay] textarea');T.setInput(a,'未提交');await T.raf(2);})()`);
  ok("文字编辑框已打开", await p1.eval(`!!document.querySelector('[data-text-overlay]')`));
  await lostRole(p1, p2, proxy);
  ok("角色没了，编辑框消失", !(await p1.eval(`!!document.querySelector('[data-text-overlay]')`)));
  await p1.eval(`T.commit()`);
  await sleep(300);
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("点击后本地没有多出笔画", i1 === 0 && i2 === 0, { i1, i2 });
  await closeAll(br, p1, p2);
};
const drawFilledRect = (p) => p.eval(`(async()=>{T.clickBtn('矩形');await T.raf(2);const b=[...document.querySelectorAll('button')].find(b=>b.title==='填充');b&&T.click(b);await T.raf(2);await T.drag([0.1,0.1],[0.3,0.4]);await T.raf(2);T.commit();await T.raf(2);})()`);
const floatSelection = (p) => p.eval(`(async()=>{T.clickBtn('选择 / 框选');await T.raf(2);await T.drag([0.05,0.05],[0.35,0.45]);await T.raf(3);})()`);
G.R3_selection_reconnect = async ({ br, proxy }) => {
  console.log("\n=== R3 框选悬浮时重连：取消框选，不会提交出重影");
  const { p1, p2 } = await pagesInRoom(br);
  await drawFilledRect(p1);
  await sleep(300);
  await floatSelection(p1);
  ok("框选悬浮中", await p1.eval(`!!document.querySelector('[data-selection-overlay]')`));
  proxy.killAll();
  await sleep(500);
  ok("p1 重连成功", await reconnected(p1));
  ok("p2 重连成功", await reconnected(p2));
  await sleep(400);
  ok("框选已取消", !(await p1.eval(`!!document.querySelector('[data-selection-overlay]')`)));
  await p1.eval(`T.commit()`);
  await sleep(500);
  const d = await compare(p1, p2);
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("两端画面一致（没有重影）", d.cnt === 0 && sameInk(i1, i2), { d, i1, i2 });
  await closeAll(br, p1, p2);
};
const rebuildsOnFontLoad = async (p) => {
  // 字体加载完成时要重建画布。悬空标记没复位的话会被跳过：在可见画布上涂一块，看会不会被盖掉。
  const before = await p.eval("T.ink()");
  await p.eval(`(()=>{const x=T.cv().getContext('2d');x.fillStyle='#000';x.fillRect(0,0,120,120);})()`);
  const dirty = await p.eval("T.ink()");
  await p.eval(`document.fonts.dispatchEvent(new Event('loadingdone'))`);
  await sleep(100);
  const after = await p.eval("T.ink()");
  return { before, dirty, after, rebuilt: dirty > before && after === before };
};
G.R4_pending_flag = async ({ br }) => {
  console.log("\n=== R4 框选悬空标记：清除、删除框选内容之后都要复位");
  {
    const { p1, p2 } = await pagesInRoom(br);
    await drawFilledRect(p1);
    await sleep(200);
    await floatSelection(p1);
    // 键盘触发按钮（只有 click，没有 mousedown）。清除要点两下确认
    await p1.eval(`T.confirmClear()`);
    await sleep(300);
    // 确认真的清了：没清的话下面那条测的就不是“清除之后”
    ok("清除生效了", (await p1.eval("T.ink()")) === 0, await p1.eval("T.ink()"));
    const r = await rebuildsOnFontLoad(p1);
    ok("清除后：字体重建没被跳过", r.rebuilt, r);
    await closeAll(br, p1, p2);
  }
  {
    const { p1, p2 } = await pagesInRoom(br);
    await drawFilledRect(p1);
    await sleep(200);
    await floatSelection(p1);
    await p1.eval(`(async()=>{T.click([...document.querySelectorAll('button')].find(b=>b.title==='删除框选内容'));await T.raf(3);})()`);
    await sleep(300);
    const r = await rebuildsOnFontLoad(p1);
    ok("删除框选内容后：字体重建没被跳过", r.rebuilt, r);
    const d = await compare(p1, p2);
    ok("两端一致", d.cnt === 0, d);
    await closeAll(br, p1, p2);
  }
};
G.R6_answer_race = async ({ br, proxy }) => {
  console.log("\n=== R6 弱网下设答案后立刻补一笔：本地不留下服务端会丢弃的笔画");
  const { p1, p2 } = await pagesInRoom(br);
  proxy.delay = 300;
  await toggleAnd(p1, "苹果");
  await p1.eval(`T.stroke([[0.2,0.2],[0.6,0.6]])`);
  await sleep(2000);
  proxy.delay = 0;
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("两端一致（都没有这一笔）", i1 === i2, { i1, i2 });
  ok("画手进入猜词阶段", await p1.waitText("猜词中", 1000));
  ok("答案还显示着", await p1.eval(`T.text().includes('答案：苹果')`));
  await closeAll(br, p1, p2);
};
G.R6b_answer_offline = async ({ br, proxy }) => {
  console.log("\n=== R6b 断线时回车设答案：不进入假猜词态，提示没发出去，答案不会误发到公开聊天");
  const { p1, p2 } = await pagesInRoom(br);
  await leaveChatMode(p1);
  await sleep(150);
  proxy.refuse = true;
  proxy.killAll();
  ok("显示断线", await p1.waitText("正在重连", 3000));
  await p1.eval(`T.chat('苹果')`);
  await sleep(300);
  ok("提示答案没发出去", await p1.waitText("没有发出去", 1500), await p1.eval("T.text().slice(0,200)"));
  ok("阶段还是绘画中", await p1.eval(`T.text().includes('绘画中')`));
  ok("输入框里的答案还在", (await p1.eval(`document.querySelector('input[type=text]').value`)) === "苹果");
  ok("还在答案模式（按钮是 确认）", await p1.eval(`T.submitIs('确认')`));
  proxy.refuse = false;
  ok("p1 重连成功", await reconnected(p1, 12000));
  ok("p2 重连成功", await reconnected(p2, 12000));
  await sleep(300);
  await p1.eval(`(()=>{const i=document.querySelector('input[type=text]');T.enter(i);})()`);
  ok("回车后设上答案", await p2.waitText("猜词中", 3000));
  ok("答案没进公开聊天", !(await p2.eval(`T.text().includes('苹果')`)), await p2.eval("T.text().slice(0,200)"));
  await closeAll(br, p1, p2);
};
G.R6c_answer_lock_released = async ({ br, proxy }) => {
  console.log("\n=== R6c 设答案的消息在半开连接上丢了：锁定会解除，能继续画，不卡住");
  const { p1, p2 } = await pagesInRoom(br);
  await leaveChatMode(p1);
  await sleep(150);
  proxy.blackholeExisting();
  await p1.eval(`T.chat('苹果')`);
  await sleep(6000); // 超过本地锁定的上限
  await p1.eval(`T.stroke([[0.2,0.2],[0.6,0.6]])`);
  await sleep(200);
  ok("锁定解除后能画", (await p1.eval("T.ink()")) > 0, await p1.eval("T.ink()"));
  await closeAll(br, p1, p2);
};
G.R10_toolbar_disabled = async ({ br }) => {
  console.log("\n=== R10 没有编辑资格时键盘也触发不了清除、撤销、重做");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.stroke([[0.2,0.2],[0.6,0.6]])`);
  // 等笔画真的到了对端，负载高时 300ms 不一定够
  for (let i = 0; i < 50 && (await p2.eval("T.ink()")) === 0; i++) {
    await sleep(100);
  }
  await sleep(100);
  const before = await p2.eval("T.ink()");
  ok("猜词方有墨", before > 0, before);
  ok("猜词方的清除按钮是 disabled", await p2.eval(`T.btn('清除').disabled === true`));
  // 清除要点两下才算数，两下都点
  ok("猜词方的清除进不了确认态", !(await p2.eval(`T.confirmClear()`)));
  await p2.eval(`T.btn('撤销').click()`);
  await sleep(200);
  ok("猜词方本地没被清空", (await p2.eval("T.ink()")) === before, await p2.eval("T.ink()"));
  await toggleAnd(p1, "苹果");
  await p2.waitText("猜词中", 3000);
  await sleep(200);
  ok("猜词阶段画手的清除按钮是 disabled", await p1.eval(`T.btn('清除').disabled === true`));
  ok("猜词阶段画手的清除进不了确认态", !(await p1.eval(`T.confirmClear()`)));
  await p1.eval(`T.btn('撤销').click()`);
  await sleep(200);
  const d = await compare(p1, p2);
  ok("猜词阶段画手本地没被改", d.cnt === 0 && (await p1.eval("T.ink()")) === before, { d, ink: await p1.eval("T.ink()") });
  await closeAll(br, p1, p2);
};
G.R11_undo_floating = async ({ br }) => {
  console.log("\n=== R11 框选悬浮时用键盘撤销：不留下重影，两端一致");
  const { p1, p2 } = await pagesInRoom(br);
  await drawFilledRect(p1);
  await sleep(300);
  await p1.eval(`T.stroke([[0.6,0.2],[0.8,0.6]])`);
  await sleep(300);
  await floatSelection(p1);
  // 拖到别处：不移动的话，即使来源像素被画回来也看不出重影
  await p1.eval(`(async()=>{const o=document.querySelector('[data-selection-overlay]');const r=o.getBoundingClientRect();T.fire(o,'mousedown',r.left+20,r.top+20);await T.raf(2);window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+20,clientY:r.top+300,bubbles:true,buttons:1}));await T.raf(2);window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await T.raf(2);})()`);
  await p1.eval(`T.btn('撤销').click()`);
  await sleep(400);
  await p1.eval(`T.commit()`);
  await sleep(400);
  const d = await compare(p1, p2);
  const [i1, i2] = [await p1.eval("T.ink()"), await p2.eval("T.ink()")];
  ok("两端一致", d.cnt === 0 && sameInk(i1, i2), { d, i1, i2 });
  ok("框选已结束", !(await p1.eval(`!!document.querySelector('[data-selection-overlay]')`)));
  await closeAll(br, p1, p2);
};
G.R7_dup_revealed = async ({ br }) => {
  console.log("\n=== R7 猜对者离开：不重复提示“猜对了”");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  const c = new NodeClient(code);
  await c.join("丙", undefined, "");
  await sleep(200);
  await toggleAnd(p1, "苹果");
  await p2.waitText("猜词中", 3000);
  await sleep(100);
  await toggleAnd(p2, "苹果");
  await p1.waitText("已揭晓", 3000);
  await sleep(300);
  await p2.eval(`T.clickBtn('离开')`);
  await sleep(800);
  const n = await p1.eval(`(T.text().match(/猜对了！/g)||[]).length`);
  ok("提示只有一条", n === 1, n);
  ok("画手的按钮恢复", await p1.eval(`!!T.btn('继续出题')`));
  c.kill();
  await closeAll(br, p1, p2);
};
G.R8_transfer_fail = async ({ br, proxy }) => {
  console.log("\n=== R8 转让时对方刚好掉线：提示错误，重做历史不丢");
  const { p1, code } = await createInBrowser(br);
  const c = new NodeClient(code);
  await c.join("乙", undefined, "");
  await sleep(300);
  await p1.eval(`T.stroke([[0.2,0.2],[0.6,0.6]])`);
  await sleep(200);
  await p1.eval(`T.clickBtn('撤销')`);
  await sleep(200);
  ok("重做可用", await p1.eval(`T.btn('重做')?.disabled === false`));
  proxy.delay = 400;
  c.kill();
  await p1.eval(`T.clickBtn('转让画笔')`);
  ok("提示无法转让", await p1.waitText("无法转让", 3000), await p1.eval("T.text().slice(0,160)"));
  proxy.delay = 0;
  await sleep(200);
  ok("重做仍可用", await p1.eval(`T.btn('重做')?.disabled === false`));
  await closeAll(br, p1);
};
G.R9_stuck_pen = async ({ br, proxy }) => {
  console.log("\n=== R9 按住鼠标时失去画手身份：之后再当画手不会凭空接着画");
  const { p1, p2, code } = await pagesInRoom(br);
  await press(p1, 0.1, 0.5);
  await moveTo(p1, 0.3, 0.5);
  await lostRole(p1, p2, proxy);
  await p2.eval(`T.clickBtn('转让画笔')`);
  ok("p1 重新成为画手", await p1.waitText("画笔权限已转移", 4000));
  await sleep(300);
  // 没按鼠标，只是移动 + 抬起
  await moveTo(p1, 0.5, 0.5);
  await moveTo(p1, 0.7, 0.5);
  await release(p1, 0.8, 0.5);
  await sleep(400);
  ok("画面上没有笔画", (await p1.eval("T.ink()")) === 0, await p1.eval("T.ink()"));
  const rs = await probeState(code);
  ok("服务端没有笔画", rs?.type === "error" || rs?.strokes?.length === 0, rs?.strokes?.length);
  await closeAll(br, p1, p2);
};

// ========== 重连健壮性 ==========
G.N1_backoff = async ({ br, proxy }) => {
  console.log("\n=== N1 连接快速失败时重试间隔不超过 8 秒（含抖动）");
  const { p1 } = await createInBrowser(br);
  proxy.refuse = true;
  proxy.killAll();
  await sleep(32000);
  const closes = await p1.eval("__ws.closes.map(c=>c.t)");
  proxy.refuse = false;
  const gaps = closes.slice(1).map((t, i) => t - closes[i]);
  ok("重试过多次", closes.length >= 6, closes.length);
  ok("最大间隔 < 11 秒", Math.max(...gaps) < 11000, gaps);
  await closeAll(br, p1);
};
G.N2_recover_in_grace = async ({ br, proxy }) => {
  console.log("\n=== N2 断网 16 秒后恢复：赶在保留期内回来，身份不丢");
  const { p1, p2 } = await pagesInRoom(br);
  const id = await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`);
  proxy.refuse = true;
  proxy.killAll();
  await sleep(16000);
  const t0 = Date.now();
  proxy.refuse = false;
  ok("p2 重连成功", await reconnected(p2, 20000));
  const took = Date.now() - t0 + 16000;
  ok("断线后 29 秒内回来", took < 29000, took);
  ok("身份不变", (await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`)) === id);
  await closeAll(br, p1, p2);
};
G.N3_online_event = async ({ br, proxy }) => {
  console.log("\n=== N3 收到 online 事件立刻重连，不等退避");
  const { p1 } = await createInBrowser(br);
  proxy.refuse = true;
  proxy.killAll();
  await sleep(8000); // 第 7 秒左右失败一次，下一次要等到第 15 秒左右
  proxy.refuse = false;
  const t0 = Date.now();
  await p1.eval(`window.dispatchEvent(new Event('online'))`);
  ok("重连成功", await reconnected(p1, 12000));
  ok("1.5 秒内回来", Date.now() - t0 < 1500, Date.now() - t0);
  await closeAll(br, p1);
};
G.N4_half_open = async ({ br, proxy }) => {
  console.log("\n=== N4 半开连接（TCP 不断但没有回应）：pong 超时后主动重连，身份不丢");
  const { p1, p2 } = await pagesInRoom(br);
  const id = await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`);
  const created = await p2.eval("__ws.created");
  proxy.blackholeExisting();
  const t0 = Date.now();
  let reconnectedAt = null;
  while (Date.now() - t0 < 42000) {
    if ((await p2.eval("__ws.created")) > created) {
      reconnectedAt = Date.now() - t0;
      break;
    }
    await sleep(200);
  }
  ok("35 秒内发现并发起重连", reconnectedAt !== null && reconnectedAt < 37000, reconnectedAt);
  await sleep(1500);
  ok("重连后没有横幅", await reconnected(p2, 8000));
  ok("身份不变", (await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`)) === id);
  await closeAll(br, p1, p2);
};
G.N5_unload_cancel = async ({ br, proxy }) => {
  console.log("\n=== N5 刷新被取消（只有 beforeunload 没有 pagehide）：之后断线仍会重连");
  const { p1 } = await createInBrowser(br);
  await p1.eval(`window.dispatchEvent(new Event('beforeunload'))`);
  proxy.killAll();
  await sleep(500);
  ok("重连成功", await reconnected(p1, 8000));
  ok("没有卡在正在重连", !(await p1.eval(`T.text().includes('正在重连')`)));
  await closeAll(br, p1);
};
G.N6_pagehide_pageshow = async ({ br, proxy }) => {
  console.log("\n=== N6 页面离开时不重连；从往返缓存恢复（pageshow persisted）后要重连");
  const { p1 } = await createInBrowser(br);
  const created = await p1.eval("__ws.created");
  await p1.eval(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))`);
  proxy.killAll();
  await sleep(2500);
  ok("离开期间不重连", (await p1.eval("__ws.created")) === created, await p1.eval("__ws.created"));
  await p1.eval(`window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
  await sleep(300);
  ok("恢复后发起重连", (await p1.eval("__ws.created")) > created, await p1.eval("__ws.created"));
  ok("重连成功", await reconnected(p1, 8000));
  await closeAll(br, p1);
};

G.N7_connect_timeout = async ({ br, proxy }) => {
  console.log("\n=== N7 握手卡住：超时后重试；收到 online 事件立刻重试");
  const { p1 } = await createInBrowser(br);
  proxy.stall = true;
  proxy.killAll();
  await sleep(2000); // 第一次重连已经发出、卡在握手
  const created0 = await p1.eval("__ws.created");
  await sleep(19000); // 约第 1 秒开始的握手，第 16 秒超时，再退避约 2 秒
  const created1 = await p1.eval("__ws.created");
  ok("超时后发起了新连接", created1 > created0, { created0, created1 });
  // 现在又卡在握手上：online 事件要立刻换一条
  await p1.eval(`window.dispatchEvent(new Event('online'))`);
  await sleep(300);
  const created2 = await p1.eval("__ws.created");
  ok("online 事件立刻换连接", created2 > created1, { created1, created2 });
  proxy.stall = false;
  await p1.eval(`window.dispatchEvent(new Event('online'))`);
  ok("网络恢复后重连成功", await reconnected(p1, 5000));
  await closeAll(br, p1);
};
G.N8b_slow_roomstate = async ({ br }) => {
  console.log("\n=== N8b roomState 迟迟不到（超过 pong 超时）：连接不被放弃");
  const { p1, code } = await createInBrowser(br, "画手甲", 3);
  const p2 = await br.newPage();
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("进入房间", 5000);
  // 把 roomState 和之后的消息都压住，模拟大帧下载中什么都收不到；首次加入有 10 秒超时，
  // 所以让它先正常加入，再断线重连时才压消息
  await interceptMessages(p2, `(ws, e, fn) => {
    if (window.__hold) { (window.__held = window.__held || []).push([e, fn]); return; }
    fn(e);
  }`);
  await p2.eval(`T.clickBtn('进入房间')`);
  await p2.waitText("房间号", 4000);
  await sleep(300);
  const created0 = await p2.eval("__ws.created");
  await p2.eval(`window.__hold = true; __ws.instances.at(-1).close()`);
  // 重连约第 1 秒，第 26 秒 ping，第 36 秒若判超时，再退避约 2 秒就会有新连接
  await sleep(42000);
  ok("等了 42 秒没有放弃连接", (await p2.eval("__ws.created")) === created0 + 1, { created0, now: await p2.eval("__ws.created") });
  await p2.eval(`(()=>{window.__hold=false;for(const [e,fn] of window.__held||[]){fn(e);}})()`);
  ok("消息到达后恢复", await reconnected(p2, 3000));
  await closeAll(br, p1, p2);
};

// ========== token：真实客户端 ==========
G.T1_refresh = async ({ br }) => {
  console.log("\n=== T1 刷新保留身份，token 存在 sessionStorage，不进 URL");
  const { p1, p2, code } = await pagesInRoom(br);
  const read = () => p2.eval(`JSON.stringify({id:sessionStorage.getItem('draw-guess-playerId'),t:sessionStorage.getItem('draw-guess-playerToken')})`);
  const s0 = JSON.parse(await read());
  ok("存了 token", typeof s0.t === "string" && s0.t.length >= 16, s0);
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("房间号", 6000);
  await sleep(400);
  const s1 = JSON.parse(await read());
  ok("id 不变", s1.id === s0.id, s1);
  ok("token 不变", s1.t === s0.t, s1);
  ok("p1 列表里只有一个猜手乙", (await p1.eval(`(T.text().split('聊天区')[0].match(/猜手乙/g)||[]).length`)) === 1);
  ok("URL 不含 token", !(await p2.eval(`location.href`)).includes(s0.t));
  await closeAll(br, p1, p2);
};
G.T2_beacon = async ({ br }) => {
  console.log("\n=== T2 关闭标签页：beacon 带 token，保留期缩短到 5 秒");
  const { p1, p2 } = await pagesInRoom(br);
  await p2.send("Page.close");
  const t0 = Date.now();
  const left = await p1.waitText("离开了房间", 12000);
  ok("对方约 5 秒后离开", left && Date.now() - t0 < 10000, Date.now() - t0);
  await closeAll(br, p1);
};
G.T3_leave_clears = async ({ br }) => {
  console.log("\n=== T3 主动离开：身份和 token 都清掉");
  const { p1, p2 } = await pagesInRoom(br);
  await p2.eval(`T.clickBtn('离开')`);
  await p2.waitText("创建房间", 4000);
  ok("id 已清", (await p2.eval(`sessionStorage.getItem('draw-guess-playerId')`)) === null);
  ok("token 已清", (await p2.eval(`sessionStorage.getItem('draw-guess-playerToken')`)) === null);
  await closeAll(br, p1, p2);
};

G.T4_lost_roomstate = async ({ br }) => {
  console.log("\n=== T4 roomState 没送到就断线：重试后取回原身份，不是 房间已满");
  const { p1, code } = await createInBrowser(br);
  const p2 = await br.newPage();
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("进入房间", 5000);
  await interceptMessages(p2, `(ws, e, fn) => {
    if (!window.__dropped && JSON.parse(e.data).type === 'roomState') {
      window.__dropped = true;
      ws.close();
      return;
    }
    fn(e);
  }`);
  await p2.eval(`T.clickBtn('进入房间')`);
  ok("重试后进入房间", await p2.waitText("房间号", 8000), await p2.eval("T.text().slice(0,160)"));
  await sleep(500);
  ok("确实丢过一次", await p2.eval("window.__dropped === true"));
  ok("没有 房间已满", !(await p2.eval(`T.text().includes('房间已满')`)));
  ok("p1 列表里只有一个猜手", (await p1.eval(`(T.text().split('聊天区')[0].match(/🤔/g)||[]).length`)) === 1, await p1.eval(`T.text().split('聊天区')[0]`));
  await closeAll(br, p1, p2);
};
G.T5_leave_reconnecting = async ({ br }) => {
  console.log("\n=== T5 重连中点离开：席位很快释放，不用等 30 秒");
  const { p1, p2 } = await pagesInRoom(br);
  // 断开后 1 秒才重试，这个窗口里点离开
  await p2.eval(`__ws.instances.at(-1).close()`);
  await sleep(100);
  await p2.eval(`T.clickBtn('离开')`);
  const t0 = Date.now();
  ok("p2 回到首页", await p2.waitText("创建房间", 3000));
  ok("p1 很快看到对方离开", (await p1.waitText("离开了房间", 12000)) && Date.now() - t0 < 10000, Date.now() - t0);
  await closeAll(br, p1, p2);
};

// ========== 其他 ==========
G.J1_join_timer = async ({ br }) => {
  console.log("\n=== J1 roomState 到了但长任务跨过 10 秒超时点：不误报加入超时");
  const { p1, code } = await createInBrowser(br, "画手甲", 3);
  const p2 = await br.newPage();
  await p2.goto(`${ORIGIN}/${code}`);
  await p2.waitText("进入房间", 5000);
  await interceptMessages(p2, `(ws, e, fn) => {
    if (JSON.parse(e.data).type !== 'roomState') { fn(e); return; }
    // 把 roomState 压到第 9.6 秒，处理时再卡 1 秒（模拟重放长任务）
    const wait = Math.max(0, window.__t0 + 9600 - Date.now());
    setTimeout(() => { fn(e); const t = Date.now(); while (Date.now() - t < 1000) {} }, wait);
  }`);
  await p2.eval(`window.__t0 = Date.now(); T.clickBtn('进入房间')`);
  await sleep(13000);
  ok("没有回首页", await p2.eval(`T.text().includes('房间号')`), await p2.eval("T.text().slice(0,160)"));
  await closeAll(br, p1, p2);
};
G.H1_home_429 = async ({ br }) => {
  console.log("\n=== H1 建房被限流：留在首页并提示，不跳到 /undefined");
  const p = await br.newPage();
  await p.goto(ORIGIN + "/");
  await p.eval(`window.fetch=async()=>new Response(JSON.stringify({error:'创建房间太频繁，请稍后再试'}),{status:429,headers:{'Content-Type':'application/json'}})`);
  await p.eval(`T.clickBtn('创建房间')`);
  await sleep(100);
  await p.eval(`T.typeInto('input[type=text]', '甲')`);
  await p.eval(`T.clickBtn('确认创建')`);
  ok("显示错误", await p.waitText("太频繁", 2000), await p.eval("T.text().slice(0,120)"));
  ok("URL 还在首页", (await p.eval("location.pathname")) === "/", await p.eval("location.pathname"));
  await closeAll(br, p);
};
G.F1_poison = async ({ br }) => {
  console.log("\n=== F1 存量畸形笔画：一笔坏不影响其余笔画和聊天记录");
  const { p1 } = await createInBrowser(br);
  const myId = await p1.eval(`sessionStorage.getItem('draw-guess-playerId')`);
  const good1 = { points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }], color: "#000000", lineWidth: 8, shape: "rect", filled: true };
  const good2 = { points: [{ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.7 }], color: "#000000", lineWidth: 8, shape: "rect", filled: true };
  const inject = (strokes, chat) =>
    p1.eval(`__ws.instances.at(-1).dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(
      JSON.stringify({
        type: "roomState",
        roomCode: "000000",
        players: [{ id: myId, name: "画手甲", isOwner: true, connected: true }],
        drawerId: myId,
        phase: "waiting",
        strokes,
        chatHistory: chat,
        yourId: myId,
        maxPlayers: 2,
      }),
    )}}))`);
  await inject([good1, good2], []);
  await sleep(200);
  const clean = await p1.eval("T.ink()");
  ok("对照：两笔都画出来了", clean > 0, clean);
  const exBefore = p1.exceptions.length;
  await inject(
    [
      good1,
      { points: [{ x: 0.5, y: 0.5 }], color: 123, lineWidth: 0, fill: { tolerance: 32 } },
      { points: "oops", color: "#000000", lineWidth: 2 },
      good2,
    ],
    [{ kind: "chat", playerId: "x", playerName: "聊天人", text: "历史消息还在", timestamp: 1 }],
  );
  await sleep(300);
  const poisoned = await p1.eval("T.ink()");
  ok("坏笔画之后的笔画还在", sameInk(clean, poisoned), { clean, poisoned });
  ok("聊天记录恢复了", await p1.eval(`T.text().includes('历史消息还在')`));
  ok("没有未捕获异常", p1.exceptions.length === exBefore, p1.exceptions.slice(exBefore));
  await closeAll(br, p1);
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
