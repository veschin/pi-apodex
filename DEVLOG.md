# DEVLOG

## 2026-06-11 - Step 0: harness research

- Verified pi 0.79.1, package layout, docs, examples. Full findings in NOTES.md.
- **Decision: in-process nested calls via `completeSimple()` from `@earendil-works/pi-ai`**,
  auth via `ctx.modelRegistry.getApiKeyAndHeaders(model)` (extension) or
  `ModelRegistry.create(AuthStorage.create())` (standalone eval). Rejected
  pi-subprocess-per-call (1-2 s startup overhead each, weaker typing) and nested
  `createAgentSession` (heavier; only needed if sub-agents get tools - deferred).
- Smoke test: headless `pi -p` call to deepseek-v4-flash returned `ok`. Keys resolve.

## 2026-06-11 - Architecture decisions

- **Single-turn sub-calls only.** Any history (previous attempt, critique) is embedded in
  the one user message. Reasons: (a) hard context isolation by construction - a grader can
  never see generator reasoning; (b) sidesteps DeepSeek
  `requiresReasoningContentOnAssistantMessages` compat for multi-turn assistant messages.
- **Pipeline** (mode-aware): [N candidates -> exec evidence -> pairwise causal selection]
  (code mode) -> GVR loop K rounds (grade in fresh ctx: numeric score + written critique;
  revise steered by critique; early-stop at score threshold) -> external verifier (claim
  atoms extracted, each audited; holistic audit) -> assembly from verified atom pool.
- **Roles**: generator / grader / verifier / worker. Default: heavy roles = session-active
  model, worker = deepseek-v4-flash; standalone fallback = deepseek-v4-pro. Every role
  overridable (`provider/model-id` or `session`) via env `APODEX_<ROLE>` or `.apodex.json`.
- **Budgets enforced centrally** in the sub-call client: max sub-calls, max total tokens,
  max USD cost, max wall time; K clamped 1..10, N clamped 1..8. On budget exhaustion the
  pipeline returns best-so-far flagged `budgetExhausted`.
- **Persistence**: every run writes `.apodex/runs/<runId>/` - config snapshot, every
  sub-call record (role, model, prompts, response, usage, timing), grades, pairwise
  verdicts, evidence atoms, final answer. Auditable end to end.
- **Execution evidence** (code mode): candidate's self-test executed via `node` in a
  tempdir, 10 s timeout, output captured and fed to the selector judge. No network, no
  env passthrough. Full sandboxing deferred (README).
- Eval harness runs the same engine standalone (no pi session) via tsx; baseline =
  one single-pass call with the same model+thinking; scorers are programmatic per bucket.

## 2026-06-11 - Implementation log

- Scaffolded package (`type: module`, pinned `@earendil-works/pi-coding-agent@0.79.1`,
  tsx+typescript dev deps). tsconfig strict with `allowImportingTsExtensions` (jiti and
  tsx both want explicit `.ts` specifiers; package is never emitted, `noEmit`).
- Extension load observed: `pi -e ./index.ts -p` lists `apodex` among available tools.
- Full-pipeline smoke observed (standalone, deepseek pro+flash, rounds=2, candidates=2,
  code task): selector ran both self-tests and picked a winner; GVR round 1 scored
  87/100, revision per critique reached 100/100 with early stop; verifier audited
  14/14 atoms verified, holistic approve; 22 sub-calls, 59k tokens, $0.028, 336 s.
  Artifacts complete in `.apodex/runs/run-20260611-152826-s9azd1/`. The
  critique-steered revision visibly improved the answer - the GVR loop works as
  designed, not as best-of-K.
- In-pi integration observed: a deepseek-flash host session called the `apodex`
  tool; run completed through `ctx.modelRegistry` auth (status completed,
  score 100, holistic approve, 9 sub-calls, 60 s) with artifacts in the
  configured runs dir.
- Eval harness self-check: reference solutions score 1.00 on all three hidden
  code tests; deliberately broken variants score 0.50-0.56. The hidden tests
  measure what they claim. Also fixed a spec conflict the self-check exposed:
  `retry` must be a sync-validating function returning a Promise (an
  `async function` cannot throw TypeError synchronously).
- Critic round on the core engine produced 1 MUST-FIX (dangling rejected
  promises in parallel candidate generation under budget exhaustion ->
  Promise.allSettled), 2 SHOULD-FIX (retry token usage missing from budget
  accounting; rubric-check errors silently scored as failed requirements ->
  now tracked and surfaced), 2 NIT (SIGKILL timer bookkeeping; resolver cache
  invariant documented). All applied; tsc + selfcheck re-verified.

## 2026-06-11 - Eval run 1 post-mortem (results/20260611-155816)

Run 1 (pro engine, 9 tasks): baseline 1.00 on ALL tasks - deepseek-v4-pro
single-pass saturates this task set. All pipeline deltas were negative; each
was traced to a concrete cause via run artifacts:

1. code-retry -1.00: the pipeline's final solution races an attempt against an
   abort and leaves the loser's rejection unhandled -> node crash mid-suite ->
   "APODEX_TESTS" never printed -> 0 despite 7/10 checks objectively passing
   before the crash. Two distinct findings: (a) a REAL pipeline miss - static
   grading/verification cannot catch a floating-promise bug (the grader gave
   100; the verifier flagged 2 other genuine defects but not this one);
   (b) a measurement defect - crash-to-zero destroys partial credit.
   Fixes: hidden tests now report after every check + trap
   uncaughtException/unhandledRejection (re-scored: 0.70 with a crash note);
   generator selftest convention now requires per-requirement checks incl.
   abort paths and process-level leak handlers.
2. design-dedup-store -0.13: two 360 s timeout-aborts on one generation burned
   the 15-min wall budget; pipeline shipped the ungraded round-1 attempt
   (GVR 68) without revision/verification. Fixes: per-retry timeout escalation
   (1x/1.5x/2x) in SubCallClient; eval wall cap 15 -> 20 min.
3. design-rate-limiter -0.13: the rubric CHECKER emitted invalid JSON (an
   unescaped quote in its evidence string) for an item that actually passed
   ("pass": true). Fix: boolean/enum field extraction falls back to a targeted
   regex when full-JSON parse fails (verified against the exact malformed
   sample).

Paper cross-check (user-provided link -> same PDF as the task brief): GVR,
fresh-context grader (task+candidate only, no reference/rubric leakage), the
three causal-evidence axes, external verifier isolation, and N=4 candidates all
match the implementation. Section 8.4 explains run 1's flat result directly:
GVR gains concentrate where the base score is LOW (IMO-ProofBench Advanced
12.38 -> 34.29) and only polish near-ceiling tasks. Consequence for the eval:
run 2 measures two engines - pro (expected ~saturated, reported honestly) and
flash in heavy roles (low base, where the verification team has headroom) -
with baseline = mean of 3 samples (single-pass failure is a frequency).

## 2026-06-11 - Run 2 (results/20260611-164416): measured uplift + analysis

Definitive two-engine run (9 tasks, K=4, N=4, baseline = mean of 3):

- flash heavy roles: overall 0.96 -> 1.00 (+0.04); design bucket 0.89 -> 1.00
  (+0.11) with unstable baselines (e.g. 0.75/0.88/0.75) lifted to 1.00 every
  time. flash+pipeline matched pro single-pass quality (1.00 vs 0.99) at
  ~$0.0155/task vs ~$0.0082/answer - the weak-engine cascade story holds.
- pro heavy roles: 0.99 -> 0.99. Saturated task set, reported flat, honestly.
  The -0.04 on design-rate-limiter is inside that task's own baseline spread
  (samples 0.88/0.88/1.00; the failed "429" rubric item was a legitimate
  judgment, not a checker error).
- eval/analyze-run.ts on run 2: 0 defects, 6 risks (3 wall-cap near misses at
  93-109%; 2 revision regressions, e.g. 85 -> 35 on flash webhooks, absorbed by
  best-tracking; 1 malformed judge verdict conservatively treated as tie).

## 2026-06-11 - Improvement batch from run-2 analysis + research survey

Research survey (docs/research/test-time-boosting.md, ~130 sources) landed;
its consensus "models fix LOCATED errors, not described ones" plus the run-1
finding that the grader was blind to available execution evidence produced:

- GVR exec probe (code mode): each round runs the attempt's own self-test;
  verbatim output goes to the grader (ground truth section in the prompt) and
  to the reviser (appended to the critique); a failing/timed-out probe caps
  the round score at 59 deterministically, which also suppresses early-stop
  on observed-broken code. Verified live (probe recorded in gvr.json, evidence
  present in grader prompt, $0.006 flash smoke) and deterministically (stubbed
  client: lenient 95 capped to 59, early-stop suppressed, reviser received the
  verbatim failing check).
- Judge verdict parsing hardened with per-field enum regex fallback (the run-2
  "unparseable verdict -> tie" case now recovers the axis verdicts).
- extractBoolField/extractEnumField consolidated into src/json.ts; the three
  duplicate exec-evidence renderers consolidated into exec.ts.
- README: measured-results section (both engines, honest reading) and a
  research-backed v2 roadmap replacing the ad-hoc deferred list.
