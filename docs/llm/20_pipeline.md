---
id: pipeline
kind: spec
touches: src/pipeline.ts, src/gvr.ts, src/selector.ts, src/verifier.ts, src/prompts.ts
---

# Pipeline contracts

See also: [30_subcall_infra.md](30_subcall_infra.md) · [50_eval.md](50_eval.md) · [90_lessons.md](90_lessons.md).

Stage order (`src/pipeline.ts`): mode classification -> [code mode, N>1:
candidate selection] -> GVR loop -> execution evidence for best attempt ->
claim-level verification -> conditional assembly. Human-readable method
description with diagram: README §3 - this spec holds the *invariants*.

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

## Rejected alternatives (and why)

- **pi subprocess per sub-call** (research-workflow pattern): 1-2 s startup
  per call, weaker typing. Rejected for in-process `completeSimple`.
- **Nested `createAgentSession`**: full agent loop with tools per sub-call -
  heavier, unneeded for tool-less verifier/grader calls.
- **Model-driven orchestrator**: adaptive but unpredictable/unbudgetable at
  local scale; stage order is deterministic code instead.
- **Single mega-prompt**: no isolation, no objective anchors; explicitly
  forbidden by the project brief.

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
