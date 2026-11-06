// 决定这次 CI 要部署什么，结果写进 GITHUB_OUTPUT（worker=true/false、pages=true/false）。
//
// push：和“这个目标上一次部署成功的提交”比，而不是只看这次 push 的差异。上一次检查没过、
// 部署失败、被取消或者排队时被挤掉，它的改动都会算进这一次，不会永远漏掉。
// 比较不了（第一次跑、历史被改写、查询出错）就都部署：多部署一次没关系，漏掉不行。
// PR：只看和目标分支的差异，决定要不要跑浏览器回归，不部署。
// 手动触发：都部署。
//
// 运行：node .github/scripts/deploy-plan.mjs。类型声明在 deploy-plan.d.mts（给单测用）。
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// 和 ci.yml 里部署 job 的 name 一致
export const DEPLOY_JOBS = {
  worker: "Deploy Worker",
  pages: "Deploy Pages",
};

/** 改了这个文件，要不要部署这个目标。 */
export function touches(target, file) {
  if (target === "worker") {
    return file.startsWith("worker/");
  }
  // 文档、测试和 CI 配置不影响前端产物
  return !/^(worker|tests|docs|\.github|\.claude)\//.test(file) && !file.endsWith(".md");
}

export async function plan(input) {
  const targets = ["worker", "pages"];
  const result = { worker: true, pages: true };
  if (input.event === "pull_request") {
    const files = input.prBase ? input.changedFiles(input.prBase, input.head) : null;
    if (files) {
      for (const t of targets) {
        result[t] = files.some((f) => touches(t, f));
      }
    }
    return result;
  }
  if (input.event !== "push") {
    return result;
  }
  for (const t of targets) {
    let base = null;
    try {
      base = await input.lastDeployed(DEPLOY_JOBS[t]);
    } catch (err) {
      console.log(`查不到 ${DEPLOY_JOBS[t]} 的部署记录，按需要部署处理：${String(err)}`);
    }
    const files = base ? input.changedFiles(base, input.head) : null;
    result[t] = files === null ? true : files.some((f) => touches(t, f));
    console.log(`${t}: 上次部署 ${base ?? "无"}，${files === null ? "比较不了" : `改了 ${files.length} 个文件`} → ${result[t]}`);
  }
  return result;
}

function gitChangedFiles(base, head) {
  try {
    execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" });
    const out = execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** 本工作流在 master 上最近一次这个 job 成功的运行，用它的提交。 */
async function lastDeployedOnGitHub(job) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    throw new Error("缺少 GITHUB_REPOSITORY 或 GITHUB_TOKEN");
  }
  const api = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`${path} → ${res.status}`);
    }
    return res.json();
  };
  const runs = await api("/actions/workflows/ci.yml/runs?branch=master&status=completed&per_page=50");
  for (const run of runs.workflow_runs) {
    const { jobs } = await api(`/actions/runs/${run.id}/jobs?per_page=100`);
    if (jobs.some((j) => j.name === job && j.conclusion === "success")) {
      return run.head_sha;
    }
  }
  return null;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const result = await plan({
    event: process.env.EVENT ?? "",
    head: process.env.GITHUB_SHA ?? "HEAD",
    prBase: process.env.PR_BASE || undefined,
    lastDeployed: lastDeployedOnGitHub,
    changedFiles: gitChangedFiles,
  });
  const lines = `worker=${result.worker}\npages=${result.pages}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, lines);
  }
  console.log(lines.trim());
}
