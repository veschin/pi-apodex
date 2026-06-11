// Post-run artifact analyzer: systematically surfaces defects and process
// weaknesses from an eval results directory.
//
//   npx tsx eval/analyze-run.ts eval/results/<stamp>
//
// For every pipeline run it reports: GVR score trajectory, grade failures,
// selection judge errors, atom verdict distribution, holistic verdict,
// budget pressure; from subcalls.jsonl: retries, truncations (stopReason
// "length"), slow calls, transport errors. From results.json: scoring
// check-errors ("?" marks), mid-suite crashes, arm errors. Anomalies are
// collected into a flat, severity-tagged list at the end.

import * as fs from "node:fs";
import * as path from "node:path";
import { codeTasks } from "./tasks/code.ts";
import { designTasks } from "./tasks/design.ts";
import { incidentTasks } from "./tasks/incident.ts";

interface SubCallRow {
  id: number;
  label: string;
  role: string;
  provider: string;
  model: string;
  durationMs: number;
  retries: number;
  stopReason: string;
  usage: { input: number; output: number; costUsd: number };
  error?: string;
}

interface Anomaly {
  severity: "DEFECT" | "RISK" | "NOTE";
  where: string;
  what: string;
}

const anomalies: Anomaly[] = [];

function flag(severity: Anomaly["severity"], where: string, what: string): void {
  anomalies.push({ severity, where, what });
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function taskIdForPrompt(prompt: string): string {
  const all = [...designTasks, ...codeTasks, ...incidentTasks];
  // Exact match on trimmed text: incident prompts share their first ~200
  // chars, so prefix matching mislabels them.
  for (const task of all) {
    if (prompt.trim() === task.prompt.trim()) return task.id;
  }
  return "(unknown task)";
}

function analyzeSubcalls(runDir: string, label: string): void {
  const file = path.join(runDir, "subcalls.jsonl");
  if (!fs.existsSync(file)) return;
  // Per-line tolerance: a run killed mid-append leaves a partial last line;
  // that is itself a finding, not a reason for the analyzer to crash.
  const rows: SubCallRow[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as SubCallRow);
    } catch {
      flag("DEFECT", label, `subcalls.jsonl contains an unparseable line (truncated write?): ${line.slice(0, 80)}`);
    }
  }

  const retried = rows.filter((r) => r.retries > 0);
  const failed = rows.filter((r) => r.error !== undefined);
  const truncated = rows.filter((r) => r.stopReason === "length");
  const slow = rows.filter((r) => r.durationMs > 300_000);

  for (const r of truncated) {
    flag(
      "DEFECT",
      `${label} call#${r.id} ${r.label}`,
      `output TRUNCATED at maxTokens (stopReason=length, ${r.usage.output} out tokens) - answer silently incomplete`,
    );
  }
  for (const r of failed) {
    flag("RISK", `${label} call#${r.id} ${r.label}`, `failed after ${r.retries} retries: ${r.error?.slice(0, 140)}`);
  }
  for (const r of retried.filter((x) => x.error === undefined)) {
    flag("NOTE", `${label} call#${r.id} ${r.label}`, `succeeded after ${r.retries} retry(ies), ${Math.round(r.durationMs / 1000)}s total`);
  }
  for (const r of slow) {
    flag("NOTE", `${label} call#${r.id} ${r.label}`, `slow call: ${Math.round(r.durationMs / 1000)}s (${r.role})`);
  }
}

interface GvrRow {
  round: number;
  score: number | null;
  gradeError: string | null;
  critique?: { violations?: string[]; revisionDirectives?: string[] } | null;
  execProbe?: { ran: boolean; exitCode: number | null; timedOut: boolean; skippedReason: string | null } | null;
}

function probeFailed(row: GvrRow): boolean {
  return row.execProbe?.ran === true && (row.execProbe.exitCode !== 0 || row.execProbe.timedOut === true);
}

function analyzePipelineRun(runDir: string): string[] {
  const lines: string[] = [];
  const config = readJson<{ task?: string }>(path.join(runDir, "config.json"));
  const run = readJson<{
    status?: string;
    bestScore?: number | null;
    holisticVerdict?: string | null;
    warnings?: string[];
    budget?: { subCalls: number; totalTokens: number; costUsd: number; elapsedMs: number; limits: { maxWallTimeMs: number; maxSubCalls: number } };
  }>(path.join(runDir, "run.json"));
  const taskId = config?.task ? taskIdForPrompt(config.task) : "(no config)";
  const name = `${path.basename(runDir)} [${taskId}]`;

  if (!run) {
    flag("DEFECT", name, "run.json missing - run died without manifest");
    return [`${name}: NO MANIFEST`];
  }

  lines.push(
    `${name}: ${run.status}, bestScore=${run.bestScore ?? "?"}, holistic=${run.holisticVerdict ?? "n/a"}, ` +
      `calls=${run.budget?.subCalls}, $${run.budget?.costUsd?.toFixed(4)}, ${Math.round((run.budget?.elapsedMs ?? 0) / 60000)}min`,
  );

  if (run.status !== "completed") {
    flag("DEFECT", name, `status=${run.status}${run.warnings?.length ? `; warnings: ${run.warnings.join(" | ").slice(0, 200)}` : ""}`);
  }
  const wallUsed = (run.budget?.elapsedMs ?? 0) / (run.budget?.limits.maxWallTimeMs ?? 1);
  if (wallUsed > 0.8 && run.status === "completed") {
    flag("RISK", name, `wall budget ${Math.round(wallUsed * 100)}% consumed - near miss`);
  }
  for (const w of run.warnings ?? []) {
    if (!w.startsWith("sub-call")) flag("NOTE", name, `warning: ${w.slice(0, 160)}`);
  }

  const gvr = readJson<GvrRow[]>(path.join(runDir, "gvr.json"));
  if (gvr) {
    const trajectory = gvr.map((g) => `${g.score ?? "ERR"}${probeFailed(g) ? "!" : ""}`).join(" -> ");
    lines.push(`  GVR: ${trajectory}${gvr.some(probeFailed) ? "  (! = self-test probe failed)" : ""}`);
    for (const g of gvr) {
      if (g.gradeError) flag("RISK", name, `round ${g.round} grade failed: ${g.gradeError}`);
    }
    // Regression: a revision that scored LOWER than its predecessor means the
    // critique misled the reviser (or the grader is noisy across rounds).
    for (let i = 1; i < gvr.length; i++) {
      const prev = gvr[i - 1]?.score;
      const cur = gvr[i]?.score;
      if (typeof prev === "number" && typeof cur === "number" && cur < prev - 5) {
        flag("RISK", name, `revision regressed: round ${i} ${prev} -> round ${i + 1} ${cur} (critique-led regression or grader noise)`);
      }
    }
    // The probe exists to force repair: every round failing it means the loop
    // never produced runtime-working code and shipped a capped best.
    const probed = gvr.filter((g) => g.execProbe?.ran === true);
    if (probed.length > 0 && probed.every(probeFailed)) {
      flag("DEFECT", name, `self-test probe FAILED on every round (${probed.length}) - best answer never observed working`);
    } else {
      const last = gvr[gvr.length - 1];
      if (last && probeFailed(last)) {
        flag("RISK", name, `final GVR round still had a failing self-test probe`);
      }
    }
  }

  const selection = readJson<{
    winnerIndex?: number;
    pairs?: Array<{ a: number; b: number; judgeError?: string }>;
    candidates?: Array<{ index: number; generationError?: string; execEvidence?: { ran?: boolean; exitCode?: number | null; timedOut?: boolean; skippedReason?: string } | null }>;
  }>(path.join(runDir, "selection.json"));
  if (selection) {
    const judgeErrors = (selection.pairs ?? []).filter((p) => p.judgeError);
    for (const p of judgeErrors) flag("RISK", name, `pair ${p.a}v${p.b} judge error: ${p.judgeError}`);
    const genErrors = (selection.candidates ?? []).filter((c) => c.generationError);
    for (const c of genErrors) flag("RISK", name, `candidate ${c.index} generation failed: ${c.generationError?.slice(0, 120)}`);
    const evid = (selection.candidates ?? [])
      .map((c) => {
        const e = c.execEvidence;
        if (!e) return `${c.index}:none`;
        if (!e.ran) return `${c.index}:skip(${e.skippedReason?.slice(0, 30) ?? "?"})`;
        return `${c.index}:${e.timedOut ? "timeout" : `exit${e.exitCode}`}`;
      })
      .join(" ");
    lines.push(`  selection: winner=${selection.winnerIndex}, exec[${evid}]`);
    const winner = (selection.candidates ?? []).find((c) => c.index === selection.winnerIndex);
    if (winner?.execEvidence?.ran && winner.execEvidence.exitCode !== 0) {
      flag("RISK", name, `selector picked a candidate whose own self-test FAILED (exit ${winner.execEvidence.exitCode})`);
    }
  }

  const verification = readJson<{
    atoms?: Array<{ verdict: string | null }>;
    holistic?: { verdict: string; criticalIssues?: string[] } | null;
    holisticError?: string;
  }>(path.join(runDir, "verification.json"));
  if (verification) {
    const counts: Record<string, number> = {};
    for (const a of verification.atoms ?? []) {
      const v = a.verdict ?? "unaudited";
      counts[v] = (counts[v] ?? 0) + 1;
    }
    lines.push(`  atoms: ${JSON.stringify(counts)}, holistic=${verification.holistic?.verdict ?? "n/a"}`);
    if (verification.holisticError) flag("RISK", name, `verification degraded: ${verification.holisticError}`);
    if ((counts.contradicted ?? 0) > 0 && verification.holistic?.verdict === "approve") {
      flag("RISK", name, `holistic=approve despite ${counts.contradicted} contradicted atom(s) - verifier leniency`);
    }
    if ((verification.atoms ?? []).length === 0) {
      flag("RISK", name, "zero atoms extracted - evidence discipline did not engage");
    }
  }

  analyzeSubcalls(runDir, name);
  return lines;
}

interface ResultRow {
  task: string;
  bucket: string;
  engine?: string;
  baseline: { score: { score: number; detail: string; confidentlyWrong?: boolean }; samples?: Array<{ score: number; detail: string }>; error?: string };
  pipeline: { score: { score: number; detail: string; confidentlyWrong?: boolean }; error?: string };
}

function analyzeResults(resultsFile: string): string[] {
  const lines: string[] = [];
  const results = readJson<ResultRow[]>(resultsFile);
  if (!results) {
    flag("DEFECT", "results.json", "missing or unparseable");
    return lines;
  }
  for (const r of results) {
    const id = `${r.engine ?? "?"}:${r.task}`;
    const delta = r.pipeline.score.score - r.baseline.score.score;
    lines.push(
      `${id}: baseline=${r.baseline.score.score.toFixed(2)} pipeline=${r.pipeline.score.score.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`,
    );
    if (r.baseline.error) flag("RISK", id, `baseline arm error: ${r.baseline.error.slice(0, 140)}`);
    if (r.pipeline.error) flag("DEFECT", id, `pipeline arm error: ${r.pipeline.error.slice(0, 140)}`);
    if (r.pipeline.score.detail.includes("?")) {
      flag("RISK", id, `pipeline scoring had errored checks: ${r.pipeline.score.detail.slice(0, 160)}`);
    }
    if (r.pipeline.score.detail.includes("crashed mid-suite")) {
      flag("DEFECT", id, `pipeline answer crashed its hidden-test suite: ${r.pipeline.score.detail.slice(0, 160)}`);
    }
    if (r.baseline.score.detail.includes("crashed mid-suite")) {
      flag("NOTE", id, `a baseline sample crashed its hidden-test suite`);
    }
    // Variance across baseline samples reveals task stability for the engine.
    const sampleScores = (r.baseline.samples ?? []).map((s) => s.score);
    if (sampleScores.length > 1) {
      const spread = Math.max(...sampleScores) - Math.min(...sampleScores);
      if (spread >= 0.3) {
        flag("NOTE", id, `baseline unstable across samples [${sampleScores.map((s) => s.toFixed(2)).join(", ")}] - single-pass is a lottery here`);
      }
    }
    if (delta < -0.05) {
      flag("DEFECT", id, `pipeline UNDERPERFORMS baseline by ${(-delta).toFixed(2)} - needs root-cause`);
    }
  }
  return lines;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) {
    console.error("usage: npx tsx eval/analyze-run.ts eval/results/<stamp>");
    process.exit(2);
  }

  console.log(`# Analysis of ${dir}\n`);

  console.log("## Arm results\n");
  for (const line of analyzeResults(path.join(dir, "results.json"))) console.log(line);

  console.log("\n## Pipeline runs\n");
  const runsDir = path.join(dir, "runs");
  const runDirs = fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        .filter((d) => d.startsWith("run-"))
        .sort()
    : [];
  for (const d of runDirs) {
    for (const line of analyzePipelineRun(path.join(runsDir, d))) console.log(line);
  }

  console.log("\n## Anomalies (by severity)\n");
  const order: Anomaly["severity"][] = ["DEFECT", "RISK", "NOTE"];
  for (const severity of order) {
    const rows = anomalies.filter((a) => a.severity === severity);
    if (rows.length === 0) continue;
    console.log(`### ${severity} (${rows.length})`);
    for (const a of rows) console.log(`- [${a.where}] ${a.what}`);
    console.log("");
  }
  if (anomalies.length === 0) console.log("(none found)");

  const defects = anomalies.filter((a) => a.severity === "DEFECT").length;
  console.log(`\nTOTAL: ${anomalies.length} findings (${defects} defects)`);
  process.exit(defects > 0 ? 1 : 0);
}

main();
