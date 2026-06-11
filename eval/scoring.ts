// Scoring helpers shared by eval tasks.

import { runNodeScript, extractCodeBlocks } from "../src/exec.ts";
import { extractBoolField, extractEnumField } from "../src/json.ts";
import type { ScoreContext, TaskScore } from "./types.ts";

// Re-export for tests/tools that imported these from here historically.
export { extractBoolField, extractEnumField };

// --- code bucket: hidden deterministic tests -------------------------------

/**
 * Hidden tests import "./solution.mjs" and print "APODEX_TESTS <passed>/<total>"
 * before exiting (exit code 0 only when all passed).
 */
export async function scoreCodeWithHiddenTest(
  answer: string,
  hiddenTest: string,
  ctx: ScoreContext,
): Promise<TaskScore> {
  const { solution } = extractCodeBlocks(answer);
  if (!solution) {
    return { score: 0, detail: "no `js solution` block found in answer" };
  }
  const evidence = await runNodeScript({
    files: { "solution.mjs": solution, "hidden-test.mjs": hiddenTest },
    entry: "hidden-test.mjs",
    timeoutMs: ctx.execTimeoutMs,
  });
  if (!evidence.ran) {
    return { score: 0, detail: `hidden test did not run: ${evidence.skippedReason ?? "unknown"}` };
  }
  if (evidence.timedOut) {
    return { score: 0, detail: "hidden test timed out (likely hang/inf-loop in solution)" };
  }
  // Tests report after every check; the LAST report line carries the final
  // tally, and a crash mid-suite still yields partial credit for checks that
  // objectively passed before it.
  const matches = [...evidence.stdout.matchAll(/APODEX_TESTS (\d+)\/(\d+)/g)];
  const match = matches[matches.length - 1];
  if (!match) {
    return {
      score: 0,
      detail: `hidden test crashed before reporting (exit ${evidence.exitCode}): ${lastLines(
        evidence.stderr || evidence.stdout,
        3,
      )}`,
    };
  }
  const passed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(passed) || !Number.isFinite(total) || total <= 0) {
    return { score: 0, detail: `unparseable test report: ${match[0]}` };
  }
  const crashed = /CRASH |UNHANDLED_REJECTION /.test(evidence.stdout);
  return {
    score: passed / total,
    detail: `hidden tests: ${passed}/${total} passed (exit ${evidence.exitCode})${crashed ? " - solution crashed mid-suite (uncaught error/rejection)" : ""}`,
  };
}

function lastLines(text: string, n: number): string {
  const lines = text.trim().split("\n");
  return lines.slice(-n).join(" | ").slice(0, 400);
}

// --- design bucket: locked rubric ------------------------------------------

export interface RubricItem {
  id: string;
  /** The strict yes/no question put to the checker. */
  requirement: string;
}

const RUBRIC_CHECK_SYSTEM = `You are a strict rubric checker for an engineering design answer.
You receive one requirement and the answer. Decide whether the answer CONCRETELY
addresses the requirement - a passing answer must contain the substance (mechanism,
decision, tradeoff), not merely mention the topic in passing. Vague gestures fail.

Return ONLY JSON: {"pass": true | false, "evidence": "<short quote or 'absent'>"}`;

export async function scoreDesignRubric(
  answer: string,
  rubric: RubricItem[],
  ctx: ScoreContext,
): Promise<TaskScore> {
  if (rubric.length === 0) throw new Error("rubric must not be empty");
  // A failed CHECK (call error / unparseable verdict) is not the same as a
  // failed REQUIREMENT - it is tracked and surfaced so scoring degradation is
  // never silent.
  const results: Array<{ id: string; pass: boolean; checkError: boolean }> = [];
  for (const item of rubric) {
    const outcome = await ctx.client.call({
      role: "worker",
      label: `eval.rubric.${item.id}`,
      systemPrompt: RUBRIC_CHECK_SYSTEM,
      userText: `# Requirement\n\n${item.requirement}\n\n# Answer to check\n\n${answer}`,
      temperature: 0,
    });
    let pass = false;
    let checkError = false;
    if (outcome.ok) {
      const verdict = extractBoolField(outcome.text, "pass");
      if (verdict !== null) pass = verdict;
      else checkError = true;
    } else {
      checkError = true;
    }
    results.push({ id: item.id, pass, checkError });
  }
  const passed = results.filter((r) => r.pass);
  const errored = results.filter((r) => r.checkError);
  return {
    score: passed.length / rubric.length,
    detail: `rubric: ${passed.length}/${rubric.length} [${results
      .map((r) => `${r.id}:${r.checkError ? "?" : r.pass ? "+" : "-"}`)
      .join(" ")}]${errored.length > 0 ? ` WARNING: ${errored.length} check(s) errored` : ""}`,
  };
}

// --- incident bucket: known root cause -------------------------------------

const DIAGNOSIS_CHECK_SYSTEM = `You compare an incident diagnosis against the known true root cause.
Judge substance, not wording. Return ONLY JSON:
{
  "primary_matches": <true if the diagnosis names the true root cause as its primary/most-likely cause>,
  "mentioned_anywhere": <true if the true root cause appears anywhere in the answer (even as a secondary hypothesis)>,
  "primary_confidence": "high" | "medium" | "low"  // how confidently the answer asserts its PRIMARY cause
}`;

export async function scoreIncidentDiagnosis(
  answer: string,
  trueRootCause: string,
  ctx: ScoreContext,
): Promise<TaskScore> {
  const outcome = await ctx.client.call({
    role: "worker",
    label: "eval.diagnosis-check",
    systemPrompt: DIAGNOSIS_CHECK_SYSTEM,
    userText: `# True root cause (ground truth)\n\n${trueRootCause}\n\n# Diagnosis under evaluation\n\n${answer}`,
    temperature: 0,
  });
  if (!outcome.ok) {
    return { score: 0, detail: `diagnosis check failed: ${outcome.error ?? "unknown"}` };
  }
  const primaryField = extractBoolField(outcome.text, "primary_matches");
  const mentionedField = extractBoolField(outcome.text, "mentioned_anywhere");
  if (primaryField === null || mentionedField === null) {
    return { score: 0, detail: "diagnosis check returned unparseable verdict (both JSON and field fallback failed)" };
  }
  const primary = primaryField;
  const mentioned = mentionedField;
  const confidence = extractEnumField(outcome.text, "primary_confidence", ["high", "medium", "low"]) ?? "low";

  if (primary) {
    return { score: 1, detail: `primary diagnosis correct (confidence ${confidence})` };
  }
  if (mentioned) {
    return { score: 0.4, detail: `true cause mentioned but not primary (primary confidence ${confidence})` };
  }
  const confidentlyWrong = confidence === "high";
  return {
    score: 0,
    detail: confidentlyWrong
      ? "true cause absent AND a wrong cause asserted with high confidence"
      : "true cause absent (hedged answer)",
    confidentlyWrong,
  };
}
