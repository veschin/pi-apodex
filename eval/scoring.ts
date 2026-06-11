// Scoring helpers shared by eval tasks.

import { runNodeScript, extractCodeBlocks } from "../src/exec.ts";
import { parseJsonLoose } from "../src/json.ts";
import type { ScoreContext, TaskScore } from "./types.ts";

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
  const match = /APODEX_TESTS (\d+)\/(\d+)/.exec(evidence.stdout);
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
  return {
    score: passed / total,
    detail: `hidden tests: ${passed}/${total} passed (exit ${evidence.exitCode})`,
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
      const raw = parseJsonLoose<{ pass?: unknown }>(outcome.text);
      if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.pass === "boolean") {
        pass = raw.pass;
      } else {
        checkError = true;
      }
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
  const raw = parseJsonLoose<{
    primary_matches?: unknown;
    mentioned_anywhere?: unknown;
    primary_confidence?: unknown;
  }>(outcome.text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { score: 0, detail: "diagnosis check returned unparseable JSON" };
  }
  const primary = raw.primary_matches === true;
  const mentioned = raw.mentioned_anywhere === true;
  const confidence = raw.primary_confidence === "high" ? "high" : raw.primary_confidence === "medium" ? "medium" : "low";

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
