// GVR - generate -> verify -> revise.
//
// K rounds. Each round: grade the current attempt in a FRESH context (grader
// sees only task + candidate, never history or another agent's reasoning),
// then revise steered by the grader's WRITTEN critique (not just the score).
// Returns the highest-scoring attempt seen. The written critique is what keeps
// this from degenerating into best-of-K sampling.

import { BudgetExhaustedError } from "./budget.ts";
import { execEvidenceToText } from "./exec.ts";
import { parseJsonLoose, asBoundedInt, asStringArray } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import {
  GRADER_SYSTEM,
  generatorSystem,
  generatorUser,
  graderUser,
  reviserUser,
} from "./prompts.ts";
import type { Critique, ExecEvidence, GradedAttempt, GvrResult, ProgressFn, TaskMode } from "./types.ts";

export class GvrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GvrError";
  }
}

interface RawCritique {
  score?: unknown;
  summary?: unknown;
  violations?: unknown;
  revision_directives?: unknown;
}

export function parseCritique(text: string): Critique | null {
  const raw = parseJsonLoose<RawCritique>(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const score = asBoundedInt(raw.score, 0, 100);
  if (score === null) return null;
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  if (summary === "") return null;
  return {
    score,
    summary,
    violations: asStringArray(raw.violations, 20, 600),
    revisionDirectives: asStringArray(raw.revision_directives, 20, 600),
  };
}

export function critiqueToText(critique: Critique): string {
  const lines: string[] = [`Score: ${critique.score}/100`, "", critique.summary];
  if (critique.violations.length > 0) {
    lines.push("", "Rubric violations:");
    for (const violation of critique.violations) lines.push(`- ${violation}`);
  }
  if (critique.revisionDirectives.length > 0) {
    lines.push("", "Revision directives (ordered by impact):");
    for (const directive of critique.revisionDirectives) lines.push(`- ${directive}`);
  }
  return lines.join("\n");
}

export interface GvrOptions {
  client: SubCallClient;
  task: string;
  mode: TaskMode;
  /** Number of grade cycles, 1..10 (validated upstream). */
  rounds: number;
  /** Early stop once an attempt reaches this score. */
  scoreThreshold: number;
  /** Optional starting attempt (e.g. the selector winner). */
  seedAttempt?: string;
  /**
   * Code mode: runs the attempt's own self-test and returns the evidence.
   * The verbatim output is fed to the grader (ground truth about behavior)
   * and to the reviser (models fix LOCATED errors far better than described
   * ones); a failing/timed-out probe caps the round score at 59
   * deterministically so a lenient grader cannot early-stop on broken code.
   */
  execProbe?: (attempt: string) => Promise<ExecEvidence>;
  onProgress?: ProgressFn;
  labelPrefix?: string;
}

const EXEC_FAIL_SCORE_CAP = 59;

/**
 * Grade with one bounded re-ask on JSON-parse failure. Two grade failures in a
 * single round are treated per the failure policy in `runGvr`.
 */
async function gradeAttempt(
  opts: GvrOptions,
  attempt: string,
  round: number,
  evidenceText: string | undefined,
): Promise<{ critique: Critique | null; error?: string }> {
  const label = `${opts.labelPrefix ?? "gvr"}.grade.r${round}`;
  const first = await opts.client.call({
    role: "grader",
    label,
    systemPrompt: GRADER_SYSTEM,
    userText: graderUser(opts.task, attempt, evidenceText),
  });
  if (first.ok) {
    const critique = parseCritique(first.text);
    if (critique) return { critique };
  }
  // One bounded re-ask: either the call failed or the JSON did not parse.
  const second = await opts.client.call({
    role: "grader",
    label: `${label}.retry`,
    systemPrompt: GRADER_SYSTEM,
    userText: `${graderUser(opts.task, attempt, evidenceText)}\n\nIMPORTANT: your previous reply was not parseable. Return ONLY the JSON object described in your instructions - no prose, no markdown fences.`,
  });
  if (second.ok) {
    const critique = parseCritique(second.text);
    if (critique) return { critique };
    return { critique: null, error: "grader returned unparseable JSON twice" };
  }
  return { critique: null, error: second.error ?? "grader call failed twice" };
}

export async function runGvr(opts: GvrOptions): Promise<GvrResult> {
  const attempts: GradedAttempt[] = [];
  let best: GradedAttempt | null = null;
  let earlyStopped = false;
  let currentAttempt: string | null = opts.seedAttempt ?? null;
  let lastCritique: Critique | null = null;
  let consecutiveGradeFailures = 0;

  let round = 0;
  try {
    for (round = 1; round <= opts.rounds; round++) {
      // 1. Produce the attempt for this round.
      if (currentAttempt === null) {
        opts.onProgress?.(`[gvr] round ${round}/${opts.rounds}: generating attempt`);
        const gen = await opts.client.call({
          role: "generator",
          label: `${opts.labelPrefix ?? "gvr"}.generate.r${round}`,
          systemPrompt: generatorSystem(opts.mode),
          userText: generatorUser(opts.task),
        });
        if (!gen.ok) {
          // A failed first generation means there is nothing to grade or revise.
          throw new GvrError(`generator failed in round ${round}: ${gen.error ?? "unknown error"}`);
        }
        currentAttempt = gen.text;
      }

      // 2. Execution probe (code mode): objective evidence about THIS attempt.
      let evidence: ExecEvidence | null = null;
      if (opts.execProbe) {
        opts.onProgress?.(`[gvr] round ${round}/${opts.rounds}: running self-test probe`);
        evidence = await opts.execProbe(currentAttempt);
      }
      const probeFailed = evidence !== null && evidence.ran && (evidence.exitCode !== 0 || evidence.timedOut);

      // 3. Grade it in a fresh context (evidence attached when available).
      opts.onProgress?.(`[gvr] round ${round}/${opts.rounds}: grading`);
      const graded = await gradeAttempt(
        opts,
        currentAttempt,
        round,
        evidence ? execEvidenceToText(evidence) : undefined,
      );
      // Deterministic cap: observed failing behavior is a substantive defect
      // regardless of how lenient the grader felt.
      if (graded.critique && probeFailed && graded.critique.score > EXEC_FAIL_SCORE_CAP) {
        graded.critique = {
          ...graded.critique,
          score: EXEC_FAIL_SCORE_CAP,
          violations: [
            ...graded.critique.violations,
            `self-test FAILED at runtime (${evidence?.timedOut ? "timeout" : `exit ${evidence?.exitCode}`}); score capped at ${EXEC_FAIL_SCORE_CAP}`,
          ],
        };
      }
      const attempt: GradedAttempt = {
        round,
        attempt: currentAttempt,
        critique: graded.critique,
        execEvidence: evidence,
      };
      if (graded.error !== undefined) attempt.gradeError = graded.error;
      attempts.push(attempt);

      if (graded.critique) {
        consecutiveGradeFailures = 0;
        lastCritique = graded.critique;
        if (!best || !best.critique || graded.critique.score > best.critique.score) {
          best = attempt;
        }
        opts.onProgress?.(
          `[gvr] round ${round}/${opts.rounds}: score ${graded.critique.score}/100 (best ${best.critique?.score ?? "?"})`,
        );
        if (graded.critique.score >= opts.scoreThreshold) {
          earlyStopped = true;
          break;
        }
      } else {
        consecutiveGradeFailures += 1;
        if (!best) best = attempt; // an ungraded attempt still beats returning nothing
        // Failure policy (principle: diagnose, don't stack workarounds):
        // two rounds in a row without a usable grade means the grading channel
        // itself is broken - stop the loop instead of revising blind.
        if (consecutiveGradeFailures >= 2) {
          opts.onProgress?.(`[gvr] grading failed twice in a row (${graded.error ?? "?"}); stopping loop`);
          break;
        }
      }

      // 4. Revise for the next round, steered by the written critique plus the
      // VERBATIM execution output - models repair located errors far more
      // reliably than described ones.
      if (round < opts.rounds) {
        if (!lastCritique) {
          // No critique at all yet -> a revision would just re-sample; regenerate
          // fresh instead by clearing the attempt.
          currentAttempt = null;
          continue;
        }
        opts.onProgress?.(`[gvr] round ${round}/${opts.rounds}: revising per critique`);
        let critiqueText = critiqueToText(lastCritique);
        if (evidence && evidence.ran) {
          critiqueText += `\n\nExecution evidence for the attempt (verbatim self-test output):\n${execEvidenceToText(evidence)}`;
        }
        const revision = await opts.client.call({
          role: "generator",
          label: `${opts.labelPrefix ?? "gvr"}.revise.r${round}`,
          systemPrompt: generatorSystem(opts.mode),
          userText: reviserUser(opts.task, currentAttempt, critiqueText),
          temperature: 0.4,
        });
        if (!revision.ok) {
          opts.onProgress?.(`[gvr] revision failed (${revision.error ?? "?"}); keeping best so far`);
          break;
        }
        currentAttempt = revision.text;
      }
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError && best) {
      // Budget ran out mid-loop: return the best graded attempt we have.
      return { best, attempts, earlyStopped: false, roundsRun: round };
    }
    throw err;
  }

  if (!best) {
    throw new GvrError("GVR produced no attempt (all generations failed)");
  }
  return { best, attempts, earlyStopped, roundsRun: Math.min(round, opts.rounds) };
}
