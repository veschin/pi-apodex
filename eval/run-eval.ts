// Eval harness: every task runs two ways on the SAME engine -
//   baseline: one single-pass call (identical prompt/convention/params to the
//             pipeline's own generator role);
//   pipeline: the full apodex pipeline;
// then both answers are scored by the same programmatic check. Prints a summary
// table and persists JSON results.
//
// Baseline runs BASELINE_SAMPLES times (single-pass failure is a frequency,
// not a single draw); the pipeline runs once (it is the expensive arm).
//
// Usage:
//   npx tsx eval/run-eval.ts                 # full suite (9 tasks), pro engine
//   npx tsx eval/run-eval.ts --engine both   # pro + flash engines, two tables
//   npx tsx eval/run-eval.ts --smoke         # 1 task per bucket, lighter knobs
//   npx tsx eval/run-eval.ts --only retry    # filter by id substring
//   npx tsx eval/run-eval.ts --rounds 3 --candidates 3 --concurrency 2

import * as fs from "node:fs";
import * as path from "node:path";
import { Budget } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { SubCallClient } from "../src/llm.ts";
import { runApodex } from "../src/pipeline.ts";
import { generatorSystem, generatorUser } from "../src/prompts.ts";
import { RoleResolver } from "../src/roles.ts";
import { RunStore } from "../src/store.ts";
import type { ApodexConfig, TaskMode } from "../src/types.ts";
import { createStandaloneRegistry } from "./standalone.ts";
import { codeTasks } from "./tasks/code.ts";
import { designTasks } from "./tasks/design.ts";
import { incidentTasks } from "./tasks/incident.ts";
import type { ArmResult, Bucket, Engine, EvalTask, TaskResult } from "./types.ts";

/** Single-pass failure is a frequency; sample the cheap arm several times. */
const BASELINE_SAMPLES = 3;

interface CliArgs {
  smoke: boolean;
  only: string | null;
  rounds: number | null;
  candidates: number | null;
  concurrency: number;
  engines: Engine[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    smoke: false,
    only: null,
    rounds: null,
    candidates: null,
    concurrency: 2,
    engines: ["pro"],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--smoke") args.smoke = true;
    else if (arg === "--only") args.only = argv[++i] ?? null;
    else if (arg === "--rounds") args.rounds = Number(argv[++i]);
    else if (arg === "--candidates") args.candidates = Number(argv[++i]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--engine") {
      const value = argv[++i];
      if (value === "pro" || value === "flash") args.engines = [value];
      else if (value === "both") args.engines = ["pro", "flash"];
      else {
        console.error(`--engine must be pro | flash | both, got ${value}`);
        process.exit(2);
      }
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (args.rounds !== null && (!Number.isInteger(args.rounds) || args.rounds < 1 || args.rounds > 10)) {
    console.error("--rounds must be an integer 1..10");
    process.exit(2);
  }
  if (
    args.candidates !== null &&
    (!Number.isInteger(args.candidates) || args.candidates < 1 || args.candidates > 8)
  ) {
    console.error("--candidates must be an integer 1..8");
    process.exit(2);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 4) {
    console.error("--concurrency must be an integer 1..4");
    process.exit(2);
  }
  return args;
}

// The eval pins the same engine for both arms regardless of ambient config.
// "pro" = the strong engine in heavy roles; "flash" = the weak engine in heavy
// roles (where single-pass fails more often and verification has headroom -
// the Apodex paper's own GVR results show the largest gains on low-base tasks).
// The worker role is always flash: it runs judges/auditors/checkers, not
// generation, and is identical across arms.
function engineEnv(engine: Engine): NodeJS.ProcessEnv {
  const heavy = engine === "pro" ? "deepseek/deepseek-v4-pro" : "deepseek/deepseek-v4-flash";
  return {
    ...process.env,
    APODEX_GENERATOR: heavy,
    APODEX_GRADER: heavy,
    APODEX_VERIFIER: heavy,
    APODEX_WORKER: "deepseek/deepseek-v4-flash",
  };
}

function bucketToMode(bucket: Bucket): TaskMode {
  return bucket;
}

function evalConfig(
  args: CliArgs,
  engine: Engine,
  runsDir: string,
): { config: ApodexConfig; warnings: string[] } {
  const { config, warnings } = loadConfig({
    cwd: process.cwd(),
    env: engineEnv(engine),
    overrides: {
      ...(args.rounds !== null ? { rounds: args.rounds } : {}),
      ...(args.candidates !== null ? { candidates: args.candidates } : {}),
    },
  });
  if (args.smoke) {
    if (args.rounds === null) config.rounds = 2;
    if (args.candidates === null) config.candidates = 2;
  }
  // Eval-specific safety knobs: a single task may not eat the whole evening.
  // 20 min headroom: a rounds=4 design pipeline with one escalated-timeout
  // retry was observed to need > 15 min (run 20260611-155816, dedup-store).
  config.budget.maxWallTimeMs = Math.min(config.budget.maxWallTimeMs, 20 * 60_000);
  config.budget.maxCostUsd = Math.min(config.budget.maxCostUsd, 3);
  config.runsDir = runsDir;
  return { config, warnings };
}

async function runBaseline(
  task: EvalTask,
  config: ApodexConfig,
  registry: ReturnType<typeof createStandaloneRegistry>,
  runsDir: string,
): Promise<{ answer: string; wallMs: number; subCalls: number; costUsd: number; error?: string }> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const store = new RunStore(runsDir, RunStore.newRunId(`baseline-${task.id}`), (w) => warnings.push(w));
  const budget = new Budget({ ...config.budget, maxSubCalls: 4 });
  const resolver = new RoleResolver({ config, registry });
  const client = new SubCallClient({
    resolver,
    budget,
    store,
    timeoutMs: config.budget.subCallTimeoutMs,
    maxRetries: config.budget.subCallMaxRetries,
  });
  const mode = bucketToMode(task.bucket);
  const outcome = await client.call({
    role: "generator",
    label: "baseline.single-pass",
    systemPrompt: generatorSystem(mode),
    userText: generatorUser(task.prompt),
  });
  const snap = budget.snapshot();
  const base = { wallMs: Date.now() - t0, subCalls: snap.subCalls, costUsd: snap.costUsd };
  if (!outcome.ok) {
    return { ...base, answer: "", error: outcome.error ?? "baseline call failed" };
  }
  return { ...base, answer: outcome.text };
}

async function runPipelineArm(
  task: EvalTask,
  config: ApodexConfig,
  configWarnings: string[],
  registry: ReturnType<typeof createStandaloneRegistry>,
): Promise<{ answer: string; wallMs: number; subCalls: number; costUsd: number; error?: string }> {
  const t0 = Date.now();
  // Protocol pin: eval tasks are self-contained by design. The workspace
  // context stage would feed repository files absent from the baseline arm
  // (an uncontrolled confound), and the delivery planner adds calls without
  // touching the answer - both stay OFF so pipeline-vs-baseline isolates the
  // reasoning loop, comparable with the published runs.
  const pinnedConfig: ApodexConfig = {
    ...config,
    context: { ...config.context, enabled: false },
    delivery: { ...config.delivery, planEnabled: false },
  };
  try {
    const result = await runApodex({
      config: pinnedConfig,
      configWarnings,
      registry,
      task: task.prompt,
      mode: bucketToMode(task.bucket),
      cwd: process.cwd(),
      onProgress: (message) => console.error(`    [${task.id}] ${message}`),
    });
    return {
      answer: result.finalAnswer,
      wallMs: Date.now() - t0,
      subCalls: result.budget.subCalls,
      costUsd: result.budget.costUsd,
    };
  } catch (err) {
    return {
      answer: "",
      wallMs: Date.now() - t0,
      subCalls: 0,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function scoreAnswer(
  task: EvalTask,
  answer: string,
  config: ApodexConfig,
  registry: ReturnType<typeof createStandaloneRegistry>,
  runsDir: string,
  arm: string,
): Promise<ArmResult["score"]> {
  if (answer.trim() === "") {
    return { score: 0, detail: "empty answer (arm failed)" };
  }
  const warnings: string[] = [];
  const store = new RunStore(runsDir, RunStore.newRunId(`scoring-${arm}-${task.id}`), (w) => warnings.push(w));
  const budget = new Budget({ ...config.budget, maxSubCalls: 30, maxCostUsd: 0.5 });
  const resolver = new RoleResolver({ config, registry });
  const client = new SubCallClient({
    resolver,
    budget,
    store,
    timeoutMs: 120_000,
    maxRetries: 2,
  });
  return task.score(answer, { client, execTimeoutMs: 30_000 });
}

async function runTask(
  task: EvalTask,
  args: CliArgs,
  engine: Engine,
  registry: ReturnType<typeof createStandaloneRegistry>,
  runsDir: string,
): Promise<TaskResult> {
  const { config, warnings } = evalConfig(args, engine, runsDir);

  // Baseline: BASELINE_SAMPLES independent single-pass draws, mean score.
  const samples: ArmResult["score"][] = [];
  let baselineAnswer = "";
  let baselineWall = 0;
  let baselineCalls = 0;
  let baselineCost = 0;
  let baselineError: string | undefined;
  for (let s = 0; s < BASELINE_SAMPLES; s++) {
    console.error(`[${engine}:${task.id}] baseline sample ${s + 1}/${BASELINE_SAMPLES}...`);
    const raw = await runBaseline(task, config, registry, runsDir);
    baselineWall += raw.wallMs;
    baselineCalls += raw.subCalls;
    baselineCost += raw.costUsd;
    if (raw.error !== undefined) {
      baselineError = raw.error;
      samples.push({ score: 0, detail: `sample ${s + 1}: call failed (${raw.error})` });
      continue;
    }
    if (baselineAnswer === "") baselineAnswer = raw.answer; // keep first answer for audit
    const score = await scoreAnswer(task, raw.answer, config, registry, runsDir, `baseline-s${s + 1}`);
    samples.push(score);
  }
  const mean = samples.reduce((acc, s) => acc + s.score, 0) / Math.max(1, samples.length);
  const cwCount = samples.filter((s) => s.confidentlyWrong).length;
  const baselineScore: ArmResult["score"] = {
    score: mean,
    detail: `mean of ${samples.length} samples [${samples.map((s) => s.score.toFixed(2)).join(", ")}]${
      cwCount > 0 ? `; ${cwCount} confidently-wrong sample(s)` : ""
    }`,
    ...(cwCount * 2 > samples.length ? { confidentlyWrong: true } : {}),
  };

  console.error(`[${engine}:${task.id}] pipeline arm...`);
  const pipelineRaw = await runPipelineArm(task, config, warnings, registry);
  console.error(`[${engine}:${task.id}] pipeline done in ${Math.round(pipelineRaw.wallMs / 1000)}s; scoring...`);
  const pipelineScore = await scoreAnswer(task, pipelineRaw.answer, config, registry, runsDir, "pipeline");

  const baseline: ArmResult = {
    answer: baselineAnswer,
    score: baselineScore,
    samples,
    wallMs: baselineWall,
    subCalls: baselineCalls,
    costUsd: baselineCost,
    ...(baselineError !== undefined ? { error: baselineError } : {}),
  };
  const pipeline: ArmResult = {
    answer: pipelineRaw.answer,
    score: pipelineScore,
    wallMs: pipelineRaw.wallMs,
    subCalls: pipelineRaw.subCalls,
    costUsd: pipelineRaw.costUsd,
    ...(pipelineRaw.error !== undefined ? { error: pipelineRaw.error } : {}),
  };
  return { task: task.id, bucket: task.bucket, engine, baseline, pipeline };
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const lanes = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function printReport(results: TaskResult[]): string {
  const lines: string[] = [];
  const pad = (s: string, w: number) => s.padEnd(w);
  const engine = results[0]?.engine ?? "?";
  lines.push("");
  lines.push(
    `=== apodex eval [engine: ${engine} heavy roles] - single-pass baseline (mean of ${BASELINE_SAMPLES}) vs verification pipeline ===`,
  );
  lines.push("");
  lines.push(
    `${pad("task", 22)}${pad("bucket", 10)}${pad("baseline", 10)}${pad("pipeline", 10)}${pad("delta", 9)}notes`,
  );
  lines.push("-".repeat(86));
  for (const r of results) {
    const delta = r.pipeline.score.score - r.baseline.score.score;
    const notes: string[] = [];
    if (r.baseline.error) notes.push("baseline ERR");
    if (r.pipeline.error) notes.push("pipeline ERR");
    if (r.baseline.score.confidentlyWrong) notes.push("baseline confidently-wrong");
    if (r.pipeline.score.confidentlyWrong) notes.push("pipeline confidently-wrong");
    lines.push(
      `${pad(r.task, 22)}${pad(r.bucket, 10)}${pad(fmt(r.baseline.score.score), 10)}${pad(
        fmt(r.pipeline.score.score),
        10,
      )}${pad((delta >= 0 ? "+" : "") + fmt(delta), 9)}${notes.join(", ")}`,
    );
  }
  lines.push("-".repeat(86));

  const buckets: Bucket[] = ["design", "code", "incident"];
  for (const bucket of buckets) {
    const rows = results.filter((r) => r.bucket === bucket);
    if (rows.length === 0) continue;
    const b = rows.reduce((acc, r) => acc + r.baseline.score.score, 0) / rows.length;
    const p = rows.reduce((acc, r) => acc + r.pipeline.score.score, 0) / rows.length;
    lines.push(
      `${pad(`bucket ${bucket}`, 22)}${pad(`n=${rows.length}`, 10)}${pad(fmt(b), 10)}${pad(fmt(p), 10)}${
        (p - b >= 0 ? "+" : "") + fmt(p - b)
      }`,
    );
  }
  const b = results.reduce((acc, r) => acc + r.baseline.score.score, 0) / Math.max(1, results.length);
  const p = results.reduce((acc, r) => acc + r.pipeline.score.score, 0) / Math.max(1, results.length);
  lines.push(
    `${pad("OVERALL", 22)}${pad(`n=${results.length}`, 10)}${pad(fmt(b), 10)}${pad(fmt(p), 10)}${
      (p - b >= 0 ? "+" : "") + fmt(p - b)
    }`,
  );

  const cwBase = results.filter((r) => r.baseline.score.confidentlyWrong).length;
  const cwPipe = results.filter((r) => r.pipeline.score.confidentlyWrong).length;
  lines.push("");
  lines.push(`confidently-wrong incident diagnoses: baseline ${cwBase}, pipeline ${cwPipe}`);

  const cost = (sel: (r: TaskResult) => ArmResult) =>
    results.reduce((acc, r) => acc + sel(r).costUsd, 0);
  const calls = (sel: (r: TaskResult) => ArmResult) =>
    results.reduce((acc, r) => acc + sel(r).subCalls, 0);
  const wall = (sel: (r: TaskResult) => ArmResult) =>
    results.reduce((acc, r) => acc + sel(r).wallMs, 0);
  lines.push(
    `cost: baseline $${cost((r) => r.baseline).toFixed(4)} (${calls((r) => r.baseline)} calls), pipeline $${cost(
      (r) => r.pipeline,
    ).toFixed(4)} (${calls((r) => r.pipeline)} calls)`,
  );
  lines.push(
    `wall: baseline ${Math.round(wall((r) => r.baseline) / 1000)}s total, pipeline ${Math.round(
      wall((r) => r.pipeline) / 1000,
    )}s total`,
  );
  lines.push("");
  lines.push("scoring detail per task:");
  for (const r of results) {
    lines.push(`  ${r.task}:`);
    lines.push(`    baseline: ${r.baseline.score.detail}${r.baseline.error ? ` [error: ${r.baseline.error}]` : ""}`);
    lines.push(`    pipeline: ${r.pipeline.score.detail}${r.pipeline.error ? ` [error: ${r.pipeline.error}]` : ""}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let tasks: EvalTask[] = [...designTasks, ...codeTasks, ...incidentTasks];
  if (args.smoke) {
    const firstOf = (bucket: Bucket) => tasks.find((t) => t.bucket === bucket);
    tasks = (["design", "code", "incident"] as Bucket[])
      .map(firstOf)
      .filter((t): t is EvalTask => t !== undefined);
  }
  if (args.only !== null) {
    const needle = args.only;
    tasks = tasks.filter((t) => t.id.includes(needle));
    if (tasks.length === 0) {
      console.error(`--only ${needle} matched no tasks`);
      process.exit(2);
    }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const resultsDir = path.resolve(process.cwd(), "eval/results", stamp);
  const runsDir = path.join(resultsDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  console.error(
    `running ${tasks.length} tasks x engines [${args.engines.join(", ")}] (concurrency ${args.concurrency}${args.smoke ? ", smoke" : ""}); artifacts: ${resultsDir}`,
  );

  const registry = createStandaloneRegistry();
  const allResults: TaskResult[] = [];
  const reports: string[] = [];

  for (const engine of args.engines) {
    const results: TaskResult[] = [];
    await pool(tasks, args.concurrency, async (task) => {
      const result = await runTask(task, args, engine, registry, runsDir);
      results.push(result);
      console.error(
        `[${engine}:${task.id}] DONE baseline=${fmt(result.baseline.score.score)} pipeline=${fmt(result.pipeline.score.score)}`,
      );
    });

    // Stable order for the report regardless of completion order.
    results.sort((a, b) => a.task.localeCompare(b.task));
    allResults.push(...results);

    const report = printReport(results);
    console.log(report);
    reports.push(report);

    // Full answers for audit (first baseline sample + pipeline final).
    for (const r of results) {
      fs.writeFileSync(path.join(resultsDir, `${engine}.${r.task}.baseline.md`), r.baseline.answer, "utf8");
      fs.writeFileSync(path.join(resultsDir, `${engine}.${r.task}.pipeline.md`), r.pipeline.answer, "utf8");
    }
  }

  fs.writeFileSync(path.join(resultsDir, "summary.txt"), reports.join("\n\n"), "utf8");
  fs.writeFileSync(
    path.join(resultsDir, "results.json"),
    JSON.stringify(
      allResults.map((r) => ({
        ...r,
        baseline: { ...r.baseline, answer: `[${r.baseline.answer.length} chars, see *.baseline.md]` },
        pipeline: { ...r.pipeline, answer: `[${r.pipeline.answer.length} chars, see *.pipeline.md]` },
      })),
      null,
      2,
    ),
    "utf8",
  );
  console.error(`\nresults persisted to ${resultsDir}`);
}

main().catch((err) => {
  console.error("eval failed:", err);
  process.exit(1);
});
