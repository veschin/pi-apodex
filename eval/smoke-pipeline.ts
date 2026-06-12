// Smoke test: drive the full pipeline standalone on a small task and print
// the observable result. Usage: npx tsx eval/smoke-pipeline.ts

import { loadConfig } from "../src/config.ts";
import { runApodex } from "../src/pipeline.ts";
import { createStandaloneRegistry } from "./standalone.ts";

const TASK = `Write a JavaScript (ESM) function "chunk(array, size)" that splits an array into
chunks of the given size. Define behavior for: empty array, size <= 0, size larger
than the array, non-integer size, and non-array input. Make it production-grade.`;

async function main(): Promise<void> {
  const env = {
    ...process.env,
    APODEX_GENERATOR: process.env.APODEX_GENERATOR ?? "deepseek/deepseek-v4-pro",
    APODEX_GRADER: process.env.APODEX_GRADER ?? "deepseek/deepseek-v4-pro",
    APODEX_VERIFIER: process.env.APODEX_VERIFIER ?? "deepseek/deepseek-v4-pro",
    APODEX_WORKER: process.env.APODEX_WORKER ?? "deepseek/deepseek-v4-flash",
  };
  const { config, warnings } = loadConfig({
    cwd: process.cwd(),
    env,
    overrides: { rounds: 2, candidates: 2 },
  });

  const registry = createStandaloneRegistry();
  const t0 = Date.now();
  const result = await runApodex({
    config,
    configWarnings: warnings,
    registry,
    task: TASK,
    mode: "code",
    cwd: process.cwd(),
    onProgress: (message) => console.error(`[progress] ${message}`),
  });

  console.log("\n=== SMOKE RESULT ===");
  console.log(`mode:            ${result.mode}`);
  console.log(`best score:      ${result.bestScore}`);
  console.log(`early stopped:   ${result.gvr?.earlyStopped ?? false}`);
  console.log(`selector winner: ${result.selection?.winnerIndex ?? "n/a"}`);
  console.log(
    `atoms:           ${result.verification?.atoms.map((a) => `${a.id}:${a.verdict}`).join(", ") ?? "n/a"}`,
  );
  console.log(`holistic:        ${result.verification?.holistic?.verdict ?? "n/a"}`);
  const cp = result.contextPack;
  console.log(
    `context:         ${cp ? (cp.gathered ? `${cp.files.length} files, ${cp.totalBytes} bytes, ${cp.rounds} rounds` : `none (${cp.skippedReason})`) : "stage not run"}`,
  );
  console.log(`task shape:      ${result.deliveryPlan?.taskShape ?? "n/a (planner unavailable)"}`);
  console.log(`budget:          ${result.budget.subCalls} calls, ${result.budget.totalTokens} tokens, $${result.budget.costUsd.toFixed(4)}`);
  console.log(`wall time:       ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`warnings:        ${result.warnings.length === 0 ? "none" : result.warnings.join(" | ")}`);
  console.log(`run dir:         ${result.runDir}`);
  console.log(`final answer length: ${result.finalAnswer.length} chars`);
  const hasSolution = result.finalAnswer.includes("solution");
  console.log(`final answer mentions solution block: ${hasSolution}`);
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
