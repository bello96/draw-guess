// 回归测试入口：node tests/regression/run.cjs protocol|browser [脚本名正则]
// 自动起停本地 Worker，浏览器测试先构建测试包。退出码 = 失败的脚本数。
const { spawnSync } = require("child_process");
const path = require("path");
const worker = require("./worker-ctl.cjs");

const SUITES = {
  // protocol-crash 会杀掉并重启 8787，放在最后
  protocol: ["protocol-batch1.cjs", "protocol-batch2.cjs", "protocol-batch3.cjs", "protocol-crash.cjs"],
  browser: ["browser-batch3.cjs", "browser-batch2.cjs", "browser-batch1.cjs"],
};

(async () => {
  const suite = process.argv[2];
  const only = process.argv[3] ? new RegExp(process.argv[3]) : null;
  const scripts = (SUITES[suite] || []).filter((s) => !only || only.test(s));
  if (scripts.length === 0) {
    console.error("用法：node tests/regression/run.cjs protocol|browser [脚本名正则]");
    process.exit(2);
  }
  if (suite === "browser") {
    const built = spawnSync(process.execPath, [path.join(__dirname, "build-client.mjs")], { stdio: "inherit" });
    if (built.status !== 0) {
      process.exit(1);
    }
  }
  let failed = 0;
  await worker.start();
  try {
    for (const script of scripts) {
      console.log(`\n########## ${script}`);
      const r = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: "inherit" });
      if (r.status !== 0) {
        failed++;
        console.log(`########## ${script} 失败，退出码 ${r.status}`);
      }
    }
  } finally {
    worker.stop();
  }
  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 个脚本失败`);
  process.exit(failed);
})().catch((e) => {
  console.error(e);
  worker.stop();
  process.exit(1);
});
