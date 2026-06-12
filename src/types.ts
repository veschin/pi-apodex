// Core domain types for the apodex pipeline.
// All sub-call I/O is single-turn: one system prompt + one user message per call.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type RoleName = "analyst" | "generator" | "grader" | "verifier" | "worker" | "judge" | "scout";

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

/** Delivery stage (task-shape classification + apply-steps plan). */
export interface DeliveryConfig {
  /** Run the delivery-planner sub-call (handoff.md is written regardless). */
  planEnabled: boolean;
}

/** Task-brief stage (analyst elaboration before any solution work). */
export interface BriefConfig {
  /** Run the analyst brief stage at the start of every run. */
  enabled: boolean;
}

/** Workspace context-gathering stage (scout request-read loop). */
export interface ContextConfig {
  enabled: boolean;
  /** Scout request-read rounds, 1..4. */
  maxRounds: number;
  /** Total files admitted into the pack, 1..40. */
  maxFiles: number;
  /** Per-file byte cap (head of the file beyond it), 1 KB..256 KB. */
  maxFileBytes: number;
  /** Whole-pack byte cap, 4 KB..1 MB. */
  maxTotalBytes: number;
  /** Listing entries shown to the scout, 50..5000. */
  maxListingEntries: number;
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
  brief: BriefConfig;
  context: ContextConfig;
  delivery: DeliveryConfig;
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
  inputTokens: number;
  outputTokens: number;
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

// --- Workspace context pack ---

export interface ContextFileEntry {
  /** Path relative to the workspace root (as listed). */
  path: string;
  /** Bytes included in the pack (after capping). */
  bytes: number;
  /** Actual file size on disk. */
  totalBytes: number;
  truncated: boolean;
  content: string;
}

export interface ContextPack {
  /** True when at least one file made it into the pack. */
  gathered: boolean;
  /** Why nothing was gathered (self-contained task, disabled, empty workspace, ...). */
  skippedReason?: string;
  /** Scout's orientation summary of the gathered material. */
  map: string;
  files: ContextFileEntry[];
  listingCount: number;
  listingTruncated: boolean;
  /** Scout calls actually made. */
  rounds: number;
  totalBytes: number;
  warnings: string[];
}

// --- Delivery plan ---

export type TaskShape = "implementation" | "analysis" | "answer";

export interface DeliveryPlan {
  taskShape: TaskShape;
  /** Concrete imperative steps for the calling agent (implementation tasks). */
  applySteps: string[];
  /** Decision-relevant points of the answer. */
  keyPoints: string[];
  /** Unverified / assumed / deferred items the answer names. */
  openItems: string[];
}

// --- Brief stage ---

/** Early-stop payload: the run paused for user input before any solution work. */
export interface Clarification {
  kind: "questions" | "brief-review";
  /** Blocking questions (kind=questions). */
  questions: string[];
  /** Draft brief awaiting user approval (kind=brief-review). */
  briefDraft: string | null;
}

// --- Pipeline ---

export interface ApodexResult {
  runId: string;
  runDir: string;
  task: string;
  mode: TaskMode;
  finalAnswer: string;
  /** Applied task brief (approved-in-task or analyst-generated), if any. */
  brief: string | null;
  /** Set when the run paused for clarification; finalAnswer is "" then. */
  clarification: Clarification | null;
  bestScore: number | null;
  gvr: GvrResult | null;
  selection: SelectionResult | null;
  verification: VerificationReport | null;
  contextPack: ContextPack | null;
  deliveryPlan: DeliveryPlan | null;
  budget: BudgetSnapshot;
  budgetExhausted: boolean;
  warnings: string[];
}

export type ProgressFn = (message: string) => void;
