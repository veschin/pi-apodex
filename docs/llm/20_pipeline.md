---
id: pipeline
kind: spec
touches: src/pipeline.ts, src/gvr.ts, src/selector.ts, src/verifier.ts, src/prompts.ts, src/brief.ts, src/context.ts, src/delivery.ts
---

# Pipeline contracts

See also: [30_subcall_infra.md](30_subcall_infra.md) · [50_eval.md](50_eval.md) · [90_lessons.md](90_lessons.md).

Stage order (`src/pipeline.ts`): task brief (analyst) -> workspace context
gathering (scout) -> mode classification -> [code mode, N>1: candidate
selection] -> GVR loop -> execution evidence for best attempt -> claim-level
verification -> conditional assembly -> delivery plan + handoff.md. Human-readable method
description with diagram: README §3 (NOTE: §3 predates the context/delivery
stages) - this spec holds the *invariants*.

Every progress event is `[stage]`-prefixed (`[team] [context] [classify]
[select] [gvr] [exec] [verify] [assemble] [deliver]`), the run starts with a
`[team] role=provider/model ...` roster line, and all events are mirrored to
`progress.jsonl`.

## Numbered invariants (tests/usage rely on these)

1. **Single-turn fresh context per sub-call.** Every LLM call is one system
   prompt + one user message built from scratch. History (previous attempt,
   critique, evidence) is embedded as quoted material in the user message -
   never as assistant-role history. Reasons: hard isolation by construction;
   DeepSeek `requiresReasoningContentOnAssistantMessages` compat.
2. **The grader never sees**: a reference answer, the generator's reasoning
   trace, other rounds' critiques, or other candidates. It sees task +
   candidate + (code mode) execution evidence. Leaking a reference turns the
   grader into an oracle (original report §4.3).
3. **The written critique steers revision.** `reviserUser` receives the full
   critique text (score, violations, ordered directives); a score alone would
   degenerate the loop into best-of-K. The reviser is explicitly allowed to
   rebut factually wrong critique points.
4. **Exec probe + deterministic cap** (`src/gvr.ts`, code mode): each round
   runs the attempt's own self-test; if it ran and failed/timed out, the
   round score is capped at `EXEC_FAIL_SCORE_CAP = 59`, which also makes
   early-stop impossible on observed-broken code. The cap appends an explicit
   violation string; grader leniency cannot override observed behavior.
5. **Verbatim failure output to the reviser.** Models repair *located* errors
   far better than described ones; the probe's stdout/stderr is appended to
   the critique verbatim.
6. **Judge ranks execution evidence above prose** (`JUDGE_SYSTEM`): a passing
   self-test outranks no evidence; a failing/timed-out one is strong evidence
   against. Axes: comprehension / causality / grounding. Unparseable verdicts
   degrade to "tie" (never to a winner).
7. **Atom audit strictness**: `execution`-kind claims are `verified` only if
   supporting runtime output is present in the materials. Audit-call failure
   conservatively marks the atom `unsupported`, never `verified`.
8. **Assembly trigger**: any `unsupported`/`contradicted` atom OR holistic
   verdict != `approve`. The assembler must not invent new technical claims
   and preserves solution/selftest blocks verbatim unless an audit note names
   a concrete defect.
9. **Grade-failure policy**: two consecutive rounds without a usable grade
   abort the loop (the grading channel is broken; revising blind is
   forbidden). A single failure falls back to fresh regeneration when no
   critique exists yet.
10. **Budget exhaustion mid-pipeline** returns best-so-far flagged
    `budgetExhausted`; it never throws away paid work (unless nothing was
    generated at all - then it fails loudly).
11. **Selection determinism**: winner = most pairwise wins; ties break by
    axis wins -> passing self-test -> lowest index.
12. **Candidate generation uses `Promise.allSettled`** - a
    `BudgetExhaustedError` in one lane must stop the stage without leaving
    dangling rejections (`--unhandled-rejections=throw` safety).
13. **The context pack is shared task material** (`src/context.ts`). Gathered
    ONCE before classification and prepended to the task as `materials`;
    classifier, candidates, grader, judge, auditors, and assembler all see
    the IDENTICAL text - candidate comparability and grader isolation
    (invariant 2) are preserved because the pack is task material, not agent
    reasoning. Sub-calls stay tool-less: the scout returns paths as strict
    JSON and the orchestrator performs every read.
14. **Scout loop discipline**: at most `context.maxRounds` rounds (one scout
    call + one bounded re-ask each); requested paths must appear verbatim in
    the deterministic listing (git ls-files -z, fallback depth-capped walk);
    per-file/total byte caps; credential carriers are denied at listing AND
    read time (`DENIED_*` in src/context.ts); symlink targets are
    realpath-checked against the workspace root. Context failures degrade to
    warnings - the stage must never kill a run; only budget/abort propagate.
15. **Delivery planner never blocks** (`src/delivery.ts`): runs AFTER the
    final answer exists (worker role, one call + bounded re-ask), never
    modifies the answer; failure -> `deliveryPlan: null` + warning, and the
    generic NEXT STEP directive applies. `handoff.md` is rendered
    deterministically (no LLM) on every successful exit path.
16. **The mode classifier sees `materials`, not the bare task** - "fix the
    bug in src/x.ts" is only classifiable as code once gathered file contents
    are visible (critic catch, 2026-06-12).
17. **Brief stage (`src/brief.ts`, 2026-06-12)**: one analyst call (+ one
    bounded re-ask) BEFORE everything else. Outcomes: `questions` /
    `brief-review` pause the run (early return with
    `ApodexResult.clarification`, run.json status `needs-clarification`,
    brief.json written, NO final.md/handoff.md); `ready` joins the brief to
    the task as `# Task brief` shared material; `skipped` degrades to a
    warning - the stage must never kill a run. Re-invocation protocol is
    STATELESS: a `# Clarification answers` section in the task carries the
    user's answers; a `# Approved brief` section (regex `^# Approved brief$`,
    first match) skips the analyst entirely. Non-interactive runs forbid
    questions: one forced-assumptions re-ask, then degrade to no-brief.
18. **A generated brief is shared task material** (same rule as invariant 13):
    `enrichedTask` = task + brief feeds scout, classifier, candidates, grader,
    judge, auditors, assembler (via `materials`), the delivery planner, and
    handoff rendering. An approved brief already lives verbatim inside the
    task text. Acceptance criteria in the materials are mandatory: the
    selftest convention requires one check per criterion and the grader
    treats an unmet criterion as a substantive violation (`prompts.ts`).

## Open questions (brief stage, accepted 2026-06-12 - to revisit)

- `brief-review` pauses EVERY standard-complexity interactive run; friction
  by design (user wanted review), may deserve a config gate
  (`brief.review: always|never`).
- The analyst runs BEFORE the scout, so it cannot use workspace context when
  deciding what to ask; swapping the order (or a second analyst pass) was
  deferred for cost.
- `# Approved brief` marker matching can fire inside a code fence in the task
  text.
- No cross-run cap on question rounds; the user controls runaway dialogs in
  chat.
- trivial/standard complexity is the analyst's prompt judgment, not a
  deterministic gate.
- The eval pins the judge to flash (comparability with 20260611), so the
  "flash arm" no longer matches in-session defaults (judge=session+thinking).

## Rejected alternatives (and why)

- **pi subprocess per sub-call** (research-workflow pattern): 1-2 s startup
  per call, weaker typing. Rejected for in-process `completeSimple`.
- **Nested `createAgentSession`**: full agent loop with tools per sub-call -
  heavier, unneeded for tool-less verifier/grader calls.
- **Model-driven orchestrator**: adaptive but unpredictable/unbudgetable at
  local scale; stage order is deterministic code instead.
- **Single mega-prompt**: no isolation, no objective anchors; explicitly
  forbidden by the project brief.
- **Tool-using sub-agents for workspace context**: each agent gathering its
  own context destroys candidate comparability and makes cost unboundable;
  rejected for the orchestrator-mediated scout request-read loop.

## Prompt conventions (`src/prompts.ts`)

- The grading rubric (`HIFI_RUBRIC`) IS the quality bar; generator and grader
  share it (as target and as attack tool respectively). The bar covers: error
  paths, edge cases, boundary validation, swallowed errors, TODO-masking,
  unobserved correctness claims, missing failure modes / rejected
  alternatives (design).
- Code answers follow the block convention: ```js solution / ```js selftest,
  selftest imports `./solution.mjs`, covers every stated requirement incl.
  abort/error paths, installs process-level leak handlers, exits non-zero on
  failure. `extractCodeBlocks` (src/exec.ts) parses exactly this convention.
- All structured outputs are strict JSON; parsers live in src/json.ts with
  regex fallbacks for machine-reliable fields (see
  [30_subcall_infra.md](30_subcall_infra.md)).
