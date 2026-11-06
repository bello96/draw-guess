// 回归测试共用的路径和平台差异。测试只访问本机，不碰线上。
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const WORKER_DIR = path.join(REPO, "worker");
// 构建产物、浏览器 profile、DO 存储都放这里（已被 .gitignore 忽略）
const TMP = path.join(__dirname, ".tmp");
fs.mkdirSync(TMP, { recursive: true });

// 子进程环境。本机 VC++ 运行库过旧、workerd 起不来时，
// 设 MINIFLARE_WORKERD_PATH 指向带新版 DLL 的 workerd 副本，这里原样带过去。
const workerEnv = () => ({ ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" });

const wranglerBin = () => path.join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

/** 结束进程及其子进程。 */
function killTree(pid) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      // 子进程用 detached 启动，自成一个进程组
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 已经退出了
  }
}

/** 本项目起的 workerd 进程（按可执行文件路径认，别的项目的不动）。测试要模拟实例崩溃时用。 */
function workerdPids() {
  const owner = process.env.MINIFLARE_WORKERD_PATH || WORKER_DIR;
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `@(Get-Process workerd -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${owner}*' } | ForEach-Object { $_.Id }) -join ','`,
      ],
      { encoding: "utf8" },
    ).trim();
    return out ? out.split(",").map(Number) : [];
  }
  try {
    return execFileSync("pgrep", ["-f", `${owner}.*workerd`], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经退出了
  }
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) {
    throw new Error("找不到 Chromium 系浏览器，用 BROWSER_PATH 指定");
  }
  return found;
}

module.exports = { REPO, WORKER_DIR, TMP, workerEnv, wranglerBin, killTree, workerdPids, killPid, findBrowser };
