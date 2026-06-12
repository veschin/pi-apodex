// Causal-evidence candidate selector.
//
// Samples N candidates in parallel (temperature-diversified), gathers execution
// evidence for each (code mode), then runs a round-robin pairwise tournament
// judged on three axes: comprehension, causality, empirical grounding. The
// judge sees candidates + execution evidence only - never generator reasoning.
// Winner = most overall wins; ties broken by axis wins, then by passing
// self-test, then by lowest index (deterministic).

import { BudgetExhaustedError } from "./budget.ts";
import { execEvidenceToText, runCandidateSelfTest } from "./exec.ts";
import { extractEnumField, parseJsonLoose } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import { JUDGE_SYSTEM, generatorSystem, generatorUser, judgeUser } from "./prompts.ts";
import type {
  AxisWinner,
  Candidate,
  PairVerdict,
  ProgressFn,
  SelectionResult,
  TaskMode,
} from "./types.ts";

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

export interface SelectorOptions {
  client: SubCallClient;
  task: string;
  mode: TaskMode;
  /** N, 1..8 (validated upstream). */
  candidates: number;
  execEnabled: boolean;
  execTimeoutMs: number;
  onProgress?: ProgressFn;
}

function isAxisWinner(value: unknown): value is AxisWinner {
  return value === "a" || value === "b" || value === "tie";
}

interface RawVerdict {
  comprehension?: unknown;
  causality?: unknown;
  grounding?: unknown;
  overall?: unknown;
  rationale?: unknown;
}

const AXIS_VALUES = ["a", "b", "tie"] as const;

function parseVerdict(text: string): Omit<PairVerdict, "a" | "b"> | null {
  // Strict JSON parse first; per-field regex fallback second (a judge once
  // emitted an unescaped quote inside its rationale - the axis verdicts
  // themselves are machine-reliable).
  const raw = parseJsonLoose<RawVerdict>(text);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { comprehension, causality, grounding, overall } = raw;
    if (isAxisWinner(comprehension) && isAxisWinner(causality) && isAxisWinner(grounding) && isAxisWinner(overall)) {
      return {
        axes: { comprehension, causality, grounding },
        overall,
        rationale: typeof raw.rationale === "string" ? raw.rationale : "",
      };
    }
  }
  const comprehension = extractEnumField(text, "comprehension", AXIS_VALUES);
  const causality = extractEnumField(text, "causality", AXIS_VALUES);
  const grounding = extractEnumField(text, "grounding", AXIS_VALUES);
  const overall = extractEnumField(text, "overall", AXIS_VALUES);
  if (isAxisWinner(comprehension) && isAxisWinner(causality) && isAxisWinner(grounding) && isAxisWinner(overall)) {
    return {
      axes: { comprehension, causality, grounding },
      overall,
      rationale: "(rationale unrecoverable from malformed JSON)",
    };
  }
  return null;
}

async function generateCandidates(opts: SelectorOptions): Promise<Candidate[]> {
  opts.onProgress?.(`[select] generating ${opts.candidates} candidates in parallel`);
  const system = generatorSystem(opts.mode);
  const user = generatorUser(opts.task);

  // allSettled (not all): every lane is awaited before inspection, so a
  // BudgetExhaustedError in one lane cannot leave dangling rejected promises
  // behind (which would crash under --unhandled-rejections=throw).
  const settled = await Promise.allSettled(
    Array.from({ length: opts.candidates }, (_, index) =>
      opts.client.call({
        role: "generator",
        label: `selector.candidate.${index}`,
        systemPrompt: system,
        userText: user,
        temperature: 0.8,
      }),
    ),
  );

  const budgetStop = settled.find(
    (r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof BudgetExhaustedError,
  );
  if (budgetStop) throw budgetStop.reason;

  const candidates: Candidate[] = settled.map((result, index) => {
    if (result.status === "fulfilled") {
      const outcome = result.value;
      const candidate: Candidate = {
        index,
        text: outcome.ok ? outcome.text : "",
        execEvidence: null,
      };
      if (!outcome.ok) candidate.generationError = outcome.error ?? "generation failed";
      return candidate;
    }
    return {
      index,
      text: "",
      execEvidence: null,
      generationError: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
  return candidates;
}

async function attachExecEvidence(opts: SelectorOptions, candidates: Candidate[]): Promise<void> {
  if (opts.mode !== "code") return;
  for (const candidate of candidates) {
    if (candidate.generationError) continue;
    if (!opts.execEnabled) {
      candidate.execEvidence = {
        ran: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        skippedReason: "execution disabled by config",
      };
      continue;
    }
    opts.onProgress?.(`[select] running self-test of candidate ${candidate.index}`);
    candidate.execEvidence = await runCandidateSelfTest(candidate.text, opts.execTimeoutMs);
  }
}

function passedSelfTest(candidate: Candidate): boolean {
  return candidate.execEvidence?.ran === true && candidate.execEvidence.exitCode === 0 && !candidate.execEvidence.timedOut;
}

export async function runSelection(opts: SelectorOptions): Promise<SelectionResult> {
  if (opts.candidates < 1) throw new SelectorError(`candidates must be >= 1, got ${opts.candidates}`);

  const candidates = await generateCandidates(opts);
  const viable = candidates.filter((c) => !c.generationError && c.text.trim() !== "");
  if (viable.length === 0) {
    throw new SelectorError(
      `all ${opts.candidates} candidate generations failed: ${candidates
        .map((c) => c.generationError ?? "empty")
        .join("; ")}`,
    );
  }

  await attachExecEvidence(opts, candidates);

  // Single viable candidate: nothing to compare.
  if (viable.length === 1) {
    const winner = viable[0];
    if (!winner) throw new SelectorError("internal: viable[0] missing");
    return { winnerIndex: winner.index, candidates, pairs: [], wins: { [winner.index]: 0 } };
  }

  // Round-robin pairwise tournament.
  const wins: Record<number, number> = {};
  const axisWins: Record<number, number> = {};
  for (const c of viable) {
    wins[c.index] = 0;
    axisWins[c.index] = 0;
  }

  const pairJobs: Array<[Candidate, Candidate]> = [];
  for (let i = 0; i < viable.length; i++) {
    for (let j = i + 1; j < viable.length; j++) {
      const a = viable[i];
      const b = viable[j];
      if (a && b) pairJobs.push([a, b]);
    }
  }

  opts.onProgress?.(`[select] judging ${pairJobs.length} pairs on evidence axes`);
  const pairs: PairVerdict[] = [];
  // Sequential judging keeps call volume predictable under the budget guard;
  // pair count is small (N<=8 -> <=28 pairs, typical 4 -> 6 pairs).
  for (const [a, b] of pairJobs) {
    const outcome = await opts.client.call({
      role: "judge",
      label: `selector.judge.${a.index}v${b.index}`,
      systemPrompt: JUDGE_SYSTEM,
      userText: judgeUser(
        opts.task,
        a.text,
        execEvidenceToText(a.execEvidence),
        b.text,
        execEvidenceToText(b.execEvidence),
      ),
      temperature: 0,
    });

    const base: PairVerdict = {
      a: a.index,
      b: b.index,
      axes: { comprehension: "tie", causality: "tie", grounding: "tie" },
      overall: "tie",
      rationale: "",
    };

    if (outcome.ok) {
      const parsed = parseVerdict(outcome.text);
      if (parsed) {
        base.axes = parsed.axes;
        base.overall = parsed.overall;
        base.rationale = parsed.rationale;
      } else {
        base.judgeError = "unparseable judge verdict; treated as tie";
      }
    } else {
      base.judgeError = outcome.error ?? "judge call failed; treated as tie";
    }
    pairs.push(base);

    const award = (axisOrOverall: AxisWinner, weight: number, table: Record<number, number>) => {
      if (axisOrOverall === "a") table[a.index] = (table[a.index] ?? 0) + weight;
      else if (axisOrOverall === "b") table[b.index] = (table[b.index] ?? 0) + weight;
    };
    award(base.overall, 1, wins);
    award(base.axes.comprehension, 1, axisWins);
    award(base.axes.causality, 1, axisWins);
    award(base.axes.grounding, 1, axisWins);
  }

  // Deterministic winner: overall wins -> axis wins -> passed self-test -> lowest index.
  const ranked = [...viable].sort((x, y) => {
    const winDiff = (wins[y.index] ?? 0) - (wins[x.index] ?? 0);
    if (winDiff !== 0) return winDiff;
    const axisDiff = (axisWins[y.index] ?? 0) - (axisWins[x.index] ?? 0);
    if (axisDiff !== 0) return axisDiff;
    const testDiff = Number(passedSelfTest(y)) - Number(passedSelfTest(x));
    if (testDiff !== 0) return testDiff;
    return x.index - y.index;
  });

  const winner = ranked[0];
  if (!winner) throw new SelectorError("internal: tournament produced no winner");
  opts.onProgress?.(`[select] winner is candidate ${winner.index} (${wins[winner.index] ?? 0} wins)`);
  return { winnerIndex: winner.index, candidates, pairs, wins };
}
