// ---------- 第三批：加载和响应头 ----------
// 这段被 browser-batch3.cjs 引入。fonts：所有页面的字体 CDN 都被拦截成本地响应，不依赖真实 CDN。
const path = require("path");
const fs = require("fs");
const { sleep, serveStatic, NodeClient, createRoom, joinViaUrl, ORIGIN } = require("./harness.cjs");

const FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\georgia.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];
const fontFile = FONT_CANDIDATES.find((f) => fs.existsSync(f));
const fontB64 = fontFile ? fs.readFileSync(fontFile).toString("base64") : "";
const HAND_CSS = `@font-face{font-family:"Excalifont";src:url(https://fonts.dengjiabei.cn/test-font.ttf);font-display:swap}`;

// 每个页面的字体响应：delayMs 延迟样式表，block 模拟 CDN 不可达
async function mockFonts(page, state = {}) {
  page.fontState = { delayMs: 0, block: false, ...state };
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*fonts.dengjiabei.cn*" }] });
  page.handlers["Fetch.requestPaused"] = (ev) => {
    const { delayMs, block } = page.fontState;
    const url = ev.request.url;
    const respond = () => {
      if (block) {
        page.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "ConnectionFailed" }).catch(() => {});
        return;
      }
      const isCss = url.includes(".css");
      page
        .send("Fetch.fulfillRequest", {
          requestId: ev.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: isCss ? "text/css" : "font/ttf" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: isCss ? Buffer.from(HAND_CSS).toString("base64") : fontB64,
        })
        .catch(() => {});
    };
    if (url.includes(".css") && delayMs > 0) {
      setTimeout(respond, delayMs);
    } else {
      respond();
    }
  };
}

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
const fcpOf = (p) => p.eval(`(performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime||0`);
const hasOverlay = (p) => p.eval(`!!document.querySelector('[data-selection-overlay]')`);

function loadGroups({ ok, closeAll, sameOff, paintGrid, scratch, buildDir }) {
  const G = {};

  G.P1_home_fcp = async ({ br }) => {
    console.log("\n=== P1 字体样式表慢的时候，首页不被挡住");
    const p = await br.newPage();
    p.fontState.delayMs = 5000;
    await p.goto(ORIGIN + "/", false);
    await sleep(3000);
    const fcp = await fcpOf(p);
    ok("样式表延迟 5 秒，首屏 1.5 秒内出来", fcp > 0 && fcp < 1500, fcp);
    await closeAll(br, p);
  };

  G.P2_room_not_blocked = async ({ br }) => {
    console.log("\n=== P2 字体样式表慢的时候，房间页和画板不被挡住");
    const code = await createRoom(2);
    const d = new NodeClient(code);
    await d.join("画手");
    d.send({ type: "textStroke", text: "Hello 你好", x: 0.1, y: 0.1, color: "#000000", fontSize: 48 });
    await sleep(200);
    const p = await br.newPage();
    p.fontState.delayMs = 8000;
    await p.goto(`${ORIGIN}/${code}`, false);
    const entered = await until(() => p.eval(`document.body && document.body.innerText.includes('进入房间')`), 3000, 50);
    ok("样式表还没到，昵称弹窗已经能用", entered);
    if (entered) {
      await p.eval(`T.clickBtn('进入房间')`);
      const drawn = await until(() => p.eval(`document.querySelector('canvas') ? T.ink() > 50 : false`), 3000, 100);
      ok("样式表还没到，文字已经用回退字体画出来了", drawn);
    }
    d.kill();
    await closeAll(br, p);
  };

  G.P3_font_swap = async ({ br }) => {
    console.log("\n=== P3 字体晚到：文字换成手写体，和字体早到的页面逐像素一致");
    ok("测试字体存在", !!fontFile, FONT_CANDIDATES);
    const code = await createRoom(5);
    const d = new NodeClient(code);
    await d.join("画手");
    d.send({ type: "shape", shape: "rect", filled: false, x: 0.5, y: 0.5, width: 0.2, height: 0.2, color: "#000000", lineWidth: 2 });
    d.send({ type: "fill", x: 0.6, y: 0.6, color: "#10aeff", tolerance: 32 });
    d.send({ type: "textStroke", text: "Hello World", x: 0.1, y: 0.1, color: "#000000", fontSize: 48 });
    d.send({ type: "shape", shape: "star", filled: false, x: 0.1, y: 0.5, width: 0.2, height: 0.2, color: "#fa5151", lineWidth: 4 });
    await sleep(200);
    const blocked = await br.newPage();
    blocked.fontState.block = true;
    await joinViaUrl(blocked, code, ORIGIN, "无字体");
    const late = await br.newPage();
    late.fontState.delayMs = 2500;
    await joinViaUrl(late, code, ORIGIN, "晚到");
    await sleep(300);
    const before = await late.eval("T.offHash()");
    const early = await br.newPage();
    await joinViaUrl(early, code, ORIGIN, "早到");
    await sleep(3500);
    const r = await sameOff([late, early]);
    ok("晚到的页面最终和早到的完全一致", r.same, r.hashes);
    const fb = await blocked.eval("T.offHash()");
    ok("和回退字体的画面确实不同（真的换了字体）", r.hashes[0] !== fb, { fb, final: r.hashes[0] });
    ok("字体到达前用的是回退字体", before === fb, { before, fb });
    d.kill();
    await closeAll(br, blocked, late, early);
  };

  G.P4_font_unreachable = async ({ br }) => {
    console.log("\n=== P4 字体 CDN 不可达：回退字体，不反复重画");
    const code = await createRoom(2);
    const d = new NodeClient(code);
    await d.join("画手");
    d.send({ type: "textStroke", text: "你好世界 Hello", x: 0.1, y: 0.1, color: "#000000", fontSize: 36 });
    await sleep(200);
    const p = await br.newPage();
    p.fontState.block = true;
    await joinViaUrl(p, code, ORIGIN, "观众");
    await sleep(1500);
    const m0 = await p.metrics();
    await sleep(3000);
    const m1 = await p.metrics();
    const ms = Math.round(((m1.TaskDuration - m0.TaskDuration) / 3) * 1000);
    ok("空闲时主线程占用很低", ms < 60, ms);
    ok("文字用回退字体画出来了", (await p.eval("T.ink()")) > 50);
    ok("没有异常", p.exceptions.length === 0, p.exceptions);
    d.kill();
    await closeAll(br, p);
  };

  G.P5_no_text_no_rebuild = async ({ br }) => {
    console.log("\n=== P5 画面上没有文字时，字体到达不重画");
    const code = await createRoom(2);
    const d = new NodeClient(code);
    await d.join("画手");
    await paintGrid(d, 60);
    await sleep(300);
    const p = await br.newPage();
    await joinViaUrl(p, code, ORIGIN, "观众");
    await sleep(2500);
    await p.eval("__long.length = 0");
    await p.eval(`document.fonts.dispatchEvent(new Event('loadingdone'))`);
    const long = await p.eval("(async()=>{await new Promise((r)=>setTimeout(r,600));return __long.slice();})()");
    ok("没有超过 100ms 的长任务", Math.max(0, ...long) < 100, long);
    d.kill();
    await closeAll(br, p);
  };

  G.P6_font_during_selection = async ({ br }) => {
    console.log("\n=== P6 框选悬浮时字体到了：不产生重影，提交后两端一致");
    const p1 = await br.newPage();
    p1.fontState.delayMs = 3500;
    await p1.goto(ORIGIN + "/");
    await p1.eval(`T.clickBtn('创建房间')`);
    await sleep(100);
    await p1.eval(`T.setInput(document.querySelector('input[type=text]'), '画手甲')`);
    await p1.eval(`T.clickBtn('3人')`);
    await sleep(50);
    await p1.eval(`T.clickBtn('确认创建')`);
    await p1.waitText("房间号", 6000);
    await sleep(200);
    const code = await p1.eval(`location.pathname.slice(1)`);
    const p2 = await br.newPage();
    p2.fontState.delayMs = 3500;
    await joinViaUrl(p2, code, ORIGIN, "猜手乙");
    await sleep(200);
    // 文字 + 框选文字附近并悬浮
    await p1.eval(`(async()=>{T.clickBtn('文本');await T.raf(2);T.canvasClick(0.1,0.1);await T.raf(3);T.setInput(document.querySelector('textarea'),'Hello World');await T.raf(2);T.commit();await T.raf(2);T.clickBtn('选择 / 框选');await T.raf(2);await T.drag([0.05,0.05],[0.6,0.4]);await T.raf(3);})()`);
    ok("框选悬浮中", await hasOverlay(p1));
    // 等字体到（样式表 3.5 秒，加上字体加载）
    await sleep(4500);
    ok("字体到了之后框选还悬浮着", await hasOverlay(p1));
    await p1.eval(`(async()=>{const o=document.querySelector('[data-selection-overlay]');const r=o.getBoundingClientRect();T.fire(o,'mousedown',r.left+20,r.top+20);await T.raf(2);window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+50,clientY:r.top+220,bubbles:true}));await T.raf(2);window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await T.raf(2);T.commit();await T.raf(2);})()`);
    const r = await sameOff([p1, p2]);
    ok("提交后两端一致", r.same, r.hashes);
    const p3 = await br.newPage();
    await joinViaUrl(p3, code, ORIGIN, "后来者");
    await sleep(800);
    const r2 = await sameOff([p1, p3]);
    ok("和全量重放也一致", r2.same, r2.hashes);
    await closeAll(br, p1, p2, p3);
  };

  // 分包相关的测试用单独的静态服务（端口 4176），可以把房间页的 chunk 弄坏。
  const roomChunk = () => {
    const dir = path.join(scratch, buildDir, "assets");
    return fs.readdirSync(dir).find((f) => /^Room-.*\.js$/.test(f));
  };
  let chunkPort = 4176;
  const chunkServer = async (hook) => {
    const port = chunkPort++;
    const srv = await serveStatic(path.join(scratch, buildDir), port, { hook });
    const close = srv.close.bind(srv);
    srv.close = () => {
      srv.closeAllConnections();
      return close();
    };
    return { srv, origin: `http://localhost:${port}` };
  };
  const serveHtml = (res) => {
    // 和 Pages 的 SPA 回退一样：不存在的文件返回 index.html
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(path.join(scratch, buildDir, "index.html")).pipe(res);
    return true;
  };

  G.P7_chunk_size = async () => {
    console.log("\n=== P7 分包：首页不下载画板代码");
    const dir = path.join(scratch, buildDir, "assets");
    const chunk = roomChunk();
    ok("房间页是单独的 chunk", !!chunk);
    if (chunk) {
      const main = fs.readdirSync(dir).find((f) => /^index-.*\.js$/.test(f));
      const [a, b] = [fs.statSync(path.join(dir, main)).size, fs.statSync(path.join(dir, chunk)).size];
      ok("房间页的代码占到相当比例", b > 80 * 1024, { main: a, room: b });
      ok("入口包比原来小（原来 305 KB）", a < 240 * 1024, a);
    }
    const bg = fs.readdirSync(dir).filter((f) => /^bg-/.test(f));
    const size = bg.length ? fs.statSync(path.join(dir, bg[0])).size : Infinity;
    ok("背景图小于 60 KB（原来 412 KB）", size < 60 * 1024, { bg, size });
  };

  G.P8_chunk_slow = async ({ br }) => {
    console.log("\n=== P8 房间页 chunk 下载慢：首页不受影响，进房间先显示加载状态");
    if (!roomChunk()) {
      ok("有房间页 chunk", false);
      return;
    }
    const { srv, origin: CHUNK_ORIGIN } = await chunkServer(async (req, res, u) => {
      if (/\/assets\/Room-/.test(u)) {
        await sleep(3000);
      }
      return false;
    });
    const p = await br.newPage();
    await p.goto(CHUNK_ORIGIN + "/", false);
    await sleep(700);
    const fcp = await fcpOf(p);
    ok("首屏不等房间页 chunk", fcp > 0 && fcp < 1000, fcp);
    await p.eval(`T.clickBtn('创建房间')`);
    await sleep(100);
    await p.eval(`T.setInput(document.querySelector('input[type=text]'), '画手')`);
    await p.eval(`T.clickBtn('确认创建')`);
    const splash = await until(() => p.eval(`T.text().includes('连接中')`), 1500, 50);
    ok("先显示加载状态，不是白屏", splash);
    ok("代码到了之后进入房间", await p.waitText("房间号", 8000));
    srv.close();
    await closeAll(br, p);
  };

  G.P9_chunk_gone_once = async ({ br }) => {
    console.log("\n=== P9 发版后旧 chunk 没了：自动刷新一次，拿到新版本");
    if (!roomChunk()) {
      ok("有房间页 chunk", false);
      return;
    }
    let broken = true;
    const { srv, origin: CHUNK_ORIGIN } = await chunkServer(async (req, res, u) => {
      if (/\/assets\/Room-/.test(u) && broken) {
        return serveHtml(res);
      }
      return false;
    });
    const p = await br.newPage();
    await p.goto(CHUNK_ORIGIN + "/");
    await sleep(500);
    await p.eval(`T.clickBtn('创建房间')`);
    await sleep(100);
    await p.eval(`T.setInput(document.querySelector('input[type=text]'), '画手')`);
    // 模拟：刷新之后服务端已经是新版本
    let navigated = 0;
    p.handlers["Page.frameNavigated"] = () => {
      navigated++;
      broken = false;
    };
    await p.eval(`T.clickBtn('确认创建')`);
    const reloaded = await until(async () => navigated > 0, 5000, 50);
    ok("自动刷新了一次", reloaded);
    await sleep(800);
    const modal = await until(() => p.eval(`T.text().includes('进入房间')`), 5000);
    ok("刷新后回到昵称确认", modal);
    ok("刷新后昵称还是刚才输入的", (await p.eval(`document.querySelector('input[type=text]').value`)) === "画手", await p.eval(`document.querySelector('input[type=text]').value`));
    await p.eval(`T.clickBtn('进入房间')`);
    ok("能进入房间", await p.waitText("房间号", 6000));
    ok("没有再刷新", navigated === 1, navigated);
    ok("标记清掉了", (await p.eval(`sessionStorage.getItem('draw-guess-chunk-reload')`)) === null);
    srv.close();
    await closeAll(br, p);
  };

  G.P10_chunk_gone_forever = async ({ br }) => {
    console.log("\n=== P10 chunk 一直下载失败：显示提示，不会无限刷新");
    if (!roomChunk()) {
      ok("有房间页 chunk", false);
      return;
    }
    const { srv, origin: CHUNK_ORIGIN } = await chunkServer(async (req, res, u) => (/\/assets\/Room-/.test(u) ? serveHtml(res) : false));
    const p = await br.newPage();
    let navigated = 0;
    p.handlers["Page.frameNavigated"] = () => navigated++;
    await p.goto(CHUNK_ORIGIN + "/");
    await sleep(500);
    navigated = 0;
    await p.eval(`T.clickBtn('创建房间')`);
    await sleep(100);
    await p.eval(`T.setInput(document.querySelector('input[type=text]'), '画手')`);
    await p.eval(`T.clickBtn('确认创建')`);
    await until(async () => navigated > 0, 5000, 50);
    await sleep(800);
    await until(() => p.eval(`T.text().includes('进入房间')`), 5000);
    await p.eval(`T.clickBtn('进入房间')`);
    const shown = await until(() => p.eval(`T.text().includes('页面出错了')`), 4000);
    ok("显示错误提示和刷新按钮，不是白屏", shown && (await p.eval(`!!T.btn('刷新页面')`)));
    await sleep(2500);
    ok("只自动刷新了一次", navigated === 1, navigated);
    srv.close();
    await closeAll(br, p);
  };

  G.P11_chunk_offline = async ({ br }) => {
    console.log("\n=== P11 断网时 chunk 下载失败：不刷新（刷新只会看到浏览器的断网页），直接提示");
    if (!roomChunk()) {
      ok("有房间页 chunk", false);
      return;
    }
    const { srv, origin: CHUNK_ORIGIN } = await chunkServer(async (req, res, u) => (/\/assets\/Room-/.test(u) ? serveHtml(res) : false));
    const p = await br.newPage();
    let navigated = 0;
    p.handlers["Page.frameNavigated"] = () => navigated++;
    await p.goto(CHUNK_ORIGIN + "/");
    await sleep(500);
    navigated = 0;
    await p.eval(`T.clickBtn('加入房间')`);
    await sleep(100);
    await p.eval(`T.setInput(document.querySelectorAll('input[type=text]')[0], '猜手')`);
    await p.eval(`T.setInput(document.querySelectorAll('input[type=text]')[1], '123456')`);
    await p.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(100);
    await p.eval(`T.clickBtn('确认加入')`);
    const shown = await until(() => p.eval(`T.text().includes('页面出错了')`), 4000);
    ok("显示错误提示", shown, await p.eval("T.text().slice(0,80)"));
    ok("没有自动刷新", navigated === 0, navigated);
    await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    srv.close();
    await closeAll(br, p);
  };

  // 模拟 Pages 的 _headers：测试包连本地 API，connect-src 要放开本地端口，其余按原样。
  function parseHeaders(file) {
    const rules = [];
    let cur = null;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith("#")) {
        continue;
      }
      if (!/^\s/.test(raw)) {
        cur = { path: raw.trim(), headers: {} };
        rules.push(cur);
      } else {
        const i = raw.indexOf(":");
        cur.headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
      }
    }
    return rules;
  }
  function headersFor(rules, url, patchCsp) {
    const out = {};
    for (const r of rules) {
      const re = new RegExp("^" + r.path.replace(/\*/g, ".*") + "$");
      if (re.test(url)) {
        Object.assign(out, r.headers);
      }
    }
    if (out["Content-Security-Policy"] && patchCsp) {
      out["Content-Security-Policy"] = patchCsp(out["Content-Security-Policy"]);
    }
    return out;
  }

  G.H1_headers = async ({ br }) => {
    console.log("\n=== H1 安全响应头：完整流程没有 CSP 违规");
    const file = path.join(scratch, buildDir, "_headers");
    const exists = fs.existsSync(file);
    ok("构建产物里有 _headers", exists);
    if (!exists) {
      return;
    }
    const rules = parseHeaders(file);
    const patch = (csp) => csp.replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:8788 ws://127.0.0.1:8788");
    const srv = await serveStatic(path.join(scratch, buildDir), 4177, { headers: (u) => headersFor(rules, u, patch) });
    const CSP_ORIGIN = "http://localhost:4177";
    const asset = fs.readdirSync(path.join(scratch, buildDir, "assets")).find((f) => /^index-.*\.js$/.test(f));
    const res = await fetch(`${CSP_ORIGIN}/assets/${asset}`);
    // 不存在的资源会回退成 index.html（Pages 的 SPA 回退），这时不能带长缓存，否则 HTML 会被当成 JS 缓存下来
    const missing = await fetch(`${CSP_ORIGIN}/assets/Room-missing123.js`);
    ok("回退的 HTML 不会被长期缓存", !/immutable|max-age=[1-9]\d{4,}/.test(missing.headers.get("cache-control") || ""), missing.headers.get("cache-control"));
    void res;
    const html = await fetch(`${CSP_ORIGIN}/`);
    ok("HTML 不是 immutable", !/immutable/.test(html.headers.get("cache-control") || ""), html.headers.get("cache-control"));
    ok("HTML 带 CSP 和防嵌入", /frame-ancestors 'none'/.test(html.headers.get("content-security-policy") || "") && html.headers.get("x-frame-options") === "DENY");
    ok("HTML 带 HSTS 和 nosniff", /max-age=\d+/.test(html.headers.get("strict-transport-security") || "") && html.headers.get("x-content-type-options") === "nosniff");

    const p1 = await br.newPage();
    await p1.goto(CSP_ORIGIN + "/");
    await sleep(600);
    const bg = await p1.eval(`(async()=>{const el=[...document.querySelectorAll('div')].find(d=>getComputedStyle(d).backgroundImage.includes('bg-'));if(!el)return 'no-bg';const u=getComputedStyle(el).backgroundImage.slice(5,-2);return await new Promise((r)=>{const i=new Image();i.onload=()=>r('ok');i.onerror=()=>r('fail');i.src=u;});})()`);
    ok("背景图加载正常", bg === "ok", bg);
    const color = await p1.eval(`getComputedStyle(T.btn('创建房间')).backgroundColor`);
    ok("Twind 样式生效", color === "rgb(0, 102, 204)", color);
    await p1.eval(`T.clickBtn('创建房间')`);
    await sleep(100);
    await p1.eval(`T.setInput(document.querySelector('input[type=text]'), '画手')`);
    await p1.eval(`T.clickBtn('确认创建')`);
    ok("能建房进房", await p1.waitText("房间号", 6000));
    await sleep(300);
    const code = await p1.eval(`location.pathname.slice(1)`);
    const p2 = await br.newPage();
    await joinViaUrl(p2, code, CSP_ORIGIN, "猜手");
    await sleep(300);
    await p1.eval(`(async()=>{await T.stroke([[0.1,0.1],[0.3,0.3]]);T.clickBtn('矩形');await T.raf(2);await T.drag([0.4,0.1],[0.6,0.4]);await T.raf(2);T.commit();await T.raf(2);T.clickBtn('油漆桶');await T.raf(2);T.canvasClick(0.5,0.25);await T.raf(2);T.clickBtn('文本');await T.raf(2);T.canvasClick(0.65,0.15);await T.raf(3);T.setInput(document.querySelector('textarea'),'Hello');await T.raf(2);T.commit();await T.raf(3);T.clickBtn('画笔');await T.raf(3);})()`);
    await sleep(500);
    const r = await sameOff([p1, p2]);
    ok("实时同步正常", r.same, r.hashes);
    ok("字体样式表加载了", await p1.eval(`[...document.styleSheets].some(s=>(s.href||'').includes('hand.css'))`));
    const v = [await p1.eval("__csp"), await p2.eval("__csp")];
    ok("没有 CSP 违规", v[0].length + v[1].length === 0, v);
    ok("没有异常", p1.exceptions.length + p2.exceptions.length === 0, [p1.exceptions, p2.exceptions]);
    srv.close();
    await closeAll(br, p1, p2);
  };

  return G;
}

module.exports = { loadGroups, mockFonts };
