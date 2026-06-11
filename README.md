# pi-apodex

Verification-centric deep-reasoning extension for [Pi](https://github.com/badlogic/pi-mono).
It layers an agent team with **external verification** on top of whatever model the
session runs: instead of one pass of one model, a task goes through candidate
sampling with execution evidence, a generate->verify->revise loop steered by an
independent grader's written critique, claim-by-claim audit by an external
verifier, and an evidence-disciplined final assembly.

The method replicates the inference-time portion of the Apodex-1.0
verification-centric agent-team approach: reliability comes not from a bigger
model, but from a team that audits its own conclusions in fresh, isolated
contexts before committing.

## Architecture

```
task ──► mode classifier (worker)
              │
              ▼  (code mode, N>1)
      ┌─ selector ────────────────────────────────┐
      │ N parallel candidates (generator, t=0.8)  │
      │ node-executed self-tests -> exec evidence  │
      │ pairwise judge on 3 axes (worker, t=0):   │
      │   comprehension / causality / grounding   │
      └──────────────── winner ───────────────────┘
              │
              ▼
      ┌─ GVR loop, K rounds ─────────────────────┐
      │ exec probe (code): attempt's self-test   │
      │   runs each round; verbatim output goes  │
      │   to grader AND reviser; a failing probe │
      │   caps the round score at 59 (no early   │
      │   stop on observed-broken code)          │
      │ grade: FRESH context, sees ONLY task +   │
      │   candidate + exec evidence -> score +   │
      │   WRITTEN critique (hifi rubric encoded) │
      │ revise: generator steered by critique +  │
      │   verbatim failing-test output           │
      │ early stop at scoreThreshold             │
      └──────────────── best ────────────────────┘
              │
              ▼
      ┌─ external verifier ──────────────────────┐
      │ claim atoms extracted (worker)           │
      │ each atom audited independently against  │
      │   task + answer + exec evidence          │
      │ holistic approve/revise/reject (verifier)│
      └──────────────────────────────────────────┘
              │
              ▼
      assembler: final answer rebuilt from verified atoms;
      contradicted claims corrected/removed, unsupported ones
      flagged "Unverified:" or dropped; verification status appended
```

Key invariants:

- **Fresh context per sub-call.** Every sub-call is a single-turn
  `completeSimple()` with a context built from scratch. A grader/verifier/judge
  can never see another agent's reasoning trace - only the task and artifacts.
- **The grader rubric is the hifi bar**: unhandled error paths, ignored edge
  cases, missing boundary validation, error-swallowing catches, TODO-hiding,
  asserted-but-unobserved correctness, and (for design) missing failure modes /
  rejected alternatives all subtract from the score. The written critique
  steers the next revision - without it the loop would degenerate into
  best-of-K sampling.
- **Hard budgets everywhere**: max sub-calls, max tokens, max USD, max wall
  time, per-call timeout, bounded retries; K clamped 1..10, N clamped 1..8.
  On exhaustion the best-so-far answer is returned, flagged `budgetExhausted`.
- **Auditability**: every run persists to `.apodex/runs/<runId>/` - config
  snapshot, every sub-call (role, model, prompts, response, usage, timing),
  grades, pairwise verdicts, evidence atoms, the final answer.

## Install / load

```bash
cd ~/ai/pi-apodex && npm install

# one-off
pi -e ~/ai/pi-apodex/index.ts

# permanent: symlink into the global extensions dir
ln -s ~/ai/pi-apodex ~/.pi/agent/extensions/pi-apodex
```

(Inside pi, imports resolve to pi's own SDK copies via jiti aliasing; the local
`node_modules` is only used for typechecking and the standalone eval harness.)

## Invoke

- **By the model**: the session model sees an `apodex` tool
  (`task`, optional `mode: auto|design|code|incident|general`, `rounds`, `candidates`)
  and delegates hard tasks to it.
- **By the user**: `/apodex <task text>` runs the pipeline directly and posts
  the result into the session; `/apodex-config` shows the effective config.
- **Standalone (no pi session)**: `npx tsx eval/smoke-pipeline.ts`.

## Configuration

Provider-agnostic roles. Defaults: `generator`/`grader`/`verifier` = the
session's active model (falls back to `deepseek/deepseek-v4-pro` when no session
model exists, e.g. standalone); `worker` = `deepseek/deepseek-v4-flash`
(falls back to the session model if deepseek credentials are absent).

Precedence: defaults ← `.apodex.json` (cwd) ← env `APODEX_*` ← tool params.

```jsonc
// .apodex.json
{
  "roles": {
    "generator": "session",                       // or "provider/model-id"
    "grader":    { "model": "deepseek/deepseek-v4-pro", "thinking": "high", "temperature": 0 },
    "verifier":  "session",
    "worker":    "deepseek/deepseek-v4-flash"
  },
  "rounds": 4,            // K, 1..10
  "candidates": 4,        // N, 1..8 (code mode)
  "scoreThreshold": 92,   // GVR early stop
  "budget": {
    "maxSubCalls": 60, "maxTotalTokens": 3000000, "maxCostUsd": 5,
    "maxWallTimeMs": 1800000, "subCallTimeoutMs": 360000, "subCallMaxRetries": 2
  },
  "exec": { "enabled": true, "timeoutMs": 10000 },
  "runsDir": ".apodex/runs"
}
```

Env equivalents: `APODEX_GENERATOR`, `APODEX_GRADER`, `APODEX_VERIFIER`,
`APODEX_WORKER` (`"provider/id"` or `"session"`), `APODEX_ROUNDS`,
`APODEX_CANDIDATES`, `APODEX_SCORE_THRESHOLD`, `APODEX_MAX_SUBCALLS`,
`APODEX_MAX_TOTAL_TOKENS`, `APODEX_MAX_COST_USD`, `APODEX_MAX_WALL_TIME_MS`,
`APODEX_SUBCALL_TIMEOUT_MS`, `APODEX_SUBCALL_MAX_RETRIES`,
`APODEX_EXEC_ENABLED`, `APODEX_RUNS_DIR`.

## Eval harness

Nine engineering tasks in three buckets, each with a programmatic check; every
task runs single-pass baseline (mean of 3 samples - single-pass failure is a
frequency, not a single draw) vs full pipeline (one run), on the SAME engine.
`--engine pro|flash|both` selects which model fills the heavy roles; the worker
role is always deepseek-v4-flash in both arms.

- **code** (3): non-trivial implementations (interval subtraction with
  half-open semantics; retry with deterministic backoff/abort/AggregateError;
  async LRU+TTL+single-flight cache) scored by hidden node tests the models
  never see. Tests report after every check and trap uncaught
  exceptions/unhandled rejections, so a crash mid-suite keeps partial credit
  (fraction passed).
- **design** (3): rate limiter / webhook delivery / dedup blob store, scored
  against a locked rubric of required failure-mode handling, each item a strict
  yes/no check (flash, t=0) with regex fallback against malformed checker JSON.
- **incident** (3): symptom+logs with planted red herrings (pool-leak early
  return; cache stampede; DST-skipped cron), scored against the known root
  cause; confidently-wrong diagnoses tracked separately.

```bash
npx tsx eval/selfcheck.ts          # validates the hidden tests themselves
npx tsx eval/run-eval.ts           # full suite (9 tasks), pro engine
npx tsx eval/run-eval.ts --engine both --concurrency 3
npx tsx eval/run-eval.ts --smoke   # 1 task/bucket, lighter knobs
npx tsx eval/run-eval.ts --only retry --rounds 3 --candidates 3
npx tsx eval/analyze-run.ts eval/results/<stamp>   # post-run defect analysis
```

Results (summary table, per-task details, full answers, every sub-call) land in
`eval/results/<timestamp>/`.

### Measured results (2026-06-11, `eval/results/20260611-164416`)

Both engines, 9 tasks, K=4 rounds, N=4 candidates, baseline = mean of 3
single-pass samples with identical prompts/conventions:

| engine (heavy roles) | bucket | baseline | pipeline | delta |
|---|---|---|---|---|
| **flash** | design | 0.89 | **1.00** | **+0.11** |
| **flash** | code | 1.00 | 1.00 | 0.00 |
| **flash** | incident | 1.00 | 1.00 | 0.00 |
| **flash** | **overall** | **0.96** | **1.00** | **+0.04** |
| pro | design | 0.97 | 0.96 | −0.01 |
| pro | code | 1.00 | 1.00 | 0.00 |
| pro | incident | 1.00 | 1.00 | 0.00 |
| pro | **overall** | **0.99** | **0.99** | −0.00 |

Honest reading:

- **The uplift lives where single-pass is weak.** On the flash engine the
  pipeline lifted every design task to 1.00 from unstable baselines
  (per-sample spreads like 0.75/0.88/0.75) - design rubrics demand failure
  modes, rejected alternatives, and atomicity discussion that flash misses
  single-pass and the grader critique reliably extracts. This mirrors the
  Apodex paper's own GVR pattern: gains concentrate on low-base tasks.
- **flash + pipeline matched pro single-pass quality** (1.00 vs 0.99) at
  ~$0.0155/task vs ~$0.0082/answer for pro single-pass - a weak-engine +
  verification cascade reaches strong-engine quality at ~2x its single-pass
  price (and ~10x flash single-pass price).
- **The pro engine saturates this task set** (0.99 baseline): the pipeline
  cannot add what a single pass already delivers; the −0.04 on one design task
  is within that task's own baseline sample noise (0.88/0.88/1.00). We report
  this flat result rather than tuning tasks until the headline looks better.
- Run-1 vs run-2 process delta: the first full run surfaced 4 measurement/
  robustness defects (crash-to-zero scoring, checker JSON fragility, timeout
  retry burn, wall-cap pressure) - all diagnosed from artifacts and fixed;
  `eval/analyze-run.ts` now finds 0 defects on run 2. Full post-mortems in
  DEVLOG.md.

## Repository layout

```
index.ts          extension entry (tool + commands)
src/
  config.ts       defaults, .apodex.json + env overrides, clamping
  types.ts        domain types
  budget.ts       central budget guard
  roles.ts        role -> model+auth resolution (provider-agnostic)
  llm.ts          SubCallClient: isolated sub-calls, timeout/retry/budget
  json.ts         robust JSON extraction from model output
  exec.ts         node self-test execution in tempdirs
  prompts.ts      all role prompts incl. the hifi grading rubric
  gvr.ts          generate -> verify -> revise loop
  selector.ts     N candidates + pairwise causal-evidence tournament
  verifier.ts     claim atoms, per-atom audit, holistic verdict
  pipeline.ts     stage composition + persistence
  store.ts        run artifact store
eval/             eval harness (see above)
NOTES.md          Pi SDK research findings (step 0)
DEVLOG.md         decision log
```

## Deferred work (explicitly not in v1)

Research-backed roadmap (full survey with sources and measured gains:
`docs/research/test-time-boosting.md`):

- **Consistency-gated escalation (cascade)**: use agreement among the N
  candidates as a free confidence signal - agree -> fewer rounds/shallower
  verification; disagree -> escalate generator/grader flash->pro. Literature
  shows strong-model parity at 40-60% of its cost.
- **Early-stopping candidate sampling**: draw candidates incrementally, stop
  on window agreement (3-8x selector-cost reduction in published results).
- **Cross-family judge panel**: flash-class judges score near/below random on
  hard correctness pairs and same-family graders correlate; a small
  heterogeneous voting panel is cheap insurance. Roles are already pinnable
  per provider (`APODEX_GRADER=...`), the panel is not built yet.
- **Quote-anchored critiques**: require the grader to attach a verbatim quote
  from the candidate to every violation; mechanically reject quoteless ones -
  cheap counter to invented problems (verification theater).
- **Web-verifying atom auditor**: SAFE-shaped search-grounded fact checks plus
  an "undecidable" verdict; mitigates unknown-unknowns the model family shares.
- **Deterministic dependency gates**: registry/symbol existence checks against
  hallucinated packages/APIs in code answers (5-22% hallucination rates in
  the literature; near-zero check cost).
- **Sandboxed execution**: candidate self-tests run via local `node` in a
  tempdir with a minimal env and hard timeout - adequate for locally-authored
  eval code, NOT a security boundary for untrusted tasks. Container/vm
  isolation is the v2 path.
- **Tool-using sub-agents**: nested `createAgentSession` would let the verifier
  read files / run commands itself; rejected for v1 to keep sub-calls cheap and
  isolated.
- **Statistical eval rigor**: baselines are mean-of-3, but the pipeline arm is
  a single run per task; repeat-sampling both arms with confidence intervals
  is future work.
- **Position-bias control in pairwise judging**: pairs are presented in index
  order with an instruction to ignore order; swap-and-rejudge would halve any
  residual bias at 2x judge cost.
- **Predictive wall-budget stop**: three pro pipelines finished at 93-109% of
  the wall cap; stopping preemptively when remaining time < typical call
  duration would convert overshoots into clean best-so-far returns.
