// Eval harness types. Each task carries a programmatic/objective check:
//   code     - hidden node test (deterministic pass count);
//   design   - locked rubric, each item checked strictly yes/no;
//   incident - known root cause, confident-wrong diagnoses penalized.

import type { SubCallClient } from "../src/llm.ts";

export type Bucket = "design" | "code" | "incident";

export interface TaskScore {
  /** 0..1 */
  score: number;
  /** Human-readable scoring breakdown for the report. */
  detail: string;
  /** Incident bucket: diagnosis named a wrong root cause with high confidence. */
  confidentlyWrong?: boolean;
}

export interface ScoreContext {
  /** Cheap LLM checks (rubric items, root-cause matching) - worker role. */
  client: SubCallClient;
  execTimeoutMs: number;
}

export interface EvalTask {
  id: string;
  bucket: Bucket;
  /** The prompt given identically to baseline and pipeline. */
  prompt: string;
  score(answer: string, ctx: ScoreContext): Promise<TaskScore>;
}

export interface ArmResult {
  answer: string;
  score: TaskScore;
  wallMs: number;
  subCalls: number;
  costUsd: number;
  error?: string;
}

export interface TaskResult {
  task: string;
  bucket: Bucket;
  baseline: ArmResult;
  pipeline: ArmResult;
}
