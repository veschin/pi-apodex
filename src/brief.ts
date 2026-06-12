// Brief stage - deep task elaboration BEFORE any solution work.
//
// One analyst call (+ one bounded re-ask) turns the raw task into:
//   - clarification questions (interactive runs only) -> the run pauses,
//   - a draft brief for user review (interactive, non-trivial tasks),
//   - a ready brief that joins the task materials (trivial tasks, or
//     non-interactive runs where unknowns become explicit assumptions).
//
// Re-invocation protocol (stateless across runs, state lives in chat text):
//   "# Clarification answers" section in the task = answers to a prior
//     questions pause; the analyst must not re-ask what is answered there.
//   "# Approved brief" section in the task = the user-approved brief; the
//     analyst is skipped entirely and the section is used as the brief.
//
// Failure discipline mirrors the context stage: the stage must never kill a
// run - analyst failure degrades to "no brief" + warning. Only budget/abort
// propagate (they throw out of client.call).

import { asStringArray, extractEnumField, parseJsonLoose } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import { ANALYST_SYSTEM, analystUser } from "./prompts.ts";
import type { ProgressFn } from "./types.ts";

export const APPROVED_BRIEF_MARKER = "# Approved brief";
export const CLARIFICATION_ANSWERS_MARKER = "# Clarification answers";

const MAX_QUESTIONS = 5;
const QUESTION_MAX_LEN = 600;
/** The analyst sees at most this much task text (it analyzes, it does not solve). */
const ANALYST_TASK_CAP = 30_000;

export interface BriefStageOutcome {
  kind: "ready" | "questions" | "brief-review" | "skipped";
  /** The brief text (kind=ready) or the draft for review (kind=brief-review). */
  brief: string | null;
  questions: string[];
  /** Why no brief was produced (kind=skipped). */
  skippedReason?: string;
}

const APPROVED_RE = /^# Approved brief\s*$/m;
const ANSWERS_RE = /^# Clarification answers\s*$/m;

/**
 * Deterministic marker scan: everything from the FIRST "# Approved brief"
 * heading (at line start) to the end of the task is the approved brief.
 * Known limitation (documented in 20_pipeline.md open questions): a heading
 * inside a code fence would also match.
 */
export function extractApprovedBrief(task: string): string | null {
  const match = APPROVED_RE.exec(task);
  if (!match) return null;
  const body = task.slice(match.index + match[0].length).trim();
  return body === "" ? null : body;
}

export function hasClarificationAnswers(task: string): boolean {
  return ANSWERS_RE.test(task);
}

interface RawAnalyst {
  status?: unknown;
  questions?: unknown;
  complexity?: unknown;
  brief?: unknown;
}

interface ParsedAnalyst {
  status: "questions" | "ready";
  questions: string[];
  complexity: "trivial" | "standard";
  brief: string;
}

export function parseAnalyst(text: string): ParsedAnalyst | null {
  const raw = parseJsonLoose<RawAnalyst>(text);
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  let status: string | null = typeof obj.status === "string" ? obj.status : null;
  if (status === null) status = extractEnumField(text, "status", ["questions", "ready"] as const);
  if (status !== "questions" && status !== "ready") return null;

  const questions = asStringArray(obj.questions, MAX_QUESTIONS, QUESTION_MAX_LEN);
  let complexity: string | null = typeof obj.complexity === "string" ? obj.complexity : null;
  if (complexity === null) complexity = extractEnumField(text, "complexity", ["trivial", "standard"] as const);
  if (complexity !== "trivial" && complexity !== "standard") complexity = "standard";
  const brief = typeof obj.brief === "string" ? obj.brief.trim() : "";

  if (status === "questions" && questions.length === 0) return null;
  if (status === "ready" && brief === "") return null;
  return { status, questions, complexity: complexity as "trivial" | "standard", brief };
}

export interface BriefStageOptions {
  client: SubCallClient;
  task: string;
  /** True when a chat-mediated user can answer questions / review the brief. */
  interactive: boolean;
  onProgress?: ProgressFn;
}

async function callAnalyst(
  opts: BriefStageOptions,
  label: string,
  userText: string,
): Promise<{ parsed: ParsedAnalyst | null; error?: string }> {
  const outcome = await opts.client.call({
    role: "analyst",
    label,
    systemPrompt: ANALYST_SYSTEM,
    userText,
  });
  if (!outcome.ok) return { parsed: null, error: outcome.error ?? "analyst call failed" };
  const parsed = parseAnalyst(outcome.text);
  if (!parsed) return { parsed: null, error: "analyst returned unparseable JSON" };
  return { parsed };
}

export async function runBriefStage(opts: BriefStageOptions): Promise<BriefStageOutcome> {
  const task =
    opts.task.length > ANALYST_TASK_CAP
      ? `${opts.task.slice(0, ANALYST_TASK_CAP)}\n\n... [task truncated for analysis at ${ANALYST_TASK_CAP} chars]`
      : opts.task;
  const answersPresent = hasClarificationAnswers(task);
  const userText = analystUser(task, opts.interactive, answersPresent);

  let result = await callAnalyst(opts, "brief.analyze", userText);
  if (!result.parsed) {
    // One bounded re-ask: either the call failed or the JSON did not parse.
    result = await callAnalyst(
      opts,
      "brief.analyze.retry",
      `${userText}\n\nIMPORTANT: your previous reply was not parseable. Return ONLY the JSON object described in your instructions - no prose, no markdown fences.`,
    );
  }
  if (!result.parsed) {
    return { kind: "skipped", brief: null, questions: [], skippedReason: result.error ?? "analyst failed twice" };
  }

  let parsed = result.parsed;
  if (parsed.status === "questions" && !opts.interactive) {
    // The prompt forbids questions in non-interactive mode; enforce it with
    // ONE forced-assumptions re-ask, then degrade to no-brief.
    opts.onProgress?.("[brief] analyst asked questions in non-interactive mode; forcing assumption mode");
    const forced = await callAnalyst(
      opts,
      "brief.analyze.assume",
      `${userText}\n\nIMPORTANT: questions are NOT possible in this run. Return status "ready" and convert every open question into an explicit entry under "## Assumptions".`,
    );
    if (!forced.parsed || forced.parsed.status !== "ready") {
      return {
        kind: "skipped",
        brief: null,
        questions: [],
        skippedReason: "analyst insisted on questions in non-interactive mode",
      };
    }
    parsed = forced.parsed;
  }

  if (parsed.status === "questions") {
    return { kind: "questions", brief: null, questions: parsed.questions };
  }
  if (opts.interactive && parsed.complexity === "standard") {
    return { kind: "brief-review", brief: parsed.brief, questions: [] };
  }
  return { kind: "ready", brief: parsed.brief, questions: [] };
}
