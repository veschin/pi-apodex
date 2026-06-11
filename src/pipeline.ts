// Pipeline composition - the "agent team" for one task:
//
//   classify mode (worker)
//   -> [code mode: N candidates -> exec evidence -> pairwise causal selection]
//   -> GVR loop (grade fresh-context, revise by critique), seeded with the winner
//   -> external verification (claim atoms + holistic audit)
//   -> assembly of the final answer from verified material
//
// Every stage runs through the budget-guarded SubCallClient, and every artifact
// is persisted via RunStore.

import { Budget, BudgetExhaustedError } from "./budget.ts";
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
  ExecEvidence,
  GvrResult,
  ProgressFn,
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
  onProgress?.("mode classification failed; falling back to mode=general");
  return "general";
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
      opts.onProgress?.(note);
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

  // Provisional mode; refined by classification inside the try so a mid-run
  // budget stop never erases an already-classified mode.
  let mode: TaskMode = opts.mode === "auto" ? "general" : opts.mode;
  let selection: SelectionResult | null = null;
  let gvr: GvrResult | null = null;
  let verification: VerificationReport | null = null;
  let finalAnswer = "";
  let budgetExhausted = false;

  try {
    // --- Stage 0: mode ---
    if (opts.mode === "auto") {
      mode = await classifyMode(client, task, opts.onProgress);
    }
    opts.onProgress?.(`mode: ${mode}`);

    // --- Stage 1: candidates + causal selection (code mode with N > 1) ---
    let seedAttempt: string | undefined;
    if (mode === "code" && opts.config.candidates > 1) {
      selection = await runSelection({
        client,
        task,
        mode,
        candidates: opts.config.candidates,
        execEnabled: opts.config.exec.enabled,
        execTimeoutMs: opts.config.exec.timeoutMs,
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      });
      store.writeJson("selection.json", selection);
      const winner = selection.candidates.find((c) => c.index === selection?.winnerIndex);
      seedAttempt = winner?.text;
    }

    // --- Stage 2: GVR (with per-round exec probe in code mode) ---
    const execProbeEnabled = mode === "code" && opts.config.exec.enabled;
    gvr = await runGvr({
      client,
      task,
      mode,
      rounds: opts.config.rounds,
      scoreThreshold: opts.config.scoreThreshold,
      ...(seedAttempt !== undefined ? { seedAttempt } : {}),
      ...(execProbeEnabled
        ? { execProbe: (attempt: string) => runCandidateSelfTest(attempt, opts.config.exec.timeoutMs) }
        : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
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
        opts.onProgress?.("running self-test of the final attempt");
        bestExecEvidence = await runCandidateSelfTest(finalAnswer, opts.config.exec.timeoutMs);
        store.writeJson("final-selftest.json", bestExecEvidence);
      }
    }

    // --- Stage 4: external verification ---
    verification = await runVerification({
      client,
      task,
      answer: finalAnswer,
      execEvidence: bestExecEvidence,
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    });
    store.writeJson("verification.json", verification);

    // --- Stage 5: assembly from verified material ---
    const needsAssembly =
      verification.atoms.some((a) => a.verdict === "unsupported" || a.verdict === "contradicted") ||
      (verification.holistic !== null && verification.holistic.verdict !== "approve");
    if (needsAssembly) {
      opts.onProgress?.("assembling final answer from verified atoms");
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
    budget: budget.snapshot(),
    budgetExhausted,
    warnings,
  };

  store.writeText("final.md", finalAnswer);
  store.writeJson("run.json", {
    status: budgetExhausted ? "budget-exhausted" : "completed",
    runId,
    mode: result.mode,
    bestScore: result.bestScore,
    earlyStopped: gvr?.earlyStopped ?? false,
    holisticVerdict: verification?.holistic?.verdict ?? null,
    budget: result.budget,
    warnings,
    finishedAt: new Date().toISOString(),
  });

  return result;
}
