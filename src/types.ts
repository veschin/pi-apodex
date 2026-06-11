// Core domain types for the apodex pipeline.
// All sub-call I/O is single-turn: one system prompt + one user message per call.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type RoleName = "generator" | "grader" | "verifier" | "worker";

export type TaskMode = "design" | "code" | "incident" | "general";

/** "session" = whatever model the host pi session runs; otherwise "<provider>/<modelId>". */
export interface RoleSpec {
  model: string;
  thinking: ModelThinkingLevel;
  temperature: number;
  maxTokens: number;
}

export interface BudgetConfig {
  maxSubCalls: number;
  maxTotalTokens: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  subCallTimeoutMs: number;
  /** Bounded retries per sub-call on transport/empty-response failures. */
  subCallMaxRetries: number;
}

export interface ApodexConfig {
  roles: Record<RoleName, RoleSpec>;
  /** K - GVR rounds (grade cycles), clamped to 1..10. */
  rounds: number;
  /** N - parallel candidates for the selector stage, clamped to 1..8. */
  candidates: number;
  /** Early-stop threshold for GVR, 0..100. */
  scoreThreshold: number;
  budget: BudgetConfig;
  exec: {
    /** Run candidate self-tests with node in a tempdir (code mode). */
    enabled: boolean;
    timeoutMs: number;
  };
  /** Base directory for run artifacts (absolute, or relative to cwd). */
  runsDir: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface BudgetSnapshot {
  subCalls: number;
  totalTokens: number;
  costUsd: number;
  elapsedMs: number;
  limits: BudgetConfig;
}

export interface SubCallRequest {
  role: RoleName;
  /** Step label for artifacts, e.g. "gvr.grade.r2". */
  label: string;
  systemPrompt: string;
  userText: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SubCallRecord {
  id: number;
  label: string;
  role: RoleName;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  retries: number;
  stopReason: string;
  usage: UsageTotals;
  error?: string;
  systemPrompt: string;
  userText: string;
  responseText: string;
}

export interface SubCallOutcome {
  ok: boolean;
  text: string;
  record: SubCallRecord;
  error?: string;
}

// --- GVR ---

export interface Critique {
  /** 0..100, integer. */
  score: number;
  summary: string;
  violations: string[];
  revisionDirectives: string[];
}

export interface GradedAttempt {
  round: number;
  attempt: string;
  critique: Critique | null;
  gradeError?: string;
  /** Code mode: result of running this attempt's own self-test (exec probe). */
  execEvidence?: ExecEvidence | null;
}

export interface GvrResult {
  best: GradedAttempt;
  attempts: GradedAttempt[];
  earlyStopped: boolean;
  roundsRun: number;
}

// --- Candidate selection ---

export interface ExecEvidence {
  ran: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why exec was skipped (no self-test found, exec disabled, ...). */
  skippedReason?: string;
}

export interface Candidate {
  index: number;
  text: string;
  execEvidence: ExecEvidence | null;
  generationError?: string;
}

export type AxisWinner = "a" | "b" | "tie";

export interface PairVerdict {
  a: number;
  b: number;
  axes: {
    comprehension: AxisWinner;
    causality: AxisWinner;
    grounding: AxisWinner;
  };
  overall: AxisWinner;
  rationale: string;
  judgeError?: string;
}

export interface SelectionResult {
  winnerIndex: number;
  candidates: Candidate[];
  pairs: PairVerdict[];
  /** wins per candidate index */
  wins: Record<number, number>;
}

// --- Evidence / verification ---

export type AtomKind = "fact" | "causal" | "execution" | "design" | "recommendation";

export type AtomVerdict = "verified" | "unsupported" | "contradicted";

export interface EvidenceAtom {
  id: string;
  claim: string;
  kind: AtomKind;
  /** Source/justification cited by the answer for this claim. */
  support: string;
  verdict: AtomVerdict | null;
  note: string;
}

export interface HolisticVerdict {
  verdict: "approve" | "revise" | "reject";
  summary: string;
  criticalIssues: string[];
}

export interface VerificationReport {
  atoms: EvidenceAtom[];
  holistic: HolisticVerdict | null;
  holisticError?: string;
}

// --- Pipeline ---

export interface ApodexResult {
  runId: string;
  runDir: string;
  task: string;
  mode: TaskMode;
  finalAnswer: string;
  bestScore: number | null;
  gvr: GvrResult | null;
  selection: SelectionResult | null;
  verification: VerificationReport | null;
  budget: BudgetSnapshot;
  budgetExhausted: boolean;
  warnings: string[];
}

export type ProgressFn = (message: string) => void;
