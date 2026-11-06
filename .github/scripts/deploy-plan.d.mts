// deploy-plan.mjs 的类型，给单测用。
export type Target = "worker" | "pages";

export declare const DEPLOY_JOBS: Record<Target, string>;

export interface PlanInput {
  event: string;
  head: string;
  prBase?: string;
  /** 这个部署 job 上一次成功时的提交；没有就是 null */
  lastDeployed: (job: string) => Promise<string | null>;
  /** base..head 之间改过的文件；比较不了时返回 null */
  changedFiles: (base: string, head: string) => string[] | null;
}

export declare function touches(target: Target, file: string): boolean;
export declare function plan(input: PlanInput): Promise<Record<Target, boolean>>;
