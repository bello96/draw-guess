// 第三批渲染性能的断言式回归（真实客户端）。只访问本机。
// 用法：node batch3-browser.cjs [组名正则]；BUILD_DIR=build-old 切换被测前端包。
// 依赖：worker-ctl.cjs start、build-client.mjs（run.cjs 会自动处理）。退出码 = 失败条数。
const path = require("path");
const fs = require("fs");
const { sleep, serveStatic, Proxy, Browser, NodeClient, createRoom, joinViaUrl, ORIGIN } = require("./harness.cjs");

const { TMP: scratch } = require("./env.cjs");
const OLD_ORIGIN = "http://localhost:4175";

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`   ok  ${name}${detail !== undefined && process.env.VERBOSE ? "  → " + JSON.stringify(detail).slice(0, 200) : ""}`);
  } else {
    fail++;
    console.log(`   ✗   ${name}${detail !== undefined ? "  → " + JSON.stringify(detail).slice(0, 300) : ""}`);
  }
};
const closeAll = async (br, ...ps) => {
  for (const p of ps) {
    try {
      await br.b.send("Target.closeTarget", { targetId: p.id });
    } catch {}
  }
};
const until = async (fn, ms = 10000, step = 100) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    if (Date.now() > end) {
      return false;
    }
    await sleep(step);
  }
};
// 离屏画布逐像素相同（画面的唯一来源）。分片重放要点时间，等到一致或超时。
const sameOff = async (pages, ms = 12000) => {
  let last;
  const same = await until(async () => {
    last = await Promise.all(pages.map((p) => p.eval("T.offHash()")));
    return last.every((h) => h === last[0] && h !== "no-offscreen");
  }, ms, 150);
  return { same: !!same, hashes: last };
};
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
const reconnected = async (p, ms = 15000) => until(async () => !(await p.eval(`T.text().includes('正在重连')`)), ms);

// 协议层画手铺一幅带 K 次填充的画：每个格子一个空心框 + 一次填充。
async function paintGrid(d, K, extra = {}) {
  const cols = Math.ceil(Math.sqrt(K));
  let idx = 0;
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols && idx < K; c++, idx++) {
      const x = 0.02 + (c * 0.96) / cols;
      const y = 0.02 + (r * 0.96) / cols;
      const w = 0.9 / cols;
      d.send({ type: "shape", shape: "rect", filled: false, x, y, width: w, height: w, color: "#000000", lineWidth: 2 });
      d.send({ type: "fill", x: x + w / 2, y: y + w / 2, color: idx % 2 ? "#fa5151" : "#10aeff", tolerance: 32 });
      if (extra.crayon) {
        const pts = [];
        for (let i = 0; i < 80; i++) {
          pts.push({ x: x + (w * i) / 80, y: y + (w / 2) * (1 + Math.sin(i / 4)) });
        }
        const last = pts[pts.length - 1];
        d.send({ type: "draw", action: "start", x: pts[0].x, y: pts[0].y, color: "#222222", lineWidth: 6, brushType: "crayon" });
        d.send({ type: "draw", action: "end", x: last.x, y: last.y, color: "#222222", lineWidth: 6, stroke: { points: pts, color: "#222222", lineWidth: 6, brushType: "crayon" } });
      }
    }
    await sleep(40);
  }
}

// 进行中的笔画：发 start + 分批 move，不发 end。
function livePoints(from, to) {
  const pts = [];
  for (let n = from; n < to; n++) {
    pts.push({ x: 0.05 + 0.9 * (0.5 + 0.5 * Math.sin(n / 40)), y: 0.5 + 0.4 * Math.sin(n / 17) });
  }
  return pts;
}
const startLive = (d, brush, color = "#3366cc", lineWidth = 8) =>
  d.send({ type: "draw", action: "start", x: 0.1, y: 0.5, color, lineWidth, ...(brush !== "pen" ? { brushType: brush } : {}) });
const moveLive = (d, pts, color = "#3366cc", lineWidth = 8) => {
  const last = pts[pts.length - 1];
  d.send({ type: "draw", action: "move", x: last.x, y: last.y, color, lineWidth, points: pts });
};
const load = async (p, fn) => {
  const m0 = await p.metrics();
  const t0 = Date.now();
  await fn();
  const el = (Date.now() - t0) / 1000;
  const m1 = await p.metrics();
  return Math.round(((m1.TaskDuration - m0.TaskDuration) / el) * 1000);
};

const longTasks = (p) => p.eval("(async()=>{await new Promise((r)=>setTimeout(r,200));return __long.slice();})()");

const { loadGroups, mockFonts } = require("./browser-batch3-load.cjs");
const BUILD = process.env.BUILD_DIR || "build-local";
const G = {};

G.F1_fill_pollution = async ({ br }) => {
  console.log("\n=== F1 同色污染：填充不改写不连通的同色块");
  const code = await createRoom(2);
  const d = new NodeClient(code);
  await d.join("画手");
  // 右下角一块实心红色，后面填充用同一种红
  d.send({ type: "shape", shape: "rect", filled: true, x: 0.7, y: 0.7, width: 0.1, height: 0.1, color: "#ff0000", lineWidth: 0 });
  const p = await br.newPage();
  await joinViaUrl(p, code, ORIGIN, "观众");
  await sleep(500);
  const width = () =>
    p.eval(`(()=>{const c=T.off();const y=Math.floor(c.height*0.75);const d=c.getContext('2d').getImageData(0,y,c.width,1).data;let n=0;for(let x=0;x<c.width;x++){if(d[x*4]>200&&d[x*4+1]<60&&d[x*4+2]<60)n++;}return n;})()`);
  const w0 = await width();
  ok("红块宽度约 160px（离屏）", Math.abs(w0 - 160) <= 2, w0);
  for (let i = 0; i < 5; i++) {
    const x = 0.05 + i * 0.12;
    d.send({ type: "shape", shape: "rect", filled: false, x, y: 0.1, width: 0.1, height: 0.1, color: "#000000", lineWidth: 2 });
    d.send({ type: "fill", x: x + 0.05, y: 0.15, color: "#ff0000", tolerance: 32 });
  }
  await sleep(800);
  const w1 = await width();
  ok("连续 5 次同色填充后红块宽度不变", w1 === w0, { w0, w1 });
  d.kill();
  await closeAll(br, p);
};

G.R1_undo_longtask = async ({ br }) => {
  console.log("\n=== R1 撤销一笔的主线程阻塞（画作含 60 次填充）");
  const code = await createRoom(3);
  const d = new NodeClient(code);
  await d.join("画手");
  await paintGrid(d, 60);
  await sleep(300);
  const p = await br.newPage();
  await joinViaUrl(p, code, ORIGIN, "观众");
  await sleep(2500);
  await p.eval("__long.length = 0");
  d.send({ type: "undo" });
  await sleep(1000);
  const long = await longTasks(p);
  ok("撤销没有超过 100ms 的长任务", Math.max(0, ...long) < 100, long);
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "后来者");
  const r = await sameOff([p, p2]);
  ok("撤销后的画面和全量重放完全一致", r.same, r.hashes);
  d.kill();
  await closeAll(br, p, p2);
};

G.R2_join_longtask = async ({ br }) => {
  console.log("\n=== R2 新人加入时的主线程阻塞（60 次填充 + 60 条蜡笔）");
  const code = await createRoom(4);
  const d = new NodeClient(code);
  await d.join("画手");
  const live = await br.newPage();
  await joinViaUrl(live, code, ORIGIN, "实时观众");
  await sleep(300);
  await paintGrid(d, 60, { crayon: true });
  await sleep(1500);
  const p = await br.newPage();
  await p.goto(`${ORIGIN}/${code}`);
  await p.waitText("进入房间", 5000);
  await p.eval("__long.length = 0");
  await p.eval(`T.clickBtn('进入房间')`);
  const r = await sameOff([live, p]);
  const long = await longTasks(p);
  ok("加入时没有超过 200ms 的长任务", Math.max(0, ...long) < 200, long);
  ok("分片重放的结果和实时观众完全一致", r.same, r.hashes);
  d.kill();
  await closeAll(br, live, p);
};

G.R3_mixed_exact = async ({ br }) => {
  console.log("\n=== R3 全部工具 + 撤销重做删除：画手、观众、后来者逐像素一致");
  const { p1, code } = await createInBrowser(br, "画手甲", 6);
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  await sleep(300);
  const step = async (name, script) => {
    await p1.eval(`(async()=>{${script}})()`);
    await sleep(250);
    const r = await sameOff([p1, p2], 4000);
    ok(`[${name}] 两端一致`, r.same, r.hashes);
  };
  await step("画笔", `await T.stroke([[0.1,0.1],[0.2,0.2],[0.3,0.15],[0.35,0.3]]);`);
  await step("矩形", `T.clickBtn('矩形'); await T.raf(2); await T.drag([0.4,0.1],[0.6,0.4]); await T.raf(2); T.commit(); await T.raf(2);`);
  await step("油漆桶", `T.clickBtn('油漆桶'); await T.raf(2); const r=[...document.querySelectorAll('button')].find(b=>b.style.backgroundColor==='rgb(250, 81, 81)'); r&&T.click(r); await T.raf(2); T.canvasClick(0.5,0.25); await T.raf(2);`);
  await step("文本", `T.clickBtn('文本'); await T.raf(2); T.canvasClick(0.65,0.15); await T.raf(3); const t=document.querySelector('textarea'); T.setInput(t,'你好 Hello'); await T.raf(2); T.commit(); await T.raf(2);`);
  await step("椭圆", `T.clickBtn('椭圆'); await T.raf(2); await T.drag([0.1,0.5],[0.3,0.8]); await T.raf(2); T.commit(); await T.raf(2);`);
  await step("箭头", `T.clickBtn('箭头'); await T.raf(2); await T.drag([0.4,0.6],[0.6,0.8]); await T.raf(2); T.commit(); await T.raf(2);`);
  await step("五角星", `T.clickBtn('五角星'); await T.raf(2); await T.drag([0.7,0.5],[0.9,0.8]); await T.raf(2); T.commit(); await T.raf(2);`);
  await step("框选移动", `T.clickBtn('选择 / 框选'); await T.raf(2); await T.drag([0.05,0.05],[0.37,0.35]); await T.raf(3); const o=document.querySelector('[data-selection-overlay]'); if(!o) throw new Error('no overlay'); const r=o.getBoundingClientRect(); T.fire(o,'mousedown',r.left+20,r.top+20); await T.raf(2); window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+60,clientY:r.top+260,bubbles:true,buttons:1})); await T.raf(2); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); await T.raf(2); T.commit(); await T.raf(2);`);
  await step("撤销框选", `T.clickBtn('撤销'); await T.raf(2);`);
  await step("重做框选", `T.clickBtn('重做'); await T.raf(2);`);
  await step("点选删除五角星", `T.clickBtn('选择 / 框选'); await T.raf(2); const c=T.cv(); const [x,y]=T.pt(0.8,0.503); T.fire(c,'mousemove',x,y,{buttons:0}); await T.raf(2); T.fire(c,'mousedown',x,y); T.fire(c,'mouseup',x,y); await T.raf(4); const b=[...document.querySelectorAll('button')].find(b=>b.title==='删除该元素'); if(b){T.click(b);} await T.raf(3);`);
  await step("框选后点 × 删除内容", `T.clickBtn('选择 / 框选'); await T.raf(2); await T.drag([0.42,0.12],[0.58,0.38]); await T.raf(3); T.click([...document.querySelectorAll('button')].find(b=>b.title==='删除框选内容')); await T.raf(3);`);
  await step("撤销 × 删除", `T.clickBtn('撤销'); await T.raf(2);`);
  await step("框选后取消（键盘撤销）", `T.clickBtn('选择 / 框选'); await T.raf(2); await T.drag([0.1,0.5],[0.3,0.8]); await T.raf(3); T.btn('撤销').click(); await T.raf(3);`);
  await step("橡皮擦", `T.clickBtn('橡皮擦'); await T.raf(2); await T.stroke([[0.5,0.1],[0.5,0.2],[0.5,0.3]]);`);
  await step("喷枪", `T.clickBtn('画笔'); await T.raf(3); const bt=document.querySelector('[data-brush-trigger]'); if(bt){T.click(bt); await T.raf(3); T.clickBtn('喷枪'); await T.raf(2);} await T.stroke([[0.1,0.9],[0.2,0.85],[0.3,0.95]]);`);
  await step("蜡笔", `T.clickBtn('画笔'); await T.raf(3); const bt=document.querySelector('[data-brush-trigger]'); if(!bt){T.clickBtn('画笔'); await T.raf(3);} const b2=document.querySelector('[data-brush-trigger]'); if(b2){T.click(b2); await T.raf(3); T.clickBtn('蜡笔'); await T.raf(2);} await T.stroke([[0.4,0.9],[0.5,0.85],[0.6,0.95]]);`);
  await step("水彩", `T.clickBtn('画笔'); await T.raf(3); const bt=document.querySelector('[data-brush-trigger]'); if(!bt){T.clickBtn('画笔'); await T.raf(3);} const b2=document.querySelector('[data-brush-trigger]'); if(b2){T.click(b2); await T.raf(3); T.clickBtn('水彩'); await T.raf(2);} await T.stroke([[0.7,0.9],[0.8,0.85],[0.9,0.95]]);`);
  const p3 = await br.newPage();
  await joinViaUrl(p3, code, ORIGIN, "后来者");
  let r = await sameOff([p1, p2, p3]);
  ok("后来者（全量重放）和两端完全一致", r.same, r.hashes);
  // 一路撤销到底再重做回来
  const steps = await p1.eval(`(async()=>{let n=0;while(n<40&&!T.btn('撤销').disabled&&!T.btn('撤销').className.includes('pointer-events-none')){T.btn('撤销').click();n++;await T.raf(2);await new Promise(r=>setTimeout(r,30));}return n;})()`);
  ok("撤销了多步", steps >= 10, steps);
  r = await sameOff([p1, p2]);
  ok("撤销到底后两端一致", r.same, r.hashes);
  const ink = await p1.eval("T.offInk()");
  ok("撤销到底后是白板", ink === 0, ink);
  await p1.eval(`(async()=>{for(let i=0;i<${steps};i++){T.btn('重做').click();await T.raf(2);await new Promise(r=>setTimeout(r,30));}})()`);
  r = await sameOff([p1, p2, p3]);
  ok("重做回来后三端一致", r.same, r.hashes);
  const p4 = await br.newPage();
  await joinViaUrl(p4, code, ORIGIN, "再来一个");
  r = await sameOff([p1, p4]);
  ok("再来一个后来者也一致", r.same, r.hashes);
  ok("没有异常", p1.exceptions.length + p2.exceptions.length + p3.exceptions.length === 0, [p1.exceptions, p2.exceptions, p3.exceptions]);
  await closeAll(br, p1, p2, p3, p4);
};

G.R4_undo_chain = async ({ br }) => {
  console.log("\n=== R4 连续撤销 60 次填充：每一步都不卡");
  const code = await createRoom(3);
  const d = new NodeClient(code);
  await d.join("画手");
  await paintGrid(d, 60);
  await sleep(300);
  const p = await br.newPage();
  await joinViaUrl(p, code, ORIGIN, "观众");
  await sleep(2500);
  await p.eval("__long.length = 0");
  for (let i = 0; i < 100; i++) {
    d.send({ type: "undo" });
    await sleep(40);
  }
  await sleep(800);
  const long = await longTasks(p);
  ok("连续撤销 100 笔没有超过 150ms 的长任务", Math.max(0, ...long) < 150, long.slice(0, 12));
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "后来者");
  const r = await sameOff([p, p2]);
  ok("结果和全量重放一致", r.same, r.hashes);
  d.kill();
  await closeAll(br, p, p2);
};

G.R5_ops_during_slices = async ({ br }) => {
  console.log("\n=== R5 分片重放途中到达的操作：顺序不乱");
  const code = await createRoom(4);
  const d = new NodeClient(code);
  await d.join("画手");
  const live = await br.newPage();
  await joinViaUrl(live, code, ORIGIN, "实时观众");
  await sleep(300);
  await paintGrid(d, 60, { crayon: true });
  await sleep(1500);
  const p = await br.newPage();
  await p.goto(`${ORIGIN}/${code}`);
  await p.waitText("进入房间", 5000);
  await p.eval(`T.clickBtn('进入房间')`);
  // 加入和重放期间持续发各种操作
  for (let i = 0; i < 12; i++) {
    const x = 0.1 + i * 0.06;
    d.send({ type: "shape", shape: "ellipse", filled: false, x, y: 0.2, width: 0.05, height: 0.05, color: "#00aa00", lineWidth: 3 });
    d.send({ type: "fill", x: x + 0.025, y: 0.225, color: "#ffee00", tolerance: 32 });
    if (i % 3 === 0) {
      d.send({ type: "undo" });
    }
    if (i % 3 === 1) {
      d.send({ type: "undo" });
      d.send({ type: "redo" });
    }
    if (i % 4 === 0) {
      d.send({ type: "textStroke", text: "字" + i, x, y: 0.5, color: "#000000", fontSize: 24 });
    }
    d.send({ type: "selection", srcX: x, srcY: 0.2, w: 0.05, h: 0.05, dstX: x, dstY: 0.65 });
    await sleep(40);
  }
  const r = await sameOff([live, p]);
  ok("结果和实时观众完全一致", r.same, r.hashes);
  ok("没有异常", p.exceptions.length === 0, p.exceptions);
  const late = await br.newPage();
  await joinViaUrl(late, code, ORIGIN, "后来者");
  const r2 = await sameOff([live, late]);
  ok("和之后的全量重放也一致", r2.same, r2.hashes);
  d.kill();
  await closeAll(br, live, p, late);
};

G.R6_clear_during_slices = async ({ br }) => {
  console.log("\n=== R6 分片重放途中清空：不残留");
  const code = await createRoom(3);
  const d = new NodeClient(code);
  await d.join("画手");
  await paintGrid(d, 60, { crayon: true });
  await sleep(1500);
  const p = await br.newPage();
  await p.goto(`${ORIGIN}/${code}`);
  await p.waitText("进入房间", 5000);
  await p.eval(`T.clickBtn('进入房间')`);
  await until(() => p.eval(`!!document.querySelector('canvas')`), 5000, 20);
  await sleep(120);
  d.send({ type: "clear" });
  d.send({ type: "shape", shape: "rect", filled: true, x: 0.4, y: 0.4, width: 0.1, height: 0.1, color: "#0000ff", lineWidth: 0 });
  await sleep(2000);
  const blue = await p.eval(`(()=>{const c=T.off();const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let blue=0,other=0;for(let i=0;i<d.length;i+=4){if(d[i]<40&&d[i+1]<40&&d[i+2]>200)blue++;else if(d[i]<240||d[i+1]<240||d[i+2]<240)other++;}return {blue,other};})()`);
  ok("清空之前的笔画没有残留", blue.other < 2000, blue);
  ok("清空之后的笔画还在", blue.blue > 10000, blue);
  d.kill();
  await closeAll(br, p);
};

G.R7_selection_right_after_reconnect = async ({ br, proxy }) => {
  console.log("\n=== R7 画手重连后马上框选：不会截到没画完的画面");
  const { p1, code } = await createInBrowser(br, "画手甲", 3);
  const viewer = await br.newPage();
  await joinViaUrl(viewer, code, ORIGIN, "观众");
  await sleep(300);
  await p1.eval(`(async()=>{T.clickBtn('矩形');await T.raf(2);for(let i=0;i<8;i++){await T.drag([0.03+i*0.12,0.1],[0.12+i*0.12,0.6]);await T.raf(2);T.commit();await T.raf(2);}T.clickBtn('油漆桶');await T.raf(2);const r=[...document.querySelectorAll('button')].find(b=>b.style.backgroundColor==='rgb(250, 81, 81)');r&&T.click(r);await T.raf(2);for(let i=0;i<8;i++){T.canvasClick(0.075+i*0.12,0.3);await T.raf(2);}})()`);
  await sleep(500);
  // 让重放慢下来：每次读像素都卡一下，保证框选发生在分片窗口内
  await p1.eval(`(()=>{const P=CanvasRenderingContext2D.prototype;const o=P.getImageData;window.__gid=o;P.getImageData=function(...a){const t=performance.now();while(performance.now()-t<120){}return o.apply(this,a);};})()`);
  proxy.killAll();
  await until(() => p1.eval(`T.text().includes('正在重连')`), 3000, 20);
  await reconnected(p1);
  // 刚连上就拖框选并移动
  await p1.eval(`(async()=>{T.clickBtn('选择 / 框选');await T.raf(1);await T.drag([0.02,0.05],[0.5,0.7]);await T.raf(2);const o=document.querySelector('[data-selection-overlay]');if(!o)throw new Error('no overlay');const r=o.getBoundingClientRect();T.fire(o,'mousedown',r.left+20,r.top+20);await T.raf(2);window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+30,clientY:r.top+120,bubbles:true,buttons:1}));await T.raf(2);window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await T.raf(2);T.commit();await T.raf(2);})()`);
  await reconnected(viewer);
  await sleep(300);
  await p1.eval(`(()=>{CanvasRenderingContext2D.prototype.getImageData=window.__gid;})()`).catch(() => {});
  const r = await sameOff([p1, viewer], 20000);
  ok("框选提交后两端一致", r.same, r.hashes);
  await closeAll(br, p1, viewer);
};

G.R8_reconnect_no_flash = async ({ br, proxy }) => {
  console.log("\n=== R8 重连后分片重放：可见画布不会闪成半成品");
  const code = await createRoom(3);
  const d = new NodeClient(code);
  await d.join("画手");
  await paintGrid(d, 60, { crayon: true });
  await sleep(1200);
  const p = await br.newPage();
  await joinViaUrl(p, code, ORIGIN, "观众");
  await sleep(3000);
  const full = await p.eval("T.ink()");
  ok("画面画完了", full > 50000, full);
  // 记录重连期间每一帧的墨量（只采样缩小后的画面，避免采样本身拖慢页面）
  await p.eval(`(()=>{window.__inks=[];const t=document.createElement('canvas');t.width=160;t.height=96;const x=t.getContext('2d',{willReadFrequently:true});const loop=()=>{x.drawImage(T.cv(),0,0,160,96);const d=x.getImageData(0,0,160,96).data;let n=0;for(let i=0;i<d.length;i+=4){if(d[i+3]>10&&(d[i]<240||d[i+1]<240||d[i+2]<240))n++;}window.__inks.push(n);window.__inkRaf=requestAnimationFrame(loop);};loop();})()`);
  await sleep(300);
  // 重连窗口内持续有新笔画到达，每一笔都会同步一次可见画布
  const feeder = setInterval(() => {
    d.send({ type: "shape", shape: "rect", filled: true, x: 0.98, y: 0.98, width: 0.01, height: 0.01, color: "#00aa00", lineWidth: 0 });
  }, 25);
  proxy.killAll();
  await sleep(200);
  await reconnected(p);
  await sleep(2500);
  clearInterval(feeder);
  const inks = await p.eval(`(()=>{cancelAnimationFrame(window.__inkRaf);return window.__inks;})()`);
  const max = Math.max(...inks);
  const min = Math.min(...inks);
  ok("采样到了足够多的帧", inks.length > 10, inks.length);
  ok("每一帧都是完整的画面", min > max * 0.98, { min, max, frames: inks.length });
  d.kill();
  await closeAll(br, p);
};

G.L1_live_exact = async ({ br }) => {
  console.log("\n=== L1 进行中的笔画：增量画出来的和整条重画逐像素一致");
  for (const brush of ["pen", "airbrush", "crayon", "watercolor"]) {
    const code = await createRoom(4);
    const d = new NodeClient(code);
    await d.join("画手");
    d.send({ type: "shape", shape: "rect", filled: true, x: 0.3, y: 0.3, width: 0.3, height: 0.3, color: "#ffcc00", lineWidth: 0 });
    const pNew = await br.newPage();
    await joinViaUrl(pNew, code, ORIGIN, "新版");
    const pOld = await br.newPage();
    await joinViaUrl(pOld, code, OLD_ORIGIN, "对照");
    await sleep(500);
    startLive(d, brush);
    let n = 0;
    for (const size of [1, 2, 5, 30, 100, 300]) {
      moveLive(d, livePoints(n, n + size));
      n += size;
      await sleep(60);
    }
    await sleep(400);
    const [a, b] = await Promise.all([pNew.eval("T.visHash()"), pOld.eval("T.visHash()")]);
    ok(`${brush}：和整条重画一致`, a === b, { a, b });
    const ink = await pNew.eval("T.ink()");
    ok(`${brush}：画出来了`, ink > 1000, ink);
    d.kill();
    await closeAll(br, pNew, pOld);
  }
};

G.L2_live_load = async ({ br }) => {
  console.log("\n=== L2 长笔画的观战端负载（4000 点，60 条/秒）");
  for (const brush of ["airbrush", "crayon"]) {
    const code = await createRoom(2);
    const d = new NodeClient(code);
    await d.join("画手");
    const p = await br.newPage();
    await joinViaUrl(p, code, ORIGIN, "观众");
    await sleep(500);
    startLive(d, brush);
    let n = 0;
    while (n < 4000) {
      moveLive(d, livePoints(n, n + 50));
      n += 50;
      await sleep(12);
    }
    await sleep(800);
    const ms = await load(p, async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        moveLive(d, livePoints(n, n + 1));
        n++;
        await sleep(16);
      }
    });
    ok(`${brush}：主线程占用低于 200 ms/s`, ms < 200, ms);
    d.kill();
    await closeAll(br, p);
  }
};

G.L3_flood = async ({ br }) => {
  console.log("\n=== L3 高频 move：一帧最多重绘一次");
  for (const brush of ["pen", "watercolor", "crayon"]) {
    const code = await createRoom(2);
    const d = new NodeClient(code);
    await d.join("画手");
    const p = await br.newPage();
    await joinViaUrl(p, code, ORIGIN, "观众");
    await sleep(500);
    startLive(d, brush);
    let n = 0;
    while (n < 8000) {
      moveLive(d, livePoints(n, n + 200));
      n += 200;
      await sleep(5);
    }
    await sleep(1000);
    await p.eval(`(()=>{window.__drawCalls=0;const P=CanvasRenderingContext2D.prototype;for(const k of ['stroke','fillRect','drawImage']){const o=P[k];P[k]=function(...a){window.__drawCalls++;return o.apply(this,a);};}})()`);
    const ms = await load(p, async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        for (let i = 0; i < 6; i++) {
          moveLive(d, livePoints(n, n + 1));
          n++;
        }
        await sleep(20);
      }
    });
    console.log(`      ${brush}: ${ms} ms/s, 画布调用 ${await p.eval("__drawCalls")}`);
    // 绝对耗时只在本机断言：CI 的共享机器没有 GPU，整条重画要慢十倍左右（本机 70~100 ms/s，CI 774 / 857）。
    // 机器快慢无关的那部分由下面“一口气到达”的重绘次数盯着。蜡笔是增量渲染，每条线段按不按帧合并都只画一次，
    // 合并与否看不出差别，它的负载由 L2 盯着。
    if (process.env.GITHUB_ACTIONS) {
      console.log(`      （CI 上只记录主线程占用，不断言）`);
    } else {
      ok(`${brush}：300 条/秒下主线程占用低于 500 ms/s`, ms < 500, ms);
    }
    if (brush !== "crayon") {
      // 2.5 秒最多约 150 帧，每帧 drawImage + stroke（水彩两次 stroke）
      const calls = await p.eval("__drawCalls");
      ok(`${brush}：一帧最多重绘一次`, calls < 600, calls);
      // 慢机器上每次重绘本身就超过一帧，按消息重绘和按帧重绘的调用数会趋同，上面那条就抓不住了。
      // 在同一个任务里塞给页面 60 条 move（不经过服务端，到达时间不受机器快慢影响）：
      // 按帧合并只重绘一次（两三个画布调用），按消息重绘是 60 次。
      await p.eval("window.__drawCalls = 0");
      await p.eval(
        `(()=>{const ws=__ws.instances.at(-1);for(let i=0;i<60;i++){ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'draw',action:'move',x:0.5,y:0.5,color:'#3366cc',lineWidth:8,points:[{x:0.2+i*0.005,y:0.5}]})}));}})()`,
      );
      await sleep(300);
      const burst = await p.eval("__drawCalls");
      // 下限也要有：一次都没重绘（比如消息没进到这一笔）也不能算过
      ok(`${brush}：同一个任务里到达的 60 条 move 只重绘一次`, burst >= 2 && burst <= 6, burst);
    }
    d.kill();
    await closeAll(br, p);
  }
};

G.L4_local_live = async ({ br }) => {
  console.log("\n=== L4 画手本地：喷枪按住不动，浓度随时间累积，松手后两端一致");
  const { p1, code } = await createInBrowser(br);
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  await sleep(300);
  await p1.eval(`(async()=>{T.clickBtn('画笔');await T.raf(3);const bt=document.querySelector('[data-brush-trigger]');if(bt){T.click(bt);await T.raf(3);T.clickBtn('喷枪');await T.raf(2);}T.commit();await T.raf(2);})()`);
  await p1.eval(`(()=>{const [a,b]=T.pt(0.5,0.5);T.fire(T.cv(),'mousedown',a,b);})()`);
  await p1.eval(`(async()=>{const [a,b]=T.pt(0.52,0.5);T.fire(T.cv(),'mousemove',a,b);await T.raf(2);})()`);
  await sleep(300);
  const i1 = await p1.eval("T.ink()");
  await sleep(1500);
  const i2 = await p1.eval("T.ink()");
  ok("按住不动时墨量继续增加", i2 > i1 && i1 > 0, { i1, i2 });
  await p1.eval(`(async()=>{const [a,b]=T.pt(0.52,0.5);T.fire(T.cv(),'mouseup',a,b);await T.raf(2);})()`);
  await sleep(300);
  const r = await sameOff([p1, p2]);
  ok("松手后两端一致", r.same, r.hashes);
  const [v1, v2] = await Promise.all([p1.eval("T.ink()"), p2.eval("T.ink()")]);
  ok("可见画布墨量接近", Math.abs(v1 - v2) <= Math.max(v1, v2) * 0.02, { v1, v2 });
  await closeAll(br, p1, p2);
};

G.L5_resize_midstroke = async ({ br }) => {
  console.log("\n=== L5 笔画进行中窗口缩放：进行中的笔画不丢");
  const code = await createRoom(2);
  const d = new NodeClient(code);
  await d.join("画手");
  const p = await br.newPage();
  await joinViaUrl(p, code, ORIGIN, "观众");
  await sleep(500);
  startLive(d, "crayon");
  moveLive(d, livePoints(0, 200));
  await sleep(300);
  const i0 = await p.eval("T.ink()");
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const i1 = await p.eval("T.ink()");
  ok("缩放后进行中的笔画还在", i0 > 1000 && i1 > i0 * 0.5, { i0, i1 });
  moveLive(d, livePoints(200, 260));
  await sleep(200);
  const i2 = await p.eval("T.ink()");
  ok("继续画没有重复叠加出错", i2 >= i1, { i1, i2 });
  const last = livePoints(259, 260)[0];
  d.send({ type: "draw", action: "end", x: last.x, y: last.y, color: "#3366cc", lineWidth: 8 });
  await sleep(300);
  const i3 = await p.eval("T.ink()");
  ok("结束后画面还在", i3 > 1000, i3);
  d.kill();
  await closeAll(br, p);
};

G.L6_end_same_frame = async ({ br }) => {
  console.log("\n=== L6 move 和 end 落在同一帧：不留下多余的进行中笔画");
  const code = await createRoom(3);
  const d = new NodeClient(code);
  await d.join("画手");
  const a = await br.newPage();
  await joinViaUrl(a, code, ORIGIN, "甲");
  const b = await br.newPage();
  await joinViaUrl(b, code, ORIGIN, "乙");
  await sleep(500);
  for (let i = 0; i < 5; i++) {
    startLive(d, "airbrush", "#cc3366");
    const pts = livePoints(i * 100, i * 100 + 80);
    moveLive(d, pts, "#cc3366");
    const last = pts[pts.length - 1];
    d.send({ type: "draw", action: "end", x: last.x, y: last.y, color: "#cc3366", lineWidth: 8, stroke: { points: pts, color: "#cc3366", lineWidth: 8, brushType: "airbrush" } });
  }
  await sleep(500);
  const r = await sameOff([a, b]);
  ok("两个观众离屏一致", r.same, r.hashes);
  const [va, vb] = await Promise.all([a.eval("T.visHash()"), b.eval("T.visHash()")]);
  ok("两个观众可见画布一致", va === vb, { va, vb });
  // 可见画布 = 离屏缩放后的结果：再缩放一次比较
  const same = await a.eval(`(()=>{const c=T.cv();const t=document.createElement('canvas');t.width=c.width;t.height=c.height;const x=t.getContext('2d');x.drawImage(T.off(),0,0,c.width,c.height);return T.hashOf(t)===T.hashOf(c);})()`);
  ok("可见画布就是离屏的内容，没有残留", same);
  d.kill();
  await closeAll(br, a, b);
};

Object.assign(G, loadGroups({ ok, closeAll, sameOff, paintGrid, scratch, buildDir: BUILD }));
Object.assign(G, require("./browser-batch3-review.cjs").loadReviewGroups({ ok, closeAll, sameOff, createInBrowser, paintGrid }));

(async () => {
  const filter = new RegExp(process.argv[2] || ".");
  const servers = [await serveStatic(path.join(scratch, process.env.BUILD_DIR || "build-local"), 4173), await serveStatic(path.join(scratch, "build-full-redraw"), 4175)];
  const proxy = new Proxy();
  await proxy.start();
  const br = await new Browser().start(scratch);
  // 所有页面的字体 CDN 都走本地响应，不依赖真实 CDN
  const rawNewPage = br.newPage.bind(br);
  br.newPage = async () => {
    const page = await rawNewPage();
    await mockFonts(page);
    return page;
  };
  console.log("浏览器:", br.version, " 被测:", process.env.BUILD_DIR || "build-local");
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
    proxy.stall = false;
    proxy.delay = 0;
    proxy.delayDown = 0;
  }
  console.log(`\n合计: ${pass} 通过, ${fail} 失败`);
  await br.stop();
  proxy.stop();
  servers.forEach((s) => s.close());
  process.exit(fail);
})().catch((e) => {
  console.log("致命错误", e);
  process.exit(100);
});
