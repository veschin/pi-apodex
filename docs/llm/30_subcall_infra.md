---
id: subcall-infra
kind: spec
touches: src/llm.ts, src/roles.ts, src/budget.ts, src/config.ts, src/store.ts, src/exec.ts, src/json.ts
---

# Sub-call infrastructure contracts

See also: [20_pipeline.md](20_pipeline.md) · [40_extension.md](40_extension.md).

## SubCallClient (src/llm.ts)

- **Error contract**: model-level failures return `{ok: false, error}` -
  never throw. Throws are reserved for `BudgetExhaustedError` (checked
  *before* every call) and external aborts.
- **Retry policy**: bounded (`subCallMaxRetries`, default 2), backoff
  1 s / 4 s / 10 s; external abort never retries. Per-attempt timeout
  **escalates 1× / 1.5× / 2×** (a healthy-but-slow generation must not be
  re-aborted at the same mark - lesson from run 1, see
  [90_lessons.md](90_lessons.md)).
- **Usage accounting is cumulative across attempts** - every retry's tokens
  hit the budget, not just the final response's.
- **Empty response text counts as a failure** (retryable), `stopReason ===
  "length"` does not - truncation is surfaced by the eval analyzer instead.
- Every call (including failures) is appended to `subcalls.jsonl` with full
  prompts, response, usage, timing, retries.

## Roles (src/roles.ts)

- Roles: `generator | grader | verifier | worker`. Spec value is `"session"`
  or `"<provider>/<model-id>"`.
- Resolution order: pinned model -> registry lookup; `"session"` -> session
  model -> `DEFAULT_HEAVY_MODEL` (deepseek-v4-pro). Pinned-but-unavailable
  falls back to the session model **with a surfaced `fallbackNote`** - silent
  degradation is forbidden.
- Resolution (incl. fallback) is **cached per run** by design: one run
  behaves consistently; recovery applies from the next run's fresh resolver.
- The pairwise judge, mode classifier, claim extractor, atom auditors, and
  eval rubric/diagnosis checkers all run under the **worker** role. There is
  no dedicated judge role yet (backlog - see handoff).

## Budget (src/budget.ts)

Central guard checked before every call: max sub-calls / total tokens / USD /
wall time. Exhaustion mid-run is a control-flow signal
(`BudgetExhaustedError`), not a crash. Wall check is *before* a call - a call
in flight may overshoot the cap (observed 109%; predictive stop is backlog).

## Config (src/config.ts)

Precedence: defaults ← `.apodex.json` (cwd) ← `APODEX_*` env ← inline
overrides (tool params). Everything numeric is clamped (`CLAMPS` table) with
warnings collected, never silently. K rounds 1..10, N candidates 1..8.
Defaults: K=4, N=4, threshold 92, heavy roles = session, worker =
deepseek-v4-flash.

## Artifact store (src/store.ts)

Per run: `<runsDir>/<runId>/{config.json, subcalls.jsonl, selection.json,
gvr.json, verification.json, final-selftest.json?, final.md, run.json}`.
Store **creation** failure throws (an unauditable run must not start);
**mid-run append** failures degrade to warnings (a disk hiccup must not
destroy paid work). `run.json` is written on success, budget-exhaustion AND
failure paths.

## JSON extraction (src/json.ts)

`parseJsonLoose` (fence-tolerant balanced scan) -> `extractBoolField` /
`extractEnumField` regex fallbacks for machine-reliable fields. Rationale:
checkers/judges occasionally emit structurally invalid JSON (real incident:
unescaped quote inside an evidence string) while boolean/enum fields stay
trustworthy. Use the fallbacks for any new checker; never trust free-text
fields recovered this way.

## Exec runner (src/exec.ts)

`runNodeScript`: temp dir, `node <entry>`, minimal env (`NODE_ENV=test`
only), hard timeout with SIGTERM->SIGKILL escalation (both timers cancelled on
settle), 64 KB output caps, path-traversal guard on file names. **All failure
modes return `ExecEvidence` (skippedReason) - the runner never rejects**; a
probe must not be able to kill a pipeline. NOT a security sandbox (see
[10_scope.md](10_scope.md)). `execEvidenceToText` is the single render used
by judge/grader/auditor prompts.
