// ---------- 第三批：独立审查发现的问题 ----------
// 这段被 browser-batch3.cjs 引入。重放分片期间的显示、框选竞态、出错时保住席位、刷新后保留昵称。
const { sleep, NodeClient, createRoom, joinViaUrl, ORIGIN } = require("./harness.cjs");

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
const reconnected = async (p, ms = 20000) => until(async () => !(await p.eval(`T.text().includes('正在重连')`)), ms);
// 每次读像素都卡一下：油漆桶重放变慢，重连后的分片重放会持续好几秒
const slowFills = (p, ms = 150) =>
  p.eval(`(()=>{const P=CanvasRenderingContext2D.prototype;if(window.__gid)return;const o=P.getImageData;window.__gid=o;P.getImageData=function(...a){const t=performance.now();while(performance.now()-t<${ms}){}return o.apply(this,a);};})()`);
const fastFills = (p) => p.eval(`(()=>{if(window.__gid){CanvasRenderingContext2D.prototype.getImageData=window.__gid;delete window.__gid;}})()`);
// 可见画布的低分辨率墨量（采样本身要便宜）
const SMALL_INK = `(()=>{const t=document.createElement('canvas');t.width=160;t.height=96;const x=t.getContext('2d',{willReadFrequently:true});x.drawImage(T.cv(),0,0,160,96);const d=x.getImageData(0,0,160,96).data;let n=0;for(let i=0;i<d.length;i+=4){if(d[i+3]>10&&(d[i]<240||d[i+1]<240||d[i+2]<240))n++;}return n;})()`;
const regionInk = (x0, y0, x1, y1) =>
  `(()=>{const c=T.cv();const X=Math.floor(${x0}*c.width),Y=Math.floor(${y0}*c.height),W=Math.max(1,Math.floor((${x1}-${x0})*c.width)),H=Math.max(1,Math.floor((${y1}-${y0})*c.height));const d=c.getContext('2d').getImageData(X,Y,W,H).data;let n=0;for(let i=0;i<d.length;i+=4){if(d[i+3]>10&&(d[i]<200||d[i+1]<200||d[i+2]<200))n++;}return n;})()`;
// 区域内颜色的深度总和：同一笔被反复叠画时会明显变深
const regionDark = (x0, y0, x1, y1) =>
  `(()=>{const c=T.cv();const X=Math.floor(${x0}*c.width),Y=Math.floor(${y0}*c.height),W=Math.max(1,Math.floor((${x1}-${x0})*c.width)),H=Math.max(1,Math.floor((${y1}-${y0})*c.height));const d=(window.__gid||CanvasRenderingContext2D.prototype.getImageData).call(c.getContext('2d'),X,Y,W,H).data;let n=0;for(let i=0;i<d.length;i+=4){n+=255-Math.min(d[i],d[i+1],d[i+2]);}return n;})()`;
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
// 页面上的画手画一幅油漆桶多的画
const paintFills = (p) =>
  p.eval(`(async()=>{T.clickBtn('矩形');await T.raf(2);for(let i=0;i<8;i++){await T.drag([0.03+i*0.12,0.1],[0.12+i*0.12,0.6]);await T.raf(2);T.commit();await T.raf(2);}T.clickBtn('油漆桶');await T.raf(2);const r=[...document.querySelectorAll('button')].find(b=>b.style.backgroundColor==='rgb(250, 81, 81)');r&&T.click(r);await T.raf(2);for(let i=0;i<8;i++){T.canvasClick(0.075+i*0.12,0.3);await T.raf(2);}})()`);

function loadReviewGroups({ ok, closeAll, sameOff, createInBrowser, paintGrid }) {
  const G = {};

  G.V1_selection_commit_after_roomstate = async ({ br, proxy }) => {
    console.log("\n=== V1 框选悬浮时重连：roomState 刚处理完就点外面，不能提交出重影");
    const { p1, code } = await createInBrowser(br, "画手甲", 3);
    const p2 = await br.newPage();
    await joinViaUrl(p2, code, ORIGIN, "猜手乙");
    await sleep(300);
    await p1.eval(`(async()=>{T.clickBtn('矩形');await T.raf(2);const b=[...document.querySelectorAll('button')].find(b=>b.title==='填充');b&&T.click(b);await T.raf(2);await T.drag([0.1,0.1],[0.3,0.4]);await T.raf(2);T.commit();await T.raf(2);})()`);
    await sleep(300);
    await p1.eval(`(async()=>{T.clickBtn('选择 / 框选');await T.raf(2);await T.drag([0.05,0.05],[0.35,0.45]);await T.raf(3);const o=document.querySelector('[data-selection-overlay]');const r=o.getBoundingClientRect();T.fire(o,'mousedown',r.left+20,r.top+20);await T.raf(2);window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+260,clientY:r.top+60,bubbles:true,buttons:1}));await T.raf(2);window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await T.raf(2);})()`);
    ok("框选悬浮且移动了", await p1.eval(`!!document.querySelector('[data-selection-overlay]')`));
    // roomState 处理完的同一个任务里点画布外面：React 还没来得及卸掉旧的监听
    await interceptMessages(
      p1,
      `(ws, e, fn) => { fn(e); if (JSON.parse(e.data).type === 'roomState') { T.fire(document.body, 'mousedown', 2, 2); T.fire(document.body, 'mouseup', 2, 2); } }`,
    );
    proxy.killAll();
    await until(() => p1.eval(`T.text().includes('正在重连')`), 3000, 20);
    await reconnected(p1);
    await reconnected(p2);
    await sleep(800);
    const r = await sameOff([p1, p2]);
    ok("画手和观众一致（没有本地重影）", r.same, r.hashes);
    await closeAll(br, p1, p2);
  };

  G.V2_commit_during_replay = async ({ br, proxy }) => {
    console.log("\n=== V2 重放分片期间提交形状：马上看得到，不会消失到重放结束");
    const { p1, code } = await createInBrowser(br, "画手甲", 3);
    const p2 = await br.newPage();
    await joinViaUrl(p2, code, ORIGIN, "猜手乙");
    await sleep(300);
    await paintFills(p1);
    await sleep(500);
    // 画一个矩形，留在编辑态不提交
    await p1.eval(`(async()=>{T.clickBtn('矩形');await T.raf(2);await T.drag([0.4,0.7],[0.6,0.9]);await T.raf(3);})()`);
    ok("矩形在编辑态", await p1.eval(`!!document.querySelector('[data-shape-overlay]')`));
    await slowFills(p1);
    proxy.killAll();
    await until(() => p1.eval(`T.text().includes('正在重连')`), 3000, 20);
    await reconnected(p1);
    const inkBefore = await p1.eval(regionInk(0.38, 0.68, 0.62, 0.92));
    await p1.eval(`(async()=>{T.commit();await T.raf(2);})()`);
    const inkAfter = await p1.eval(regionInk(0.38, 0.68, 0.62, 0.92));
    const stillPending = await p1.eval(`!!window.__gid`);
    ok("提交后矩形马上画出来了", inkAfter > inkBefore + 200, { inkBefore, inkAfter, stillPending });
    await fastFills(p1);
    await sleep(500);
    const r = await sameOff([p1, p2], 20000);
    ok("之后两端一致", r.same, r.hashes);
    await closeAll(br, p1, p2);
  };

  G.V3_live_during_replay = async ({ br, proxy }) => {
    console.log("\n=== V3 重放分片期间对端在画水彩：进行中的笔画不会越叠越浓");
    const code = await createRoom(3);
    const d = new NodeClient(code);
    await d.join("画手");
    await paintGrid(d, 30);
    await sleep(800);
    const p = await br.newPage();
    await joinViaUrl(p, code, ORIGIN, "观众");
    await sleep(2500);
    await slowFills(p, 120);
    proxy.killAll();
    await until(() => p.eval(`T.text().includes('正在重连')`), 3000, 20);
    await reconnected(p);
    // 重放进行中：对端开始画一笔水彩（只在左下角，不和格子重叠太多）
    const pts = [];
    for (let i = 0; i < 40; i++) {
      pts.push({ x: 0.05 + i * 0.01, y: 0.95 });
    }
    d.send({ type: "draw", action: "start", x: pts[0].x, y: pts[0].y, color: "#3366cc", lineWidth: 8, brushType: "watercolor" });
    const samples = [];
    for (let k = 0; k < 8; k++) {
      d.send({ type: "draw", action: "move", x: pts[k * 5].x, y: 0.95, color: "#3366cc", lineWidth: 8, points: pts.slice(k * 5, k * 5 + 5) });
      await sleep(120);
      samples.push(await p.eval(regionDark(0.0, 0.9, 0.5, 1.0)));
    }
    await fastFills(p);
    await sleep(1500);
    d.send({ type: "draw", action: "move", x: 0.45, y: 0.95, color: "#3366cc", lineWidth: 8, points: [pts[39]] });
    await sleep(300);
    const settled = await p.eval(regionDark(0.0, 0.9, 0.5, 1.0));
    ok("重放期间进行中的笔画没有叠加变粗", Math.max(...samples) <= settled * 1.15, { samples, settled });
    d.kill();
    await closeAll(br, p);
  };

  G.V4_drag_during_replay = async ({ br, proxy }) => {
    console.log("\n=== V4 重放分片期间拖形状、拖框选：画面不闪成半成品");
    const { p1, code } = await createInBrowser(br, "画手甲", 3);
    const p2 = await br.newPage();
    await joinViaUrl(p2, code, ORIGIN, "猜手乙");
    await sleep(300);
    await paintFills(p1);
    await sleep(500);
    const full = await p1.eval(SMALL_INK);
    await slowFills(p1);
    proxy.killAll();
    await until(() => p1.eval(`T.text().includes('正在重连')`), 3000, 20);
    await reconnected(p1);
    await p1.eval(`(async()=>{T.clickBtn('矩形');await T.raf(1);})()`);
    const inks = await p1.eval(`(async()=>{const c=T.cv();const [x0,y0]=T.pt(0.45,0.7);T.fire(c,'mousedown',x0,y0);const out=[];for(let i=1;i<=8;i++){const [x,y]=T.pt(0.45+i*0.02,0.7+i*0.02);T.fire(c,'mousemove',x,y);await T.raf();out.push(${SMALL_INK});}const [x,y]=T.pt(0.61,0.86);T.fire(c,'mouseup',x,y);await T.raf();out.push(${SMALL_INK});return out;})()`);
    ok("拖动形状时每一帧都是完整的画面", Math.min(...inks) >= full * 0.95, { full, inks });
    await p1.eval(`(async()=>{T.commit();await T.raf(2);})()`);
    await fastFills(p1);
    await sleep(500);
    const r = await sameOff([p1, p2], 20000);
    ok("之后两端一致", r.same, r.hashes);
    await closeAll(br, p1, p2);
  };

  G.V5_live_survives_stylesheet = async ({ br }) => {
    console.log("\n=== V5 按住笔不动时字体样式表到了：进行中的笔画不消失");
    const p1 = await br.newPage();
    p1.fontState.delayMs = 4500;
    await p1.goto(ORIGIN + "/");
    await p1.eval(`T.clickBtn('创建房间')`);
    await sleep(100);
    await p1.eval(`T.typeInto('input[type=text]', '画手甲')`);
    await p1.eval(`T.clickBtn('确认创建')`);
    await p1.waitText("房间号", 6000);
    await sleep(200);
    const created = Date.now();
    await p1.eval(`(async()=>{const c=T.cv();const [a,b]=T.pt(0.2,0.5);T.fire(c,'mousedown',a,b);for(let i=1;i<=10;i++){const [x,y]=T.pt(0.2+i*0.03,0.5);T.fire(c,'mousemove',x,y);await T.raf();}})()`);
    await sleep(200);
    const before = await p1.eval(regionInk(0.15, 0.4, 0.6, 0.6));
    const sheetLoaded = await until(() => p1.eval(`[...document.styleSheets].some(s=>(s.href||'').includes('hand.css'))`), 9000, 100);
    await sleep(500);
    const after = await p1.eval(regionInk(0.15, 0.4, 0.6, 0.6));
    ok("样式表在按住期间到达", sheetLoaded && Date.now() - created > 1000, { ms: Date.now() - created });
    ok("进行中的笔画还在", before > 100 && after >= before * 0.9, { before, after });
    await p1.eval(`(()=>{const [x,y]=T.pt(0.5,0.5);T.fire(T.cv(),'mouseup',x,y);})()`);
    await closeAll(br, p1);
  };

  G.V6_crash_keeps_seat = async ({ br }) => {
    console.log("\n=== V6 页面渲染出错：显示提示，席位按断线保留，刷新后还是原来的身份");
    const { p1, code } = await createInBrowser(br, "画手甲", 3);
    const p2 = await br.newPage();
    await joinViaUrl(p2, code, ORIGIN, "猜手乙");
    await sleep(300);
    const myId = await p1.eval(`sessionStorage.getItem('draw-guess-playerId')`);
    // 模拟浏览器翻译插件之类改了 DOM：React 移除节点时抛异常
    await p1.eval(`(()=>{let thrown=false;for(const k of ['appendChild','insertBefore']){const o=Node.prototype[k];Node.prototype[k]=function(...a){if(!thrown&&this instanceof Element&&this.closest('#root')&&a[0] instanceof Element&&document.querySelector('canvas')){thrown=true;throw new Error('模拟的渲染异常');}return o.apply(this,a);};}})()`);
    await p2.eval(`T.chat('你好')`).catch(() => {});
    const shown = await until(() => p1.eval(`T.text().includes('页面出错了')`), 5000);
    ok("显示出错提示", shown, await p1.eval(`T.text().slice(0,80)`));
    await sleep(800);
    const probe = new NodeClient(code);
    const rs = await probe.join("探针");
    const me = (rs?.players || []).find((x) => x.id === myId);
    ok("服务端还留着这个玩家（断线保留期）", !!me, rs?.players);
    ok("还是画手", rs?.drawerId === myId, { drawer: rs?.drawerId, myId });
    probe.send({ type: "leave" });
    await sleep(200);
    probe.kill();
    await p1.goto(`${ORIGIN}/${code}`);
    await p1.waitText("房间号", 8000);
    await sleep(500);
    ok("刷新后还是原来的身份", (await p1.eval(`sessionStorage.getItem('draw-guess-playerId')`)) === myId);
    ok("刷新后还是画手", await p1.eval(`!T.btn('清除').disabled`));
    await closeAll(br, p1, p2);
  };

  return G;
}

module.exports = { loadReviewGroups };
