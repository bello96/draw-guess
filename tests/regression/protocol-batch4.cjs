// 第四批服务端改动的断言式回归：猜词阶段猜词方在聊天里打出答案，按猜测处理。
// 用本地 8787 的 Worker（run.cjs 会起）。退出码 = 失败条数。
const { sleep, NodeClient, createRoom } = require("./harness.cjs");

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
let seq = 0;
const token = () => `b4-${Date.now()}-${++seq}`;

// 画手 + 两个猜词方，画手设好答案、进入猜词阶段
async function guessingRoom(answer = "苹果") {
  const code = await createRoom(4);
  const d = new NodeClient(code);
  await d.join("画手", undefined, token());
  const g = new NodeClient(code);
  await g.join("猜手", undefined, token());
  const o = new NodeClient(code);
  await o.join("旁观", undefined, token());
  d.send({ type: "setAnswer", answer });
  const ph = await o.waitFor((m) => m.type === "phaseChange" && m.phase === "guessing", 3000);
  return { code, d, g, o, ready: !!ph };
}
const killAll = (...cs) => cs.forEach((c) => c.kill());
const chatsWith = (c, text) => c.msgs.filter((m) => m.type === "chat" && m.text.includes(text));

const G = {};

G.X1_chat_answer_becomes_guess = async () => {
  console.log("\n=== X1 猜词阶段猜词方在聊天里打出答案：按猜测处理，不当聊天广播");
  const { code, d, g, o, ready } = await guessingRoom();
  ok("进入猜词阶段", ready);
  o.msgs = [];
  d.msgs = [];
  g.send({ type: "chat", text: " 苹果！" });
  const r = await o.waitFor((m) => m.type === "guessResult", 2000);
  ok("其他人收到的是猜测结果，判对", !!r && r.correct === true && r.playerId === g.me, r);
  ok("进入揭晓阶段", !!(await o.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed", 2000)));
  await sleep(300);
  ok("没有当聊天广播", chatsWith(o, "苹果").length === 0 && chatsWith(d, "苹果").length === 0, o.msgs.map((m) => m.type));
  const late = new NodeClient(code);
  const rs = await late.join("后来的", undefined, token());
  const last = rs?.chatHistory?.at(-1);
  ok("聊天记录里记成猜测", !!last && last.kind === "guess" && last.correct === true && last.playerId === g.me, last);
  ok("聊天记录里没有这条聊天", !(rs?.chatHistory || []).some((e) => e.kind === "chat" && e.text.includes("苹果")));
  killAll(d, g, o, late);
};

G.X2_other_chat_untouched = async () => {
  console.log("\n=== X2 其余聊天照常：和答案不一致、画手发的、不在猜词阶段");
  const { d, g, o, ready } = await guessingRoom();
  ok("进入猜词阶段", ready);
  o.msgs = [];
  g.send({ type: "chat", text: "是水果吗" });
  ok("猜词方发别的内容：照常是聊天", !!(await o.waitFor((m) => m.type === "chat" && m.text === "是水果吗", 2000)));
  g.send({ type: "chat", text: "是苹果吗" });
  ok("只是包含答案：照常是聊天", !!(await o.waitFor((m) => m.type === "chat" && m.text === "是苹果吗", 2000)));
  d.send({ type: "chat", text: "苹果" });
  ok("画手发答案：照常是聊天", !!(await o.waitFor((m) => m.type === "chat" && m.text === "苹果" && m.playerId === d.me, 2000)));
  await sleep(200);
  ok("这些都没有判成猜测", !o.msgs.some((m) => m.type === "guessResult"), o.msgs.map((m) => m.type));
  ok("还在猜词阶段", !o.msgs.some((m) => m.type === "phaseChange"));

  // 揭晓之后说出答案：已经公开了，照常是聊天
  g.send({ type: "guess", text: "苹果" });
  await o.waitFor((m) => m.type === "phaseChange" && m.phase === "revealed", 2000);
  o.msgs = [];
  g.send({ type: "chat", text: "苹果" });
  ok("揭晓阶段说答案：照常是聊天", !!(await o.waitFor((m) => m.type === "chat" && m.text === "苹果", 2000)));
  ok("揭晓阶段没有再判猜测", !o.msgs.some((m) => m.type === "guessResult"));
  killAll(d, g, o);
};

(async () => {
  const filter = new RegExp(process.argv[2] || ".");
  for (const [k, fn] of Object.entries(G)) {
    if (!filter.test(k)) {
      continue;
    }
    try {
      await fn();
    } catch (e) {
      fail++;
      console.log(`   ✗   ${k} 脚本异常:`, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
    }
  }
  console.log(`\n合计 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}`);
  process.exit(fail);
})().catch((e) => {
  console.log("致命错误", e);
  process.exit(99);
});
