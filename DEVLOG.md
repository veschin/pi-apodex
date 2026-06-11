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
