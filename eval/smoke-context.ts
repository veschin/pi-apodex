// Smoke test for the workspace-context + delivery stages: run the pipeline on
// a repo-grounded question from the pi-apodex repo itself and ASSERT that
//   1. the scout gathered files and src/json.ts is among them,
//   2. the final answer is grounded (mentions parseJsonLoose),
//   3. context.json / delivery.json / handoff.md / progress.jsonl exist,
//   4. progress carries the [team] roster and stage prefixes.
// Usage: npx tsx eval/smoke-context.ts  (cheap: all-flash by default)

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config.ts";
import { runApodex } from "../src/pipeline.ts";
import { createStandaloneRegistry } from "./standalone.ts";

const TASK = `Using the workspace files, explain how this project extracts JSON from LLM
responses: which module owns it, what the main parsing function does step by
step, and which fallback helpers exist for machine-reliable fields. Cite the
relevant file paths.`;

function fail(message: string): never {
  console.error(`SMOKE-CONTEXT FAILED: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = {
    ...process.env,
    APODEX_GENERATOR: process.env.APODEX_GENERATOR ?? "deepseek/deepseek-v4-flash",
    APODEX_GRADER: process.env.APODEX_GRADER ?? "deepseek/deepseek-v4-flash",
    APODEX_VERIFIER: process.env.APODEX_VERIFIER ?? "deepseek/deepseek-v4-flash",
    APODEX_WORKER: process.env.APODEX_WORKER ?? "deepseek/deepseek-v4-flash",
  };
  const { config, warnings } = loadConfig({ cwd: process.cwd(), env, overrides: { rounds: 1, candidates: 1 } });

  const progress: string[] = [];
  const registry = createStandaloneRegistry();
  const t0 = Date.now();
  const result = await runApodex({
    config,
    configWarnings: warnings,
    registry,
    task: TASK,
    mode: "general",
    cwd: process.cwd(),
    onProgress: (message) => {
      progress.push(message);
      console.error(`[progress] ${message}`);
    },
  });

  console.log("\n=== SMOKE-CONTEXT RESULT ===");
  const cp = result.contextPack;
  console.log(`context gathered: ${cp?.gathered ?? false} (${cp?.files.length ?? 0} files, ${cp?.totalBytes ?? 0} bytes, ${cp?.rounds ?? 0} rounds)`);
  console.log(`context files:    ${cp?.files.map((f) => f.path).join(", ") ?? "-"}`);
  console.log(`task shape:       ${result.deliveryPlan?.taskShape ?? "n/a"}`);
  console.log(`best score:       ${result.bestScore}`);
  console.log(`holistic:         ${result.verification?.holistic?.verdict ?? "n/a"}`);
  console.log(`budget:           ${result.budget.subCalls} calls, $${result.budget.costUsd.toFixed(4)}`);
  console.log(`wall time:        ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`run dir:          ${result.runDir}`);

  // 1. Scout must have gathered the JSON module.
  if (!cp || !cp.gathered) fail(`context pack not gathered (reason: ${cp?.skippedReason ?? "pack missing"})`);
  if (!cp.files.some((f) => f.path === "src/json.ts")) {
    fail(`src/json.ts not in the pack (got: ${cp.files.map((f) => f.path).join(", ")})`);
  }
  // 2. Grounded answer.
  if (!result.finalAnswer.includes("parseJsonLoose")) fail("final answer does not mention parseJsonLoose");
  // 3. Artifacts.
  for (const name of ["context.json", "handoff.md", "progress.jsonl", "final.md"]) {
    if (!fs.existsSync(path.join(result.runDir, name))) fail(`artifact ${name} missing in ${result.runDir}`);
  }
  if (result.deliveryPlan && !fs.existsSync(path.join(result.runDir, "delivery.json"))) {
    fail("delivery plan exists but delivery.json missing");
  }
  // 4. Transparency.
  if (!progress.some((m) => m.startsWith("[team] "))) fail("no [team] roster line in progress");
  for (const prefix of ["[context]", "[classify]", "[gvr]", "[verify]", "[deliver]"]) {
    if (!progress.some((m) => m.startsWith(prefix))) fail(`no ${prefix} progress line`);
  }

  console.log("\nSMOKE-CONTEXT PASSED: scout grounding, artifacts, and stage transparency verified");
}

main().catch((err) => {
  console.error("SMOKE-CONTEXT FAILED:", err);
  process.exit(1);
});
