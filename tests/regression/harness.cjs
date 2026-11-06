// 浏览器测试基础设施：静态服务（带 SPA 回退）、可注入延迟/断连的 TCP 代理、无头 Edge + CDP 客户端、Node 协议客户端。
// 全部只访问本机；浏览器使用临时目录下的独立 profile，不影响正在用的浏览器。
const WS = require("ws");
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser } = require("./env.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "http://localhost:4173";
const PROXY_PORT = 8788;
const WORKER_PORT = 8787;

// ---------- 静态服务 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css" };
// opts.hook(req, res, url)：返回 true 表示已经处理；opts.headers(url)：额外的响应头（模拟 Pages 的 _headers）。
function serveStatic(dir, port, opts = {}) {
  const srv = http.createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (opts.hook && (await opts.hook(req, res, u))) {
      return;
    }
    let f = path.join(dir, u);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      f = path.join(dir, "index.html");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", ...(opts.headers ? opts.headers(u) : {}) });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

// ---------- TCP 代理 ----------
class Proxy {
  constructor() {
    this.delay = 0;
    this.delayDown = 0;
    this.refuse = false;
    this.stall = false;
    this.stalled = new Set();
    this.pairs = new Set();
  }
  start() {
    this.srv = net.createServer((c) => {
      if (this.refuse) {
        c.destroy();
        return;
      }
      // 握手卡住：接受 TCP 但不转发（模拟切 VPN / 代理节点）
      if (this.stall) {
        c.on("error", () => {});
        this.stalled.add(c);
        return;
      }
      const u = net.connect(WORKER_PORT, "127.0.0.1");
      const pair = { c, u, dead: false };
      this.pairs.add(pair);
      const fwd = (from, to, extraDelay) => {
        from.on("data", (d) => {
          if (pair.dead) {
            return;
          }
          const delay = this.delay + extraDelay();
          if (delay > 0) {
            setTimeout(() => !to.destroyed && to.write(d), delay);
          } else {
            to.write(d);
          }
        });
      };
      fwd(c, u, () => 0);
      fwd(u, c, () => this.delayDown); // 只拖慢下行：模拟大帧下载时后面的消息被堵住
      const done = () => {
        this.pairs.delete(pair);
        c.destroy();
        u.destroy();
      };
      c.on("close", done);
      u.on("close", done);
      c.on("error", done);
      u.on("error", done);
    });
    return new Promise((r) => this.srv.listen(PROXY_PORT, "127.0.0.1", r));
  }
  // 现有连接变成半开：TCP 不断，但数据都丢掉。新连接不受影响。
  blackholeExisting() {
    for (const pair of this.pairs) {
      pair.dead = true;
    }
  }
  killAll() {
    for (const { c, u } of this.pairs) {
      c.destroy();
      u.destroy();
    }
    this.pairs.clear();
  }
  stop() {
    this.killAll();
    for (const c of this.stalled) {
      c.destroy();
    }
    this.srv.close();
  }
}

// ---------- CDP ----------
const INIT = `(() => {
  const OW = window.WebSocket;
  window.__ws = { created: 0, instances: [], sent: [], closes: [], recv: 0 };
  window.WebSocket = class extends OW {
    constructor(...a) {
      super(...a);
      __ws.created++;
      __ws.instances.push(this);
      this.addEventListener('close', (e) => __ws.closes.push({ code: e.code, reason: e.reason, t: Math.round(performance.now()) }));
      this.addEventListener('message', () => __ws.recv++);
      const s = this.send.bind(this);
      this.send = (d) => {
        __ws.sent.push(typeof d === 'string' ? d.slice(0, 70) : '[bin]');
        if (__ws.sent.length > 8000) __ws.sent.shift();
        s(d);
      };
    }
  };
  window.__canvases = [];
  const origCreate = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    const el = origCreate(tag, ...rest);
    if (String(tag).toLowerCase() === 'canvas') { __canvases.push(el); }
    return el;
  };
  window.__commits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false, supportsFiber: true, renderers: new Map(),
    inject() { return 1; },
    onCommitFiberRoot() { window.__commits++; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, checkDCE() {},
  };
  window.__long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) __long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch {}
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => __csp.push(e.violatedDirective + ' ' + e.blockedURI));
  window.__errs = [];
  window.addEventListener('error', (e) => __errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => __errs.push('rejection: ' + String(e.reason)));

  // 页面内工具
  window.T = {
    cv() { return [...document.querySelectorAll('canvas')].filter((c) => getComputedStyle(c).position !== 'fixed').sort((a, b) => b.width - a.width)[0]; },
    btn(t) { const all = [...document.querySelectorAll('button')]; return all.find((b) => b.title === t) || all.find((b) => b.innerText.trim() === t) || all.find((b) => b.innerText.includes(t)); },
    fire(el, type, x, y, extra = {}) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1, ...extra }));
    },
    click(el) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      this.fire(el, 'mousedown', x, y); this.fire(el, 'mouseup', x, y); this.fire(el, 'click', x, y);
    },
    clickBtn(t) { const b = this.btn(t); if (!b) throw new Error('no button ' + t); this.click(b); },
    pt(nx, ny) { const r = this.cv().getBoundingClientRect(); return [r.left + nx * r.width, r.top + ny * r.height]; },
    async raf(n = 1) { for (let i = 0; i < n; i++) await new Promise((r) => { const t = setTimeout(r, 40); requestAnimationFrame(() => { clearTimeout(t); r(); }); }); },
    async stroke(pts) {
      const c = this.cv();
      const [x0, y0] = this.pt(...pts[0]);
      this.fire(c, 'mousedown', x0, y0);
      for (const p of pts.slice(1)) { const [x, y] = this.pt(...p); this.fire(c, 'mousemove', x, y); await this.raf(); }
      const [xn, yn] = this.pt(...pts[pts.length - 1]);
      this.fire(c, 'mouseup', xn, yn);
      await this.raf();
    },
    async drag(a, b) { await this.stroke([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b]); },
    canvasClick(nx, ny) { const c = this.cv(); const [x, y] = this.pt(nx, ny); this.fire(c, 'mousedown', x, y); this.fire(c, 'mouseup', x, y); this.fire(c, 'click', x, y); },
    commit() { const b = document.body; this.fire(b, 'mousedown', 2, 2); this.fire(b, 'mouseup', 2, 2); this.fire(b, 'click', 2, 2); },
    setInput(el, v) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    enter(el) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); },
    chat(text) { const i = document.querySelector('input[type=text]'); this.setInput(i, text); this.enter(i); },
    sig(N = 64, M = 38) {
      const c = this.cv(); const t = document.createElement('canvas'); t.width = N; t.height = M;
      const x = t.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, N, M); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, N, M);
      return Array.from(x.getImageData(0, 0, N, M).data);
    },
    ink() {
      const c = this.cv(); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a > 10 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) n++; }
      return n;
    },
    text() { return document.body.innerText; },
    // 离屏画布：页面第一张 1600×960 的 canvas（后面同尺寸的是检查点快照）
    off() { return __canvases.find((c) => c.width === 1600 && c.height === 960) || null; },
    hashOf(c) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
      return c.width + 'x' + c.height + ':' + (h >>> 0).toString(16);
    },
    offHash() { const c = this.off(); return c ? this.hashOf(c) : 'no-offscreen'; },
    visHash() { return this.hashOf(this.cv()); },
    offInk() {
      const c = this.off(); if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++; }
      return n;
    },
  };
})();`;

class Page {
  constructor(sock, id) {
    this.sock = sock;
    this.id = id;
    this.seq = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.console = [];
    this.handlers = {};
    sock.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) {
          rej(new Error(m.error.message));
        } else {
          res(m.result);
        }
        return;
      }
      if (m.method === "Runtime.exceptionThrown") {
        const d0 = m.params.exceptionDetails;
        this.exceptions.push((d0.exception && d0.exception.description ? d0.exception.description : d0.text).split("\n")[0]);
      } else if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
        this.console.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
      }
      const h = this.handlers[m.method];
      if (h) {
        h(m.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error("CDP timeout " + method));
        }
      }, 45000);
    });
  }
  async init() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Performance.enable");
    await this.send("Network.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
  }
  async goto(url, waitLoad = true) {
    const loaded = new Promise((r) => (this.handlers["Page.loadEventFired"] = r));
    await this.send("Page.navigate", { url });
    if (waitLoad) {
      await Promise.race([loaded, sleep(20000)]);
    }
    await sleep(300);
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  }
  async metrics() {
    const r = await this.send("Performance.getMetrics");
    const m = {};
    for (const x of r.metrics) {
      m[x.name] = x.value;
    }
    return m;
  }
  async waitText(t, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval(`document.body.innerText.includes(${JSON.stringify(t)})`)) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }
  close() {
    this.sock.close();
  }
}

class Browser {
  async start(scratch, extraArgs = []) {
    this.port = 9333;
    const exe = findBrowser();
    this.proc = spawn(
      exe,
      [
        "--headless=new",
        ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${path.join(scratch, "edge-profile")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-features=CalculateNativeWinOcclusion,msEdgeSidebarV2",
        "--window-size=1400,900",
        ...extraArgs,
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    for (let i = 0; i < 80; i++) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
        this.wsUrl = v.webSocketDebuggerUrl;
        this.version = v.Browser;
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!this.wsUrl) {
      throw new Error("Edge 未能启动");
    }
    this.b = new Page(await this._connect(this.wsUrl), "browser");
    return this;
  }
  _connect(url) {
    return new Promise((res, rej) => {
      const s = new WS(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      s.on("open", () => res(s));
      s.on("error", rej);
    });
  }
  async newPage() {
    const { targetId } = await this.b.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
    const t = list.find((x) => x.id === targetId);
    const p = new Page(await this._connect(t.webSocketDebuggerUrl), targetId);
    await p.init();
    return p;
  }
  async stop() {
    try {
      await this.b.send("Browser.close");
    } catch {}
    await sleep(300);
    try {
      this.proc.kill();
    } catch {}
  }
}

// ---------- Node 协议客户端（经代理或直连 worker） ----------
class NodeClient {
  constructor(code, port = WORKER_PORT) {
    this.code = code;
    this.port = port;
    this.msgs = [];
    this.waiters = [];
    this.closed = null;
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WS(`ws://127.0.0.1:${this.port}/api/rooms/${this.code}/ws`, { origin: ORIGIN, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on("open", res);
      this.ws.on("error", rej);
      this.ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        this.msgs.push(m);
        if (this.msgs.length > 2000) {
          this.msgs.shift();
        }
        this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
      });
      this.ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason) }));
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  waitFor(pred, ms = 4000) {
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
  // token：新客户端自己生成并带上。不传就是旧客户端的 join。
  async join(name, playerId, token) {
    // 先清再连：不存在的房间在连接打开时就会收到 error
    this.msgs = [];
    if (!this.ws) {
      await this.open();
    }
    this.token = token;
    this.send({ type: "join", playerName: name, v: 1, ...(playerId ? { playerId } : {}), ...(token ? { playerToken: token } : {}) });
    const m = await this.waitFor((x) => x.type === "roomState" || x.type === "error", 5000);
    if (m?.type === "roomState") {
      this.me = m.yourId;
    }
    return m;
  }
  kill() {
    this.ws.terminate();
  }
}
async function createRoom(max = 2) {
  const r = await fetch(`http://127.0.0.1:${WORKER_PORT}/api/rooms?max=${max}`, { method: "POST", headers: { Origin: ORIGIN } });
  return (await r.json()).roomCode;
}

// 浏览器内进入房间（昵称弹窗路径）
async function joinViaUrl(page, code, base = ORIGIN, name) {
  await page.goto(`${base}/${code}`);
  await page.waitText("进入房间", 5000);
  if (name) {
    await page.eval(`T.setInput(document.querySelector('input[type=text]'), ${JSON.stringify(name)})`);
  }
  await page.eval(`T.clickBtn('进入房间')`);
  await page.eval(`new Promise((res) => { const t0 = Date.now(); const i = setInterval(() => { if (document.querySelector('canvas') || Date.now() - t0 > 8000) { clearInterval(i); res(); } }, 50); })`);
  await sleep(200);
}

function diffSig(a, b) {
  let max = 0;
  let cnt = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) {
      max = d;
    }
    if (d > 32) {
      cnt++;
    }
  }
  return { max, cnt };
}

module.exports = { sleep, serveStatic, Proxy, Browser, NodeClient, createRoom, joinViaUrl, diffSig, ORIGIN, PROXY_PORT, WORKER_PORT };
