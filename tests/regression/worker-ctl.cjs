// 本地 Worker 启停（只作用于 127.0.0.1:8787）。用法：node worker-ctl.cjs start|stop|restart|status
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { TMP, WORKER_DIR, workerEnv, wranglerBin, killTree } = require("./env.cjs");

const PORT = 8787;
const pidFile = path.join(TMP, "worker.pid");
const logFile = path.join(TMP, "worker.log");
const stateDir = path.join(TMP, "do-state");

function isUp() {
  return new Promise((res) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
  });
}

async function start() {
  if (await isUp()) {
    return;
  }
  const out = fs.openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [wranglerBin(), "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", stateDir, "--log-level", "info"],
    { cwd: WORKER_DIR, detached: true, stdio: ["ignore", out, out], windowsHide: true, env: workerEnv() },
  );
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 120; i++) {
    if (await isUp()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("本地 Worker 没起来，日志：\n" + fs.readFileSync(logFile, "utf8").slice(-2000));
}

function stop() {
  if (fs.existsSync(pidFile)) {
    killTree(Number(fs.readFileSync(pidFile, "utf8")));
    fs.unlinkSync(pidFile);
  }
}

module.exports = { start, stop, isUp, stateDir, PORT };

if (require.main === module) {
  (async () => {
    const cmd = process.argv[2];
    if (cmd === "start") {
      await start();
    } else if (cmd === "stop") {
      stop();
    } else if (cmd === "restart") {
      stop();
      await new Promise((r) => setTimeout(r, 1000));
      await start();
    } else {
      console.log("up:", await isUp());
    }
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
