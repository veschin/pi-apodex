// Pipeline composition - the "agent team" for one task:
//
//   workspace context gathering (scout + orchestrator-mediated reads)
//   -> classify mode (worker)
//   -> [code mode: N candidates -> exec evidence -> pairwise causal selection]
//   -> GVR loop (grade fresh-context, revise by critique), seeded with the winner
//   -> external verification (claim atoms + holistic audit)
//   -> assembly of the final answer from verified material
//   -> delivery plan (task shape + apply steps) and handoff.md
//
// Every stage runs through the budget-guarded SubCallClient, every artifact is
// persisted via RunStore, and every progress event is stage-prefixed and
// mirrored to progress.jsonl.

import { Budget, BudgetExhaustedError } from "./budget.ts";
import { contextPackToText, gatherContext } from "./context.ts";
import { planDelivery, renderHandoff } from "./delivery.ts";
import { runCandidateSelfTest } from "./exec.ts";
import { parseJsonLoose } from "./json.ts";
import { SubCallClient } from "./llm.ts";
import {
  ASSEMBLER_SYSTEM,
  MODE_CLASSIFIER_SYSTEM,
  assemblerUser,
  modeClassifierUser,
} from "./prompts.ts";
import { runGvr } from "./gvr.ts";
import { runSelection } from "./selector.ts";
import { atomsReportText, runVerification } from "./verifier.ts";
import { RoleResolver, type ModelRegistryLike } from "./roles.ts";
import { RunStore } from "./store.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ApodexConfig,
  ApodexResult,
  ContextPack,
  DeliveryPlan,
  ExecEvidence,
  GvrResult,
  ProgressFn,
  RoleName,
  SelectionResult,
  TaskMode,
  VerificationReport,
} from "./types.ts";

export interface PipelineOptions {
  config: ApodexConfig;
  configWarnings: string[];
  registry: ModelRegistryLike;
  sessionModel?: Model<Api>;
  task: string;
  /** "auto" lets a worker call classify the task. */
  mode: TaskMode | "auto";
  cwd: string;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
}

const VALID_MODES: readonly TaskMode[] = ["design", "code", "incident", "general"];

async function classifyMode(client: SubCallClient, task: string, onProgress?: ProgressFn): Promise<TaskMode> {
  const outcome = await client.call({
    role: "worker",
    label: "classify-mode",
    systemPrompt: MODE_CLASSIFIER_SYSTEM,
    userText: modeClassifierUser(task),
    temperature: 0,
  });
  if (outcome.ok) {
    const raw = parseJsonLoose<{ mode?: unknown }>(outcome.text);
    if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.mode === "string") {
      const mode = raw.mode as TaskMode;
      if ((VALID_MODES as readonly string[]).includes(mode)) return mode;
    }
  }
  onProgress?.("[classify] mode classification failed; falling back to mode=general");
  return "general";
}

const ROSTER_ROLES: readonly RoleName[] = ["generator", "grader", "verifier", "judge", "scout", "worker"];

/**
 * "role=provider/model" pairs for the team roster line. Resolution failures
 * surface as "role=ERR(...)" but never fail the run from here - a broken role
 * binding only matters (and then throws) when that role is actually called.
 */
async function rosterLine(resolver: RoleResolver, roles: readonly RoleName[]): Promise<string> {
  const parts: string[] = [];
  for (const role of roles) {
    try {
      const resolved = await resolver.resolve(role);
      parts.push(`${role}=${resolved.model.provider}/${resolved.model.id}`);
    } catch (err) {
      parts.push(`${role}=ERR(${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return parts.join(" ");
}

export async function runApodex(opts: PipelineOptions): Promise<ApodexResult> {
  const task = opts.task.trim();
  if (task === "") {
    throw new Error("apodex: task must be a non-empty string");
  }

  const warnings: string[] = [...opts.configWarnings];
  const runId = RunStore.newRunId();
  const store = new RunStore(
    opts.config.runsDir.startsWith("/") ? opts.config.runsDir : `${opts.cwd}/${opts.config.runsDir}`,
    runId,
    (w) => warnings.push(w),
  );

  // Single progress channel: every event reaches the caller AND lands in
  // progress.jsonl, so a run's stage timeline is auditable after the fact.
  const emitProgress: ProgressFn = (message) => {
    store.appendJsonl("progress.jsonl", { at: new Date().toISOString(), message });
    opts.onProgress?.(message);
  };

  const budget = new Budget(opts.config.budget);
  const resolver = new RoleResolver({
    config: opts.config,
    registry: opts.registry,
    ...(opts.sessionModel !== undefined ? { sessionModel: opts.sessionModel } : {}),
  });
  const clientOpts = {
    resolver,
    budget,
    store,
    timeoutMs: opts.config.budget.subCallTimeoutMs,
    maxRetries: opts.config.budget.subCallMaxRetries,
    onNote: (note: string) => {
      warnings.push(note);
      emitProgress(note);
    },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  const client = new SubCallClient(clientOpts);

  store.writeJson("config.json", {
    task,
    requestedMode: opts.mode,
    config: opts.config,
    startedAt: new Date().toISOString(),
  });

  emitProgress(`[team] ${await rosterLine(resolver, ROSTER_ROLES)}`);

  // Provisional mode; refined by classification inside the try so a mid-run
  // budget stop never erases an already-classified mode.
  let mode: TaskMode = opts.mode === "auto" ? "general" : opts.mode;
  let contextPack: ContextPack | null = null;
  let selection: SelectionResult | null = null;
  let gvr: GvrResult | null = null;
  let verification: VerificationReport | null = null;
  let deliveryPlan: DeliveryPlan | null = null;
  let finalAnswer = "";
  let budgetExhausted = false;

  try {
    // --- Stage A: workspace context (scout + orchestrator-mediated reads) ---
    if (opts.config.context.enabled) {
      emitProgress("[context] scouting the workspace for task-relevant files");
      contextPack = await gatherContext({
        client,
        task,
        cwd: opts.cwd,
        config: opts.config.context,
        onProgress: emitProgress,
      });
      store.writeJson("context.json", contextPack);
      warnings.push(...contextPack.warnings);
      emitProgress(
        contextPack.gathered
          ? `[context] gathered ${contextPack.files.length} file(s), ${(contextPack.totalBytes / 1024).toFixed(1)} KB in ${contextPack.rounds} scout round(s)`
          : `[context] no files gathered: ${contextPack.skippedReason ?? "no reason recorded"}`,
      );
    } else {
      emitProgress("[context] disabled by config");
    }
    // The pack is SHARED task material: identical for generator, grader,
    // judge, and auditors, so isolation and candidate comparability hold.
    const materials = contextPack?.gathered ? `${task}\n\n${contextPackToText(contextPack)}` : task;

    // --- Stage 0: mode ---
    // The classifier sees the same materials as every other stage: a task
    // like "fix the bug in src/x.ts" is only classifiable as code once the
    // gathered file contents are visible.
    if (opts.mode === "auto") {
      mode = await classifyMode(client, materials, emitProgress);
    }
    emitProgress(`[classify] mode: ${mode}`);

    // --- Stage 1: candidates + causal selection (code mode with N > 1) ---
    let seedAttempt: string | undefined;
    if (mode === "code" && opts.config.candidates > 1) {
      emitProgress(`[select] stage start: ${opts.config.candidates} parallel candidates, pairwise judging`);
      selection = await runSelection({
        client,
        task: materials,
        mode,
        candidates: opts.config.candidates,
        execEnabled: opts.config.exec.enabled,
        execTimeoutMs: opts.config.exec.timeoutMs,
        onProgress: emitProgress,
      });
      store.writeJson("selection.json", selection);
      const winner = selection.candidates.find((c) => c.index === selection?.winnerIndex);
      seedAttempt = winner?.text;
    }

    // --- Stage 2: GVR (with per-round exec probe in code mode) ---
    const execProbeEnabled = mode === "code" && opts.config.exec.enabled;
    emitProgress(`[gvr] stage start: up to ${opts.config.rounds} rounds, early stop at ${opts.config.scoreThreshold}`);
    gvr = await runGvr({
      client,
      task: materials,
      mode,
      rounds: opts.config.rounds,
      scoreThreshold: opts.config.scoreThreshold,
      ...(seedAttempt !== undefined ? { seedAttempt } : {}),
      ...(execProbeEnabled
        ? { execProbe: (attempt: string) => runCandidateSelfTest(attempt, opts.config.exec.timeoutMs) }
        : {}),
      onProgress: emitProgress,
    });
    store.writeJson(
      "gvr.json",
      gvr.attempts.map((a) => ({
        round: a.round,
        score: a.critique?.score ?? null,
        critique: a.critique,
        gradeError: a.gradeError ?? null,
        attemptChars: a.attempt.length,
        execProbe: a.execEvidence
          ? {
              ran: a.execEvidence.ran,
              exitCode: a.execEvidence.exitCode,
              timedOut: a.execEvidence.timedOut,
              skippedReason: a.execEvidence.skippedReason ?? null,
            }
          : null,
      })),
    );
    finalAnswer = gvr.best.attempt;

    // --- Stage 3: execution evidence for the best attempt (code mode) ---
    // The GVR exec probe already produced evidence for the best attempt; fall
    // back to the selector winner's evidence, then to a fresh run.
    let bestExecEvidence: ExecEvidence | null = gvr.best.execEvidence ?? null;
    if (mode === "code" && !bestExecEvidence) {
      if (selection) {
        const winner = selection.candidates.find((c) => c.index === selection?.winnerIndex);
        if (winner && winner.text === finalAnswer && winner.execEvidence) {
          bestExecEvidence = winner.execEvidence;
        }
      }
      if (!bestExecEvidence && opts.config.exec.enabled) {
        emitProgress("[exec] running self-test of the final attempt");
        bestExecEvidence = await runCandidateSelfTest(finalAnswer, opts.config.exec.timeoutMs);
        store.writeJson("final-selftest.json", bestExecEvidence);
      }
    }

    // --- Stage 4: external verification ---
    emitProgress("[verify] stage start: claim extraction, atom audits, holistic verdict");
    verification = await runVerification({
      client,
      task: materials,
      answer: finalAnswer,
      execEvidence: bestExecEvidence,
      onProgress: emitProgress,
    });
    store.writeJson("verification.json", verification);

    // --- Stage 5: assembly from verified material ---
    const needsAssembly =
      verification.atoms.some((a) => a.verdict === "unsupported" || a.verdict === "contradicted") ||
      (verification.holistic !== null && verification.holistic.verdict !== "approve");
    if (needsAssembly) {
      emitProgress("[assemble] rebuilding the final answer from audited material");
      const issues =
        verification.holistic && verification.holistic.criticalIssues.length > 0
          ? verification.holistic.criticalIssues.map((i) => `- ${i}`).join("\n")
          : "(none)";
      const assembled = await client.call({
        role: "generator",
        label: "assemble.final",
        systemPrompt: ASSEMBLER_SYSTEM,
        userText: assemblerUser(task, finalAnswer, atomsReportText(verification.atoms), issues),
        temperature: 0.2,
      });
      if (assembled.ok) {
        finalAnswer = assembled.text;
      } else {
        warnings.push(`assembly failed (${assembled.error ?? "unknown"}); returning best GVR attempt as-is`);
      }
    }

    // --- Stage 6: delivery plan (decoration on a finished answer) ---
    if (opts.config.delivery.planEnabled) {
      emitProgress("[deliver] composing the delivery plan");
      const planned = await planDelivery({ client, task, answer: finalAnswer, onProgress: emitProgress });
      deliveryPlan = planned.plan;
      if (planned.error !== undefined) {
        warnings.push(`delivery planning degraded: ${planned.error}`);
      } else if (deliveryPlan) {
        emitProgress(
          `[deliver] task shape: ${deliveryPlan.taskShape}; ${deliveryPlan.applySteps.length} apply step(s), ${deliveryPlan.keyPoints.length} key point(s)`,
        );
      }
    } else {
      emitProgress("[deliver] plan disabled by config");
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      budgetExhausted = true;
      warnings.push(err.message);
      if (finalAnswer === "" && gvr) finalAnswer = gvr.best.attempt;
      if (finalAnswer === "") {
        // Budget died before any attempt existed - surface the failure honestly.
        store.writeJson("run.json", {
          status: "failed",
          error: err.message,
          budget: budget.snapshot(),
          warnings,
        });
        throw err;
      }
    } else {
      // Persist what we have for the post-mortem, then rethrow.
      store.writeJson("run.json", {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        budget: budget.snapshot(),
        warnings,
      });
      throw err;
    }
  }

  const result: ApodexResult = {
    runId,
    runDir: store.runDir,
    task,
    mode,
    finalAnswer,
    bestScore: gvr?.best.critique?.score ?? null,
    gvr,
    selection,
    verification,
    contextPack,
    deliveryPlan,
    budget: budget.snapshot(),
    budgetExhausted,
    warnings,
  };

  store.writeText("final.md", finalAnswer);
  if (deliveryPlan) store.writeJson("delivery.json", deliveryPlan);
  store.writeText(
    "handoff.md",
    renderHandoff({
      runId,
      task,
      mode,
      bestScore: result.bestScore,
      verification,
      contextPack,
      deliveryPlan,
      budget: result.budget,
      budgetExhausted,
    }),
  );
  store.writeJson("run.json", {
    status: budgetExhausted ? "budget-exhausted" : "completed",
    runId,
    mode: result.mode,
    bestScore: result.bestScore,
    earlyStopped: gvr?.earlyStopped ?? false,
    holisticVerdict: verification?.holistic?.verdict ?? null,
    context: contextPack
      ? {
          gathered: contextPack.gathered,
          files: contextPack.files.map((f) => f.path),
          totalBytes: contextPack.totalBytes,
          rounds: contextPack.rounds,
          skippedReason: contextPack.skippedReason ?? null,
        }
      : null,
    taskShape: deliveryPlan?.taskShape ?? null,
    budget: result.budget,
    warnings,
    finishedAt: new Date().toISOString(),
  });

  return result;
}
