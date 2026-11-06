// 第四批交互修复的断言式回归（真实客户端：无头浏览器 + 独立 profile）。只访问本机。
// 用法：node browser-batch4.cjs [组名正则]；BUILD_DIR=... 切换被测前端包。
// 依赖：worker-ctl.cjs start、build-client.mjs（run.cjs 会自动处理）。退出码 = 失败条数。
const path = require("path");
const { sleep, serveStatic, Proxy, Browser, NodeClient, createRoom, joinViaUrl, diffSig, ORIGIN } = require("./harness.cjs");

const { TMP: scratch } = require("./env.cjs");

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
async function createInBrowser(br, name = "画手甲", max = 2) {
  const p1 = await br.newPage();
  await p1.goto(ORIGIN + "/");
  await p1.eval(`T.clickBtn('创建房间')`);
  await p1.eval(`T.typeInto('input[type=text]', ${JSON.stringify(name)})`);
  if (max !== 2) {
    await p1.eval(`T.clickBtn('${max}人')`);
    await sleep(50);
  }
  await p1.eval(`T.clickBtn('确认创建')`);
  await p1.waitText("房间号", 8000);
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
async function compare(a, b) {
  const [s1, s2] = await Promise.all([a.eval("T.sig()"), b.eval("T.sig()")]);
  return diffSig(s1, s2);
}
const reconnected = async (p, ms = 15000) => until(async () => !(await p.eval(`T.text().includes('正在重连')`)), ms);
// 这个页面发出去的某类消息有几条（__ws.sent 只留每条的前 70 个字符）
const countSent = (p, type) => p.eval(`__ws.sent.filter((s) => s.startsWith('{"type":"${type}"')).length`);
const inputValue = (p) => p.eval(`document.querySelector('input[type=text]').value`);
// 可见画布某个归一化区域里的墨量
const regionInk = (x0, y0, x1, y1) =>
  `(()=>{const c=T.cv();const X0=Math.floor(c.width*${x0}),Y0=Math.floor(c.height*${y0});const W=Math.max(1,Math.floor(c.width*${x1 - x0})),H=Math.max(1,Math.floor(c.height*${y1 - y0}));const d=c.getContext('2d').getImageData(X0,Y0,W,H).data;let n=0;for(let i=0;i<d.length;i+=4){if(d[i]<240||d[i+1]<240||d[i+2]<240)n++;}return n;})()`;
// 可见画布某个归一化区域的总深浅（墨越浓越大）。喷枪的散点铺满一块之后像素数就不涨了，深浅还会涨
const regionDark = (x0, y0, x1, y1) =>
  `(()=>{const c=T.cv();const X0=Math.floor(c.width*${x0}),Y0=Math.floor(c.height*${y0});const W=Math.max(1,Math.floor(c.width*${x1 - x0})),H=Math.max(1,Math.floor(c.height*${y1 - y0}));const d=c.getContext('2d').getImageData(X0,Y0,W,H).data;let n=0;for(let i=0;i<d.length;i+=4){n+=255-Math.min(d[i],d[i+1],d[i+2]);}return n;})()`;
// 选笔型（可选线宽），最后关掉弹层
const pickBrush = (p, label, width) =>
  p.eval(
    `(async()=>{T.clickBtn('画笔');await T.raf(3);T.click(document.querySelector('[data-brush-trigger]'));await T.raf(3);T.clickBtn('${label}');await T.raf(2);${width ? `T.clickBtn('${width}px');await T.raf(2);` : ""}T.commit();await T.raf(2);})()`,
  );
// 选工具并关掉它的弹层
const pickTool = async (p, title) => {
  await p.eval(`T.clickBtn('${title}')`);
  await sleep(150);
  await p.eval(`T.commit()`);
  await sleep(50);
};

// 截一张画布区域的图（叠在画布上的编辑框也在里面），返回某一行（或某一列）上深色像素的坐标
async function darkOnLine(p, axis, n) {
  const r = await p.eval(`(()=>{const c=T.cv().getBoundingClientRect();return {x:c.left,y:c.top,w:c.width,h:c.height};})()`);
  const shot = await p.send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
  return p.eval(
    `(async()=>{const img=new Image();img.src='data:image/png;base64,${shot.data}';await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);const row='${axis}'==='row';const len=row?img.width:img.height;const at=Math.round((row?img.height:img.width)*${n});const d=row?x.getImageData(0,at,img.width,1).data:x.getImageData(at,0,1,img.height).data;const out=[];for(let i=0;i<len;i++){const k=i*4;if(d[k]<90&&d[k+1]<90&&d[k+2]<90)out.push(i);}return out;})()`,
  );
}
const darkXsOnRow = (p, ny) => darkOnLine(p, "row", ny);
const darkYsOnCol = (p, nx) => darkOnLine(p, "col", nx);
// 一行深色像素里从左数第一段：[起点, 终点]
const firstRun = (xs) => {
  if (xs.length === 0) {
    return null;
  }
  let end = xs[0];
  for (let i = 1; i < xs.length && xs[i] === end + 1; i++) {
    end = xs[i];
  }
  return [xs[0], end];
};
// 从右数第一段
const lastRun = (xs) => {
  if (xs.length === 0) {
    return null;
  }
  let start = xs[xs.length - 1];
  for (let i = xs.length - 2; i >= 0 && xs[i] === start - 1; i--) {
    start = xs[i];
  }
  return [start, xs[xs.length - 1]];
};

const G = {};

// ---------- 输入模式 ----------
G.I1_guesser_default_guess = async ({ br }) => {
  console.log("\n=== I1 猜词阶段猜词方的输入框默认是猜词：直接打答案就是猜，不当聊天发出去");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.mode('确认')`);
  await p1.eval(`T.chat('苹果')`);
  ok("进入猜词阶段", await p2.waitText("猜词中", 3000));
  await sleep(200);
  ok("猜词方的提交按钮是 猜测", await p2.eval(`T.submitIs('猜测')`), await p2.eval(`document.querySelector('input[type=text]').parentElement.innerText`));
  const chats0 = await countSent(p2, "chat");
  await p2.eval(`T.chat('苹果')`);
  ok("发出去的是猜测", await until(async () => (await countSent(p2, "guess")) === 1, 2000), await p2.eval(`__ws.sent.slice(-3)`));
  ok("没有当聊天发", (await countSent(p2, "chat")) === chats0);
  ok("画手看到猜对了", await p1.waitText("已揭晓", 3000));
  await closeAll(br, p1, p2);
};

G.I2_drawer_default_answer = async ({ br }) => {
  console.log("\n=== I2 绘画阶段画手的输入框默认是答案：直接打字就是设答案，不进公开聊天");
  const { p1, p2 } = await pagesInRoom(br);
  ok("画手的提交按钮是 确认", await p1.eval(`T.submitIs('确认')`), await p1.eval(`document.querySelector('input[type=text]').parentElement.innerText`));
  ok("猜词方的提交按钮是 发送", await p2.eval(`T.submitIs('发送')`));
  await p1.eval(`T.chat('苹果')`);
  const entered = await p2.waitText("猜词中", 3000);
  ok("进入猜词阶段", entered);
  ok("答案没进公开聊天", !(await p2.eval(`T.text().includes('苹果')`)), await p2.eval("T.text().slice(0,200)"));
  if (!entered) {
    await closeAll(br, p1, p2);
    return;
  }
  await p2.eval(`T.mode('猜测')`);
  await p2.eval(`T.chat('苹果')`);
  ok("猜对后揭晓", await p1.waitText("已揭晓", 3000));
  await p1.eval(`T.clickBtn('继续出题')`);
  ok("回到绘画阶段", await p1.waitText("绘画中", 3000));
  await sleep(200);
  ok("继续出题后画手又是答案模式", await p1.eval(`T.submitIs('确认')`));
  // 手动切到聊天之后，同一阶段里别被切回去（比如有人进出、重渲染）
  await p1.eval(`T.clickBtn('切换输入模式')`);
  await sleep(150);
  ok("手动切到聊天", await p1.eval(`T.submitIs('发送')`));
  await p1.eval(`T.stroke([[0.2,0.2],[0.4,0.4]])`);
  await sleep(300);
  ok("画了一笔还是聊天模式", await p1.eval(`T.submitIs('发送')`));
  await closeAll(br, p1, p2);
};

G.I5_no_focus_steal = async ({ br }) => {
  console.log("\n=== I5 画手正在画布上打字时第二个人进来（切到答案模式）：焦点不被聊天输入框抢走");
  const { p1, code } = await createInBrowser(br);
  await p1.eval(`T.clickBtn('文本')`);
  await sleep(150);
  await p1.eval(`T.commit()`);
  await sleep(100);
  await p1.eval(`T.canvasClick(0.3,0.3)`);
  await sleep(250);
  ok("画布上开始打字", await p1.eval(`document.activeElement && document.activeElement.tagName === 'TEXTAREA'`));
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  ok("阶段变成绘画中", await p1.waitText("绘画中", 5000));
  await sleep(300);
  ok("画手切到了答案模式", await p1.eval(`T.submitIs('确认')`));
  ok("焦点还在画布的文字框里", await p1.eval(`document.activeElement && document.activeElement.tagName === 'TEXTAREA'`), await p1.eval(`document.activeElement && document.activeElement.tagName`));
  await closeAll(br, p1, p2);
};

G.I6_keep_mode_while_typing = async ({ br }) => {
  console.log("\n=== I6 输入框里有字时阶段变了：不切模式，正在打的聊天不会被当成猜测发出去");
  const { p1, p2 } = await pagesInRoom(br);
  await p2.eval(`T.setInput(document.querySelector('input[type=text]'), '等我一下')`);
  await p1.eval(`T.chat('苹果')`);
  ok("进入猜词阶段", await p2.waitText("猜词中", 3000));
  await sleep(200);
  ok("猜词方还是聊天模式", await p2.eval(`T.submitIs('发送')`));
  ok("打了一半的字还在", (await inputValue(p2)) === "等我一下", await inputValue(p2));
  await p2.eval(`T.enter(document.querySelector('input[type=text]'))`);
  ok("回车按聊天发出去", await until(async () => (await countSent(p2, "chat")) === 1, 2000));
  ok("没有当猜测发", (await countSent(p2, "guess")) === 0);
  await sleep(200);
  // 不能一直停在聊天：这条发出去以后补上推迟的切换，接着打的才是猜测
  ok("这条发出去之后切到猜词模式", await p2.eval(`T.submitIs('猜测')`), await p2.eval(`document.querySelector('input[type=text]').parentElement.innerText`));
  await closeAll(br, p1, p2);
};

G.I7_fallback_drops_answer = async ({ br }) => {
  console.log("\n=== I7 打了一半的答案，答案模式不能用了（对方离开、回到等待）：字丢掉，不会当聊天发出去");
  const { p1, p2, code } = await pagesInRoom(br, 3);
  await p1.eval(`T.mode('确认')`);
  await p1.eval(`T.setInput(document.querySelector('input[type=text]'), '苹果')`);
  await p2.eval(`T.clickBtn('离开')`);
  ok("画手回到等待中", await p1.waitText("等待中", 5000));
  await sleep(200);
  ok("打了一半的答案丢掉了", (await inputValue(p1)) === "", await inputValue(p1));
  ok("退回聊天模式", await p1.eval(`T.submitIs('发送')`));
  const p3 = await br.newPage();
  await joinViaUrl(p3, code, ORIGIN, "新来的");
  ok("回到绘画中", await p1.waitText("绘画中", 5000));
  await sleep(200);
  ok("画手又是答案模式", await p1.eval(`T.submitIs('确认')`), await p1.eval(`document.querySelector('input[type=text]').parentElement.innerText`));
  await p1.eval(`T.enter(document.querySelector('input[type=text]'))`);
  await sleep(300);
  ok("画手没发过聊天", (await countSent(p1, "chat")) === 0, await countSent(p1, "chat"));
  ok("新来的人没看到答案", !(await p3.eval(`T.text().includes('苹果')`)), await p3.eval("T.text().slice(0,200)"));
  await closeAll(br, p1, p2, p3);
};

G.I8_no_page_scroll = async ({ br }) => {
  console.log("\n=== I8 窗口比页面窄时切换输入模式：焦点给输入框，但页面不横向滚动（画布不能在鼠标底下挪）");
  const { p1, code } = await createInBrowser(br);
  await p1.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await p1.eval(`(()=>{window.scrollTo(0,0);document.activeElement&&document.activeElement.blur();})()`);
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  ok("阶段变成绘画中", await p1.waitText("绘画中", 5000));
  await sleep(300);
  ok("画手切到了答案模式", await p1.eval(`T.submitIs('确认')`));
  ok("焦点在聊天输入框上", await p1.eval(`document.activeElement === document.querySelector('input[type=text]')`));
  ok("页面没有横向滚动", (await p1.eval(`window.scrollX`)) === 0, await p1.eval(`window.scrollX`));
  await closeAll(br, p1, p2);
};

G.I3_ime_enter = async ({ br }) => {
  console.log("\n=== I3 输入法组词时按回车只是上屏，不发送");
  const { p1, p2 } = await pagesInRoom(br);
  const chats = () => countSent(p2, "chat");
  const c0 = await chats();
  await p2.eval(
    `(()=>{const i=document.querySelector('input[type=text]');T.setInput(i,'pingguo');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}));})()`,
  );
  await sleep(200);
  ok("组词中（isComposing）的回车不发送", (await chats()) === c0);
  ok("输入框内容还在", (await inputValue(p2)) === "pingguo", await inputValue(p2));
  // Safari：compositionend 比 keydown 先到，isComposing 已经是 false，只能看 keyCode 229
  await p2.eval(
    `(()=>{const i=document.querySelector('input[type=text]');const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});Object.defineProperty(e,'keyCode',{get:()=>229});i.dispatchEvent(e);})()`,
  );
  await sleep(200);
  ok("keyCode 229 的回车不发送", (await chats()) === c0);
  await p2.eval(`T.enter(document.querySelector('input[type=text]'))`);
  ok("普通回车照常发送", await until(async () => (await chats()) === c0 + 1, 2000));
  await closeAll(br, p1, p2);

  const code = await createRoom(2);
  const p = await br.newPage();
  await p.goto(`${ORIGIN}/${code}`);
  await p.waitText("进入房间", 15000);
  await p.eval(
    `(()=>{const i=document.querySelector('input[type=text]');T.setInput(i,'xiaoming');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}));})()`,
  );
  await sleep(300);
  ok("昵称弹窗：组词中的回车不进房间", await p.eval(`T.text().includes('进入房间')`));
  await p.eval(`T.enter(document.querySelector('input[type=text]'))`);
  ok("昵称弹窗：普通回车进房间", await p.waitText("房间号", 8000));
  await closeAll(br, p);
};

G.I4_offline_input_kept = async ({ br, proxy }) => {
  console.log("\n=== I4 断线时发聊天、猜词：提示没发出去，输入框里的内容留着");
  const { p1, p2 } = await pagesInRoom(br);
  proxy.refuse = true;
  proxy.killAll();
  ok("显示断线", await p2.waitText("正在重连", 3000));
  await p2.eval(`T.chat('你好呀')`);
  ok("聊天：提示没发出去", await p2.waitText("没有发出去", 1500), await p2.eval("T.text().slice(0,200)"));
  ok("聊天：输入框里的内容还在", (await inputValue(p2)) === "你好呀", await inputValue(p2));
  proxy.refuse = false;
  ok("p1 重连成功", await reconnected(p1, 12000));
  ok("p2 重连成功", await reconnected(p2, 12000));
  await sleep(300);
  await p2.eval(`T.enter(document.querySelector('input[type=text]'))`);
  ok("重连后回车发出去了", await p1.waitText("你好呀", 3000));
  ok("发出去后输入框清空", (await inputValue(p2)) === "", await inputValue(p2));

  await p1.eval(`T.mode('确认')`);
  await p1.eval(`T.chat('苹果')`);
  ok("进入猜词阶段", await p2.waitText("猜词中", 3000));
  await sleep(200);
  await p2.eval(`T.mode('猜测')`);
  proxy.refuse = true;
  proxy.killAll();
  ok("再次断线", await p2.waitText("正在重连", 3000));
  await sleep(3200); // 等上一条提示消失
  await p2.eval(`T.chat('香蕉')`);
  ok("猜词：提示没发出去", await p2.waitText("没有发出去", 1500), await p2.eval("T.text().slice(0,200)"));
  ok("猜词：输入框里的内容还在", (await inputValue(p2)) === "香蕉", await inputValue(p2));
  proxy.refuse = false;
  await reconnected(p2, 12000);
  await closeAll(br, p1, p2);
};

// ---------- 清除确认 ----------
G.C1_clear_confirm = async ({ br }) => {
  console.log("\n=== C1 清除要确认：点一下不清，3 秒内再点一下才清；连点两下、超时后都不算");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.stroke([[0.2,0.2],[0.6,0.6]])`);
  await until(async () => (await p2.eval("T.ink()")) > 0, 3000);
  const ink1 = await p1.eval("T.ink()");
  const ink2 = await p2.eval("T.ink()");
  await p1.eval(`T.btn('清除').click()`);
  await sleep(300);
  ok("点一下没清", (await p1.eval("T.ink()")) === ink1 && (await p2.eval("T.ink()")) === ink2, { ink1, now: await p1.eval("T.ink()") });
  ok("按钮变成确认", await p1.eval(`!!T.btn('确认清除')`));
  await sleep(500);
  await p1.eval(`(()=>{const b=T.btn('确认清除');if(b)b.click();})()`);
  ok("确认后两端都清空", await until(async () => (await p1.eval("T.ink()")) === 0 && (await p2.eval("T.ink()")) === 0, 3000));
  ok("清空后按钮恢复", await p1.eval(`!T.btn('确认清除')`));

  await p1.eval(`T.stroke([[0.2,0.2],[0.6,0.6]])`);
  await sleep(300);
  const ink3 = await p1.eval("T.ink()");
  await p1.eval(`T.btn('清除').click()`);
  await sleep(3400);
  ok("3 秒后按钮恢复原样", await p1.eval(`!T.btn('确认清除')`));
  await p1.eval(`T.btn('清除').click()`);
  await sleep(300);
  ok("超时后再点一下没清", (await p1.eval("T.ink()")) === ink3);

  await sleep(3400);
  await p1.eval(`(()=>{const b=T.btn('清除');b.click();b.click();})()`);
  await sleep(300);
  ok("连点两下没清", (await p1.eval("T.ink()")) === ink3, await p1.eval("T.ink()"));

  // 系统的双击间隔默认 500ms：隔 500ms 的第二下也算双击，不能清
  await sleep(3400);
  await p1.eval(`T.btn('清除').click()`);
  await sleep(500);
  await p1.eval(`(()=>{const b=T.btn('确认清除')||T.btn('清除');b.click();})()`);
  await sleep(300);
  ok("隔 500ms 的慢双击没清", (await p1.eval("T.ink()")) === ink3, await p1.eval("T.ink()"));

  // 焦点在按钮上按住回车：系统的自动重复（真实的按键事件）不能当成第二下
  await sleep(3400);
  await p1.eval(`T.btn('清除').focus()`);
  const key = (autoRepeat) => ({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", autoRepeat });
  await p1.send("Input.dispatchKeyEvent", key(false));
  await sleep(300);
  ok("回车按下去进入确认态", await p1.eval(`!!T.btn('确认清除')`));
  await sleep(500);
  await p1.send("Input.dispatchKeyEvent", key(true));
  await p1.send("Input.dispatchKeyEvent", key(true));
  await p1.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(300);
  ok("按住回车的自动重复没清", (await p1.eval("T.ink()")) === ink3, await p1.eval("T.ink()"));
  await closeAll(br, p1, p2);
};

// ---------- 鼠标按键 ----------
G.P1_non_primary_button = async ({ br }) => {
  console.log("\n=== P1 右键、中键拖动不作画");
  const { p1, p2 } = await pagesInRoom(br);
  const drag = (button, buttons) =>
    p1.eval(
      `(async()=>{const c=T.cv();const pts=[[0.2,0.2],[0.4,0.4],[0.6,0.5]];let [x,y]=T.pt(...pts[0]);T.fire(c,'mousedown',x,y,{button:${button},buttons:${buttons}});for(const q of pts.slice(1)){[x,y]=T.pt(...q);T.fire(c,'mousemove',x,y,{button:0,buttons:${buttons}});await T.raf();}T.fire(c,'mouseup',x,y,{button:${button},buttons:0});await T.raf(2);})()`,
    );
  const draws0 = await countSent(p1, "draw");
  await drag(2, 2);
  await drag(1, 4);
  ok("画笔：右键、中键没有墨", (await p1.eval("T.ink()")) === 0, await p1.eval("T.ink()"));
  ok("画笔：没发 draw", (await countSent(p1, "draw")) === draws0, await countSent(p1, "draw"));
  await p1.eval(`T.clickBtn('矩形')`);
  await sleep(150);
  await drag(2, 2);
  ok("矩形：右键拖动不出形状", await p1.eval(`!document.querySelector('[data-shape-overlay]')`));
  // 右键按下后直接拖出画布，中间没有 move（快速甩出去）：mouseleave 也不能当成左键松开
  await p1.eval(
    `(async()=>{const c=T.cv();let [x,y]=T.pt(0.3,0.3);T.fire(c,'mousedown',x,y,{button:2,buttons:2});[x,y]=T.pt(1.2,0.6);T.fire(c,'mouseleave',x,y,{button:0,buttons:2});await T.raf(2);})()`,
  );
  ok("矩形：右键按下直接拖出画布也不出形状", await p1.eval(`!document.querySelector('[data-shape-overlay]')`));
  // 左键画一个矩形线框并提交，后面框选的右键点选点在它的边框上（画笔的笔画本来就不能点选）
  await p1.eval(`T.stroke([[0.3,0.6],[0.4,0.7],[0.5,0.85]])`);
  await sleep(150);
  await p1.eval(`T.commit()`);
  await sleep(200);

  await p1.eval(`T.clickBtn('选择 / 框选')`);
  await sleep(150);
  await drag(2, 2);
  ok("框选：右键拖动不出选区", await p1.eval(`!document.querySelector('[data-selection-overlay]')`));
  await p1.eval(`(async()=>{const c=T.cv();const [x,y]=T.pt(0.3,0.72);T.fire(c,'mousedown',x,y,{button:2,buttons:2});T.fire(c,'mouseup',x,y,{button:2,buttons:0});await T.raf(2);})()`);
  ok("框选：右键点在矩形上不选中", await p1.eval(`!document.querySelector('[title="删除该元素"]')`));
  await p1.eval(`(async()=>{T.canvasClick(0.3,0.72);await T.raf(2);})()`);
  ok("左键点同一处能选中（对照）", await p1.eval(`!!document.querySelector('[title="删除该元素"]')`));
  await drag(0, 1);
  ok("左键拖动照常（对照）", await p1.eval(`!!document.querySelector('[data-selection-overlay]')`));
  await closeAll(br, p1, p2);
};

G.P2_released_elsewhere = async ({ br }) => {
  console.log("\n=== P2 在别处松开了按键（之后的移动 buttons=0）：笔画在松开前的位置结束，不再落笔");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(
    `(async()=>{const c=T.cv();let [x,y]=T.pt(0.1,0.5);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.3,0.5);T.fire(c,'mousemove',x,y);await T.raf(2);for(const nx of [0.5,0.7,0.9]){[x,y]=T.pt(nx,0.5);T.fire(c,'mousemove',x,y,{buttons:0});await T.raf();}await T.raf(2);})()`,
  );
  await sleep(500);
  ok("按住时画的那段在", (await p1.eval(regionInk(0.05, 0.4, 0.35, 0.6))) > 0);
  ok("松开后移动过的地方没有墨", (await p1.eval(regionInk(0.4, 0.4, 0.95, 0.6))) === 0, await p1.eval(regionInk(0.4, 0.4, 0.95, 0.6)));
  ok("这一笔结束了（发了 end）", await p1.eval(`__ws.sent.some((s)=>s.startsWith('{"type":"draw","action":"end"'))`));
  const d = await compare(p1, p2);
  ok("两端一致", d.cnt === 0, d);

  await p1.eval(`T.clickBtn('矩形')`);
  await sleep(150);
  await p1.eval(
    `(async()=>{const c=T.cv();let [x,y]=T.pt(0.2,0.1);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.4,0.3);T.fire(c,'mousemove',x,y);await T.raf(2);[x,y]=T.pt(0.8,0.35);T.fire(c,'mousemove',x,y,{buttons:0});await T.raf(3);})()`,
  );
  await sleep(200);
  const box = await p1.eval(
    `(()=>{const o=document.querySelector('[data-shape-overlay]');if(!o)return null;const c=T.cv().getBoundingClientRect();const r=o.getBoundingClientRect();return {right:(r.right-c.left)/c.width};})()`,
  );
  ok("矩形：松开后进入编辑态，停在松开前的位置", !!box && box.right < 0.5, box);
  await p1.eval(`T.commit()`);
  await sleep(200);

  await p1.eval(`T.clickBtn('选择 / 框选')`);
  await sleep(150);
  await p1.eval(
    `(async()=>{const c=T.cv();let [x,y]=T.pt(0.15,0.05);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.45,0.4);T.fire(c,'mousemove',x,y);await T.raf(2);[x,y]=T.pt(0.9,0.9);T.fire(c,'mousemove',x,y,{buttons:0});await T.raf(3);})()`,
  );
  await sleep(200);
  const sel = await p1.eval(
    `(()=>{const o=document.querySelector('[data-selection-overlay]');if(!o)return null;const c=T.cv().getBoundingClientRect();const r=o.getBoundingClientRect();return {right:(r.right-c.left)/c.width,bottom:(r.bottom-c.top)/c.height};})()`,
  );
  ok("框选：松开后出选区，停在松开前的位置", !!sel && sel.right < 0.55 && sel.bottom < 0.5, sel);
  await p1.eval(`T.commit()`);
  await sleep(200);

  // 在别处松开以后，画布先收到的是 mouseleave（光标回来时直接落在工具栏上）：也在松开前的位置结束
  await pickTool(p1, "画笔");
  await p1.eval(
    `(async()=>{const c=T.cv();let [x,y]=T.pt(0.1,0.9);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.3,0.9);T.fire(c,'mousemove',x,y);await T.raf(2);[x,y]=T.pt(0.9,1.05);T.fire(c,'mouseleave',x,y,{buttons:0});await T.raf(3);})()`,
  );
  await sleep(300);
  ok("画笔：松开后的 mouseleave 不补线", (await p1.eval(regionInk(0.4, 0.85, 0.95, 0.99))) === 0, await p1.eval(regionInk(0.4, 0.85, 0.95, 0.99)));
  await pickTool(p1, "矩形");
  await p1.eval(
    `(async()=>{const c=T.cv();let [x,y]=T.pt(0.6,0.1);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.7,0.2);T.fire(c,'mousemove',x,y);await T.raf(2);[x,y]=T.pt(1.1,0.6);T.fire(c,'mouseleave',x,y,{buttons:0});await T.raf(3);})()`,
  );
  const leaveBox = await p1.eval(
    `(()=>{const o=document.querySelector('[data-shape-overlay]');if(!o)return null;const c=T.cv().getBoundingClientRect();const r=o.getBoundingClientRect();return {right:(r.right-c.left)/c.width};})()`,
  );
  ok("矩形：松开后的 mouseleave 停在松开前的位置，不跳到边上", !!leaveBox && leaveBox.right < 0.8, leaveBox);
  await p1.eval(`T.commit()`);
  await sleep(200);

  // 左键拖动中按下又松开右键：左键还按着，这一笔不能结束
  await pickTool(p1, "画笔");
  await p1.eval(
    `(async()=>{const c=T.cv();let [x,y]=T.pt(0.1,0.7);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.2,0.7);T.fire(c,'mousemove',x,y);await T.raf(2);T.fire(c,'mouseup',x,y,{button:2,buttons:1});for(const nx of [0.3,0.4,0.5]){[x,y]=T.pt(nx,0.7);T.fire(c,'mousemove',x,y);await T.raf();}T.fire(c,'mouseup',x,y);await T.raf(2);})()`,
  );
  await sleep(300);
  ok("画笔：中途松开右键，左键还按着就接着画", (await p1.eval(regionInk(0.35, 0.65, 0.48, 0.75))) > 0, await p1.eval(regionInk(0.35, 0.65, 0.48, 0.75)));
  const rightOf = (sel) =>
    p1.eval(`(()=>{const o=document.querySelector('${sel}');if(!o)return null;const c=T.cv().getBoundingClientRect();return (o.getBoundingClientRect().right-c.left)/c.width;})()`);
  const dragWithRightUp = (x0, y0, x1, y1) =>
    p1.eval(
      `(async()=>{const c=T.cv();let [x,y]=T.pt(${x0},${y0});T.fire(c,'mousedown',x,y);[x,y]=T.pt(${x0 + 0.05},${y0 + 0.05});T.fire(c,'mousemove',x,y);await T.raf(2);T.fire(c,'mouseup',x,y,{button:2,buttons:1});[x,y]=T.pt(${x1},${y1});T.fire(c,'mousemove',x,y);await T.raf(2);T.fire(c,'mouseup',x,y);await T.raf(2);})()`,
    );
  await pickTool(p1, "矩形");
  await dragWithRightUp(0.55, 0.45, 0.75, 0.6);
  const rr = await rightOf("[data-shape-overlay]");
  ok("矩形：中途松开右键不结束，以左键松开的位置为准", rr !== null && Math.abs(rr - 0.75) < 0.03, rr);
  await p1.eval(`T.commit()`);
  await sleep(200);
  await pickTool(p1, "选择 / 框选");
  await dragWithRightUp(0.05, 0.05, 0.3, 0.3);
  const sr = await rightOf("[data-selection-overlay]");
  ok("框选：中途松开右键不结束，以左键松开的位置为准", sr !== null && Math.abs(sr - 0.3) < 0.03, sr);
  await p1.eval(`T.commit()`);
  await sleep(200);
  await pickTool(p1, "画笔");

  // macOS 的 Ctrl+点击是右键菜单（button 也是 0）：不作画
  const draws0 = await countSent(p1, "draw");
  await p1.eval(`(async()=>{const c=T.cv();const [x,y]=T.pt(0.8,0.7);T.fire(c,'mousedown',x,y,{ctrlKey:true});T.fire(c,'mouseup',x,y,{ctrlKey:true});await T.raf(2);})()`);
  await sleep(200);
  ok("Ctrl+点击不作画", (await countSent(p1, "draw")) === draws0, await countSent(p1, "draw"));
  await closeAll(br, p1, p2);
};

G.P3_spray_across_join = async ({ br }) => {
  console.log("\n=== P3 等人时按住喷枪不动，第二个人进来（阶段变化）之后继续喷");
  const { p1, code } = await createInBrowser(br);
  // 粗线 + 看深浅而不是像素数：默认线宽下原地喷的那一小块两秒就铺满，像素数不再涨
  await pickBrush(p1, "喷枪", 12);
  await p1.eval(`(()=>{const [x,y]=T.pt(0.5,0.5);T.fire(T.cv(),'mousedown',x,y);})()`);
  await sleep(500);
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  ok("阶段变成绘画中", await p1.waitText("绘画中", 5000));
  await sleep(200);
  const spot = regionDark(0.4, 0.3, 0.6, 0.7);
  const inkAtJoin = await p1.eval(spot);
  await sleep(1200);
  const inkAfter = await p1.eval(spot);
  ok("阶段变化后还在喷", inkAfter > inkAtJoin * 1.05, { inkAtJoin, inkAfter });
  await p1.eval(`(()=>{const [x,y]=T.pt(0.5,0.5);T.fire(T.cv(),'mouseup',x,y);})()`);
  await sleep(800);
  const d = await compare(p1, p2);
  ok("松手后两端一致", d.cnt === 0, d);
  await closeAll(br, p1, p2);
};

G.P4_drag_across_phase = async ({ br }) => {
  console.log("\n=== P4 拖到一半的矩形、框选，有人进出（waiting ⇄ drawing）之后照常完成");
  const { p1, code } = await createInBrowser(br, "画手甲", 3);
  const overlayBox = (sel) =>
    p1.eval(
      `(()=>{const o=document.querySelector('${sel}');if(!o)return null;const c=T.cv().getBoundingClientRect();const r=o.getBoundingClientRect();return {right:(r.right-c.left)/c.width,bottom:(r.bottom-c.top)/c.height};})()`,
    );
  await pickTool(p1, "矩形");
  await p1.eval(`(async()=>{const c=T.cv();let [x,y]=T.pt(0.2,0.2);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.3,0.3);T.fire(c,'mousemove',x,y);await T.raf(2);})()`);
  const p2 = await br.newPage();
  await joinViaUrl(p2, code, ORIGIN, "猜手乙");
  ok("第二个人进来，阶段变成绘画中", await p1.waitText("绘画中", 5000));
  await sleep(200);
  await p1.eval(`(async()=>{const c=T.cv();let [x,y]=T.pt(0.45,0.45);T.fire(c,'mousemove',x,y);await T.raf(2);T.fire(c,'mouseup',x,y);await T.raf(2);})()`);
  const box = await overlayBox("[data-shape-overlay]");
  ok("矩形：松手后进入编辑态，终点在松手的位置", !!box && Math.abs(box.right - 0.45) < 0.03, box);
  await p1.eval(`T.commit()`);
  await sleep(200);

  await pickTool(p1, "选择 / 框选");
  await p1.eval(`(async()=>{const c=T.cv();let [x,y]=T.pt(0.1,0.1);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.3,0.3);T.fire(c,'mousemove',x,y);await T.raf(2);})()`);
  await p2.eval(`T.clickBtn('离开')`);
  ok("第二个人离开，阶段回到等待中", await p1.waitText("等待中", 5000));
  await sleep(200);
  await p1.eval(`(async()=>{const c=T.cv();let [x,y]=T.pt(0.5,0.5);T.fire(c,'mousemove',x,y);await T.raf(2);T.fire(c,'mouseup',x,y);await T.raf(2);})()`);
  const sel = await overlayBox("[data-selection-overlay]");
  ok("框选：松手后出选区，终点在松手的位置", !!sel && Math.abs(sel.right - 0.5) < 0.03, sel);
  await closeAll(br, p1, p2);
};

G.P5_blur_ends_drag = async ({ br }) => {
  console.log("\n=== P5 按住时切到别的窗口（blur）：喷枪不再一直喷，形状、框选在当时的位置结束");
  const { p1, p2 } = await pagesInRoom(br);
  await pickBrush(p1, "喷枪", 12);
  await p1.eval(`(()=>{const [x,y]=T.pt(0.3,0.5);T.fire(T.cv(),'mousedown',x,y);})()`);
  await sleep(400);
  await p1.eval(`window.dispatchEvent(new Event('blur'))`);
  await sleep(100);
  const dark0 = await p1.eval(regionDark(0.2, 0.35, 0.4, 0.65));
  await sleep(900);
  const dark1 = await p1.eval(regionDark(0.2, 0.35, 0.4, 0.65));
  ok("喷枪：离开窗口后不再喷", dark1 === dark0, { dark0, dark1 });
  ok("喷枪：这一笔结束了（发了 end）", await p1.eval(`__ws.sent.some((s)=>s.startsWith('{"type":"draw","action":"end"'))`));
  await sleep(300);
  const d = await compare(p1, p2);
  ok("两端一致", d.cnt === 0, d);

  await pickTool(p1, "矩形");
  await p1.eval(`(async()=>{const c=T.cv();let [x,y]=T.pt(0.55,0.2);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.75,0.4);T.fire(c,'mousemove',x,y);await T.raf(2);window.dispatchEvent(new Event('blur'));await T.raf(2);})()`);
  ok("矩形：离开窗口时进入编辑态", await p1.eval(`!!document.querySelector('[data-shape-overlay]')`));
  await p1.eval(`T.commit()`);
  await sleep(200);
  await pickTool(p1, "选择 / 框选");
  await p1.eval(`(async()=>{const c=T.cv();let [x,y]=T.pt(0.55,0.55);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.85,0.85);T.fire(c,'mousemove',x,y);await T.raf(2);window.dispatchEvent(new Event('blur'));await T.raf(2);})()`);
  ok("框选：离开窗口时出选区", await p1.eval(`!!document.querySelector('[data-selection-overlay]')`));
  await closeAll(br, p1, p2);
};

// ---------- 编辑框拖动 ----------
G.O1_overlay_buttons = async ({ br }) => {
  console.log("\n=== O1 编辑框（形状、框选、文字）：右键拖不动；拖动中左键在别处松开了（buttons=0），编辑框不再跟着走");
  const { p1, p2 } = await pagesInRoom(br);
  const rectOf = (sel) => p1.eval(`(()=>{const o=document.querySelector('${sel}');if(!o)return null;const r=o.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width)};})()`);
  // 在 target 上按下，然后在 window 上移动（buttons 依次取 moves 里的值）、最后松开
  const drag = (target, button, moves) =>
    p1.eval(
      `(async()=>{const el=${target};const r=el.getBoundingClientRect();const x0=r.left+r.width/2,y0=r.top+r.height/2;T.fire(el,'mousedown',x0,y0,{button:${button},buttons:${button === 0 ? 1 : button === 2 ? 2 : 4}});await T.raf(2);for(const [dx,dy,b] of ${JSON.stringify(moves)}){window.dispatchEvent(new MouseEvent('mousemove',{clientX:x0+dx,clientY:y0+dy,bubbles:true,buttons:b}));await T.raf(2);}window.dispatchEvent(new MouseEvent('mouseup',{clientX:x0,clientY:y0,bubbles:true,button:${button}}));await T.raf(2);})()`,
    );
  const moved = (a, b) => !!a && !!b && (Math.abs(a.x - b.x) > 3 || Math.abs(a.y - b.y) > 3);

  // 形状：平移、缩放
  await pickTool(p1, "矩形");
  await p1.eval(`T.stroke([[0.2,0.2],[0.3,0.3],[0.4,0.4]])`);
  await sleep(200);
  const SHAPE = "[data-shape-overlay]";
  let a = await rectOf(SHAPE);
  await drag(`document.querySelector('${SHAPE}')`, 2, [[80, 60, 2]]);
  ok("形状：右键拖不动", !moved(a, await rectOf(SHAPE)), { a, b: await rectOf(SHAPE) });
  await drag(`document.querySelector('${SHAPE}')`, 0, [[30, 0, 1], [200, 150, 0], [260, 200, 0]]);
  let b = await rectOf(SHAPE);
  ok("形状：左键拖动有效，松开后不再跟着走", !!b && Math.abs(b.x - a.x - 30) <= 3 && Math.abs(b.y - a.y) <= 3, { a, b });
  a = b;
  const corner = `[...document.querySelectorAll('${SHAPE} *')].filter((e)=>getComputedStyle(e).cursor.includes('resize')).at(-1)`;
  await drag(corner, 2, [[60, 60, 2]]);
  b = await rectOf(SHAPE);
  ok("形状：右键拖角点不缩放", !!b && Math.abs(b.w - a.w) <= 3, { a, b });
  await p1.eval(`T.commit()`);
  await sleep(200);

  // 直线：端点
  await pickTool(p1, "直线");
  await p1.eval(`T.stroke([[0.55,0.15],[0.65,0.2],[0.75,0.25]])`);
  await sleep(200);
  a = await rectOf(SHAPE);
  const endpoint = `[...document.querySelectorAll('${SHAPE} *')].filter((e)=>getComputedStyle(e).cursor==='grab').at(-1)`;
  await drag(endpoint, 2, [[60, 60, 2]]);
  b = await rectOf(SHAPE);
  ok("直线：右键拖端点不改长度", !!b && Math.abs(b.w - a.w) <= 3, { a, b });
  await p1.eval(`T.commit()`);
  await sleep(200);

  // 框选
  await pickTool(p1, "选择 / 框选");
  await p1.eval(`(async()=>{const c=T.cv();let [x,y]=T.pt(0.15,0.15);T.fire(c,'mousedown',x,y);[x,y]=T.pt(0.45,0.45);T.fire(c,'mousemove',x,y);await T.raf(2);T.fire(c,'mouseup',x,y);await T.raf(2);})()`);
  await sleep(200);
  const SEL = "[data-selection-overlay]";
  a = await rectOf(SEL);
  await drag(`document.querySelector('${SEL}')`, 2, [[80, 60, 2]]);
  ok("框选：右键拖不动", !moved(a, await rectOf(SEL)), { a, b: await rectOf(SEL) });
  await drag(`document.querySelector('${SEL}')`, 0, [[30, 0, 1], [200, 150, 0]]);
  b = await rectOf(SEL);
  ok("框选：左键拖动有效，松开后不再跟着走", !!b && Math.abs(b.x - a.x - 30) <= 3 && Math.abs(b.y - a.y) <= 3, { a, b });
  await p1.eval(`T.commit()`);
  await sleep(200);

  // 文字：拖边框、拖角点
  await pickTool(p1, "文本");
  await p1.eval(`T.canvasClick(0.6,0.6)`);
  await sleep(200);
  await p1.eval(`(()=>{const ta=document.querySelector('[data-text-overlay] textarea');T.setInput(ta,'你好');})()`);
  await sleep(150);
  const TXT = "[data-text-overlay]";
  const border = `[...document.querySelectorAll('${TXT} *')].find((e)=>getComputedStyle(e).cursor==='move')`;
  a = await rectOf(TXT);
  await drag(border, 2, [[80, 60, 2]]);
  ok("文字：右键拖不动", !moved(a, await rectOf(TXT)), { a, b: await rectOf(TXT) });
  await drag(border, 0, [[30, 0, 1], [200, 150, 0]]);
  b = await rectOf(TXT);
  ok("文字：左键拖动有效，松开后不再跟着走", !!b && Math.abs(b.x - a.x - 30) <= 3 && Math.abs(b.y - a.y) <= 3, { a, b });
  a = b;
  const tcorner = `[...document.querySelectorAll('${TXT} *')].filter((e)=>getComputedStyle(e).cursor.includes('resize')).at(-1)`;
  await drag(tcorner, 2, [[80, 80, 2]]);
  b = await rectOf(TXT);
  ok("文字：右键拖角点不改字号", !!b && Math.abs(b.w - a.w) <= 3, { a, b });
  // 左键拖一小段（字号变大约两成），然后左键在别处松开了：之后的移动不再改字号
  await drag(tcorner, 0, [[20, 20, 1], [150, 150, 0]]);
  b = await rectOf(TXT);
  ok("文字：左键拖角点有效，松开后不再改字号", !!b && b.w > a.w + 3 && b.w - a.w < a.w * 0.6, { a, b });
  await closeAll(br, p1, p2);
};

// ---------- 提示 ----------
G.T1_toast_under_traffic = async ({ br }) => {
  console.log("\n=== T1 聊天消息不停进来时，提示也按时消失");
  const { p1, code } = await createInBrowser(br, "画手甲", 3);
  const c = new NodeClient(code);
  await c.join("话痨", undefined, "tok-" + Date.now());
  await sleep(300);
  await p1.eval(`__ws.instances.at(-1).dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'error',message:'测试提示一下'})}))`);
  ok("提示出来了", await p1.waitText("测试提示一下", 1000));
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < 4500) {
    c.send({ type: "chat", text: "消息" + n++ });
    await sleep(300);
  }
  ok("4.5 秒后提示已经消失", !(await p1.eval(`T.text().includes('测试提示一下')`)));
  c.kill();
  await closeAll(br, p1);
};

// ---------- 颜色 ----------
G.K1_hue_from_black = async ({ br }) => {
  console.log("\n=== K1 自定义颜色从黑色起手：拖色相条有效");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.clickBtn('画笔')`);
  await sleep(150);
  await p1.eval(`T.clickBtn('自定义颜色')`);
  await sleep(150);
  const hex = () => p1.eval(`document.querySelector('[data-color-panel] input').value`);
  ok("起手是黑色", (await hex()).toLowerCase() === "#000000", await hex());
  // 竖向色相条：中间 = 180°（青色）
  await p1.eval(
    `(async()=>{const root=document.querySelector('[data-color-panel] .w-color-hue');const el=root.querySelector('.w-color-interactive')||root;const r=el.getBoundingClientRect();T.fire(el,'mousedown',r.left+r.width/2,r.top+r.height/2);window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await T.raf(2);})()`,
  );
  // 饱和度区右上角 = 饱和度、明度都最大
  await p1.eval(
    `(async()=>{const el=document.querySelector('[data-color-panel] .w-color-saturation');const r=el.getBoundingClientRect();T.fire(el,'mousedown',r.right-1,r.top+1);window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await T.raf(2);})()`,
  );
  const h = (await hex()).toLowerCase();
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  ok("选出来的是青色（色相没丢）", r < 40 && g > 200 && b > 200, h);
  await closeAll(br, p1, p2);
};

// ---------- 剪贴板 ----------
G.J1_clipboard_failure = async ({ br }) => {
  console.log("\n=== J1 复制链接失败：有提示，没有未处理的异常；退回方案能用时照样成功");
  const { p1 } = await createInBrowser(br);
  await p1.eval(
    `(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new DOMException('denied','NotAllowedError'))}});document.execCommand=()=>false;})()`,
  );
  const errs0 = await p1.eval("__errs.length");
  await p1.eval(`T.clickBtn('分享房间')`);
  await sleep(400);
  ok("显示复制失败", await p1.eval(`T.text().includes('复制失败')`), await p1.eval("T.text().slice(0,150)"));
  ok("没有未处理的异常", (await p1.eval("__errs.length")) === errs0, await p1.eval("__errs"));
  await sleep(2300);
  await p1.eval(`(()=>{document.execCommand=(c)=>c==='copy';})()`);
  await p1.eval(`T.clickBtn('分享房间')`);
  await sleep(300);
  ok("剪贴板接口不可用时用退回方案复制成功", await p1.eval(`T.text().includes('已复制')`), await p1.eval("T.text().slice(0,150)"));
  // 退回方案自己抛异常：临时的文本框也要删掉，不能留在页面上挡点击、占焦点
  await sleep(2300);
  await p1.eval(`(()=>{document.execCommand=()=>{throw new Error('boom');};})()`);
  await p1.eval(`T.clickBtn('分享房间')`);
  await sleep(300);
  ok("退回方案抛异常：显示复制失败", await p1.eval(`T.text().includes('复制失败')`));
  ok("退回方案抛异常：临时文本框删掉了", (await p1.eval(`document.querySelectorAll('textarea').length`)) === 0, await p1.eval(`document.querySelectorAll('textarea').length`));
  await closeAll(br, p1);
};

// ---------- 空操作 ----------
G.F1_noop_fill = async ({ br }) => {
  console.log("\n=== F1 油漆桶点在同色区域：什么都没变，不发消息、不进撤销栈");
  const { p1, p2 } = await pagesInRoom(br);
  await p1.eval(`T.clickBtn('油漆桶')`);
  await sleep(150);
  const fills = () => countSent(p1, "fill");
  await p1.eval(`T.canvasClick(0.5,0.5)`);
  await sleep(500);
  ok("第一下填上了", (await fills()) === 1, await fills());
  await p1.eval(`T.canvasClick(0.3,0.3)`);
  await sleep(500);
  ok("同色区域再填不发消息", (await fills()) === 1, await fills());
  await p1.eval(`T.btn('撤销').click()`);
  await sleep(800);
  ok("撤销一次就回到白底（栈里只有第一下）", (await p1.eval("T.ink()")) === 0, await p1.eval("T.ink()"));
  ok("撤销之后没得再撤销", await p1.eval(`T.btn('撤销').disabled === true`));
  const d = await compare(p1, p2);
  ok("两端一致", d.cnt === 0, d);
  await closeAll(br, p1, p2);
};

G.F2_click_dot = async ({ br }) => {
  console.log("\n=== F2 原地单击：留下一个点，不是看不见的空笔画（零长度线段 Chromium 不画圆头）");
  const { p1, p2 } = await pagesInRoom(br);
  const spots = { 画笔: 0.2, 水彩笔: 0.5, 蜡笔: 0.8 };
  for (const [brush, nx] of Object.entries(spots)) {
    await pickBrush(p1, brush);
    await p1.eval(`(async()=>{const c=T.cv();const [x,y]=T.pt(${nx},0.5);T.fire(c,'mousedown',x,y);T.fire(c,'mouseup',x,y);await T.raf(2);})()`);
    await sleep(600);
    const area = regionInk(nx - 0.05, 0.4, nx + 0.05, 0.6);
    ok(`${brush}：画手这边有墨`, (await p1.eval(area)) > 0, await p1.eval(area));
    ok(`${brush}：对端也有墨`, (await p2.eval(area)) > 0, await p2.eval(area));
  }
  await closeAll(br, p1, p2);
};

// ---------- 形状编辑框 ----------
G.S1_overlay_matches_render = async ({ br }) => {
  console.log("\n=== S1 矩形、椭圆：编辑框里的预览和提交后画出来的位置一致（不差半个线宽）");
  const { p1, p2 } = await pagesInRoom(br);
  for (const shape of ["矩形", "椭圆"]) {
    await p1.eval(`T.clickBtn('${shape}')`);
    await sleep(150);
    await p1.eval(`T.clickBtn('12px')`);
    await sleep(100);
    await p1.eval(`T.commit()`);
    await sleep(100);
    const y0 = shape === "矩形" ? 0.2 : 0.55;
    await p1.eval(`T.stroke([[0.25,${y0}],[0.4,${y0 + 0.1}],[0.55,${y0 + 0.3}]])`);
    await sleep(250);
    ok(`${shape}：进入编辑态`, await p1.eval(`!!document.querySelector('[data-shape-overlay]')`));
    const before = await darkXsOnRow(p1, y0 + 0.15);
    await p1.eval(`T.commit()`);
    await sleep(400);
    const after = await darkXsOnRow(p1, y0 + 0.15);
    const [lb, la, rb, ra] = [firstRun(before), firstRun(after), lastRun(before), lastRun(after)];
    // 边缘抗锯齿的取法不同（CSS 边框和画布下采样），留 2px 余量；修复前差半个线宽（约 8px）
    const near = (a, b) => !!a && !!b && Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2;
    ok(`${shape}：左边框位置一致`, near(lb, la), { preview: lb, render: la });
    ok(`${shape}：右边框位置一致`, near(rb, ra), { preview: rb, render: ra });
  }
  // 比线宽还扁的矩形：CSS 边框的盒子会被撑大，预览要和画出来的一样高
  await p1.eval(`T.clickBtn('矩形')`);
  await sleep(150);
  await p1.eval(`T.commit()`);
  await sleep(100);
  await p1.eval(`T.stroke([[0.6,0.4],[0.7,0.402],[0.85,0.405]])`);
  await sleep(250);
  const colBefore = firstRun(await darkYsOnCol(p1, 0.72));
  await p1.eval(`T.commit()`);
  await sleep(400);
  const colAfter = firstRun(await darkYsOnCol(p1, 0.72));
  ok(
    "扁矩形：预览和画出来的上下边一致",
    !!colBefore && !!colAfter && Math.abs(colBefore[0] - colAfter[0]) <= 2 && Math.abs(colBefore[1] - colAfter[1]) <= 2,
    { preview: colBefore, render: colAfter },
  );
  await closeAll(br, p1, p2);
};

// ---------- 手机 ----------
G.M1_mobile_notice = async ({ br }) => {
  console.log("\n=== M1 触屏设备打开：提示用电脑打开，可以选择继续");
  const p = await br.newPage();
  await p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await p.goto(ORIGIN + "/");
  const shown = await p.waitText("请用电脑打开", 3000);
  ok("首页提示用电脑打开", shown, await p.eval("T.text().slice(0,120)"));
  ok("提示盖住了首页菜单", !(await p.eval(`!!T.btn('创建房间')`)));
  // 空闲预加载最晚 3 秒触发；提示挡着的时候不该下载房间页的代码
  await sleep(3500);
  ok("提示期间不预加载房间页", !(await p.eval(`performance.getEntriesByType('resource').some((e)=>/\\/assets\\/Room-/.test(e.name))`)));
  if (shown) {
    await p.eval(`T.clickBtn('仍要继续')`);
    await sleep(200);
    ok("点继续后看到首页", await p.eval(`!!T.btn('创建房间')`));
    await p.goto(ORIGIN + "/");
    await sleep(200);
    ok("同一个标签页刷新后不再提示", !(await p.eval(`T.text().includes('请用电脑打开')`)) && (await p.eval(`!!T.btn('创建房间')`)));
  }
  await closeAll(br, p);

  const code = await createRoom(2);
  const q = await br.newPage();
  await q.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await q.goto(`${ORIGIN}/${code}`);
  ok("房间链接也提示", await q.waitText("请用电脑打开", 3000), await q.eval("T.text().slice(0,120)"));
  await closeAll(br, q);

  const dsk = await br.newPage();
  await dsk.goto(ORIGIN + "/");
  await sleep(300);
  ok("有鼠标的设备不提示", !(await dsk.eval(`T.text().includes('请用电脑打开')`)) && (await dsk.eval(`!!T.btn('创建房间')`)));
  await closeAll(br, dsk);

  // Safari 阻止所有 Cookie 时，一碰 sessionStorage 就抛 SecurityError：提示页照样出来，不能直接进错误页
  const blocked = await br.newPage();
  await blocked.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await blocked.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(window,'sessionStorage',{configurable:true,get(){throw new DOMException('The operation is insecure.','SecurityError');}});`,
  });
  await blocked.goto(ORIGIN + "/");
  const shownBlocked = await blocked.waitText("请用电脑打开", 3000);
  ok("存储被禁用：提示页照样出来", shownBlocked, await blocked.eval("T.text().slice(0,120)"));
  if (shownBlocked) {
    await blocked.eval(`T.clickBtn('仍要继续')`);
    await sleep(200);
    ok("存储被禁用：点继续能看到首页", await blocked.eval(`!!T.btn('创建房间')`), await blocked.eval("T.text().slice(0,120)"));
  }
  await closeAll(br, blocked);
};

// ---------- 页面信息 ----------
G.H1_title = async ({ br }) => {
  console.log("\n=== H1 网页标题和首页标题一致，有分享用的描述");
  const p = await br.newPage();
  await p.goto(ORIGIN + "/");
  const r = await p.eval(`({title: document.title, h1: document.querySelector('h1')?.innerText || '', desc: document.querySelector('meta[name=description]')?.content || ''})`);
  ok("标题和首页一致", r.title.length > 0 && r.h1.includes(r.title), r);
  ok("有描述", r.desc.length > 0, r);
  await closeAll(br, p);
};

// ---------- 聊天列表 ----------
G.L1_chat_cap = async ({ br }) => {
  console.log("\n=== L1 消息很多时页面只留最近的一部分");
  const { p1, code } = await createInBrowser(br, "画手甲", 3);
  const c = new NodeClient(code);
  await c.join("话痨", undefined, "tok-" + Date.now());
  for (let i = 0; i < 560; i++) {
    c.send({ type: "chat", text: `第${i}条` });
  }
  ok("最后一条到了", await p1.waitText("第559条", 20000));
  await sleep(300);
  const n = await p1.eval(`[...document.querySelectorAll('span')].filter((s) => /^第\\d+条$/.test(s.textContent)).length`);
  ok("页面上的消息不超过 500 条", n <= 500, n);
  ok("至少留着服务端历史那么多（200 条）", n >= 200, n);
  ok("最早的已经不在了", !(await p1.eval(`T.text().includes('第0条')`)));
  c.kill();
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
    proxy.delayDown = 0;
    proxy.stall = false;
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
