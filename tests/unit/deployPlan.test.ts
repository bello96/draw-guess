import { describe, expect, it } from "vitest";
import { plan, touches, type PlanInput } from "../../.github/scripts/deploy-plan.mjs";

// 提交历史：c1 → c2 → c3 → c4，每个提交改了哪些文件
const COMMITS = ["c1", "c2", "c3", "c4"];
const FILES: Record<string, string[]> = {
  c2: ["worker/src/room.ts", "src/App.tsx"],
  c3: ["README.md", "tests/unit/x.test.ts"],
  c4: ["src/pages/Home.tsx"],
};

function changedFiles(base: string, head: string): string[] | null {
  const from = COMMITS.indexOf(base);
  const to = COMMITS.indexOf(head);
  if (from === -1 || to === -1) {
    return null;
  }
  return COMMITS.slice(from + 1, to + 1).flatMap((c) => FILES[c] ?? []);
}

function input(overrides: Partial<PlanInput>): PlanInput {
  return {
    event: "push",
    head: "c4",
    lastDeployed: async () => "c3",
    changedFiles,
    ...overrides,
  };
}

describe("deploy plan", () => {
  it("和上次部署成功的提交比，只改了前端就只部署 Pages", async () => {
    expect(await plan(input({}))).toEqual({ worker: false, pages: true });
  });

  it("上次部署之后没部署成功的改动也算进来（检查没过、部署失败、被取消）", async () => {
    // Worker 最后一次部署成功停在 c1：c2 改的 Worker 没上线，这次要补上
    const lastDeployed = async (job: string) => (job === "Deploy Worker" ? "c1" : "c3");
    expect(await plan(input({ lastDeployed }))).toEqual({ worker: true, pages: true });
  });

  it("从来没部署成功过：都部署", async () => {
    expect(await plan(input({ lastDeployed: async () => null }))).toEqual({
      worker: true,
      pages: true,
    });
  });

  it("上次部署的提交不在历史里（强推改写了历史）：都部署", async () => {
    expect(await plan(input({ lastDeployed: async () => "gone" }))).toEqual({
      worker: true,
      pages: true,
    });
  });

  it("查询部署记录出错：都部署，宁可多部署也不漏", async () => {
    const lastDeployed = async () => {
      throw new Error("API 限流");
    };
    expect(await plan(input({ lastDeployed }))).toEqual({ worker: true, pages: true });
  });

  it("只改了文档和测试：都不部署", async () => {
    expect(await plan(input({ head: "c3", lastDeployed: async () => "c2" }))).toEqual({
      worker: false,
      pages: false,
    });
  });

  it("手动触发：都部署", async () => {
    expect(await plan(input({ event: "workflow_dispatch" }))).toEqual({
      worker: true,
      pages: true,
    });
  });

  it("PR 只看和目标分支的差异，不查部署记录", async () => {
    let asked = false;
    const lastDeployed = async () => {
      asked = true;
      return "c1";
    };
    expect(await plan(input({ event: "pull_request", prBase: "c2", lastDeployed }))).toEqual({
      worker: false,
      pages: true,
    });
    expect(asked).toBe(false);
  });
});

describe("touches", () => {
  it.each([
    ["worker/src/room.ts", true, false],
    ["worker/README.md", true, false],
    ["src/App.tsx", false, true],
    ["public/_headers", false, true],
    ["package.json", false, true],
    ["README.md", false, false],
    ["docs/plan.md", false, false],
    ["tests/regression/run.cjs", false, false],
    [".github/workflows/ci.yml", false, false],
    [".github/scripts/deploy-plan.ts", false, false],
  ])("%s → worker=%s pages=%s", (file, worker, pages) => {
    expect(touches("worker", file)).toBe(worker);
    expect(touches("pages", file)).toBe(pages);
  });
});
