---
id: lessons
kind: lesson
---

# Lessons (post-mortems with measured gaps)

See also: [50_eval.md](50_eval.md) · [20_pipeline.md](20_pipeline.md).

Append-only. Every entry traces to a specific incident in this repository's
history (full narratives in DEVLOG.md; this file keeps the rules).

## Eval run 1 post-mortem (results/20260611-155816, commit f1ac466)

Context: first full 9-task run, pro engine. Baseline scored 1.00 everywhere;
ALL pipeline deltas were negative. Artifact-level diagnosis showed three of
three regressions were **measurement defects**, not model facts.

### Measured gap

| Item | Reported by harness | Actual (from artifacts) |
|------|--------------------|-------------------------|
| code-retry pipeline | 0.00 | 7/10 hidden checks objectively passed before an uncaught-rejection crash |
| design-rate-limiter "429" rubric item | failed | checker said `"pass": true` inside structurally invalid JSON |
| design-dedup-store pipeline | 0.88, budget-exhausted | two 360 s timeout-aborts of one healthy generation burned 968 s of a 900 s wall cap; GVR-68 draft shipped unrevised |
| code-retry GVR grade | 100/100 | the answer crashed its own hidden suite at runtime (floating promise) |

### Root causes

1. Crash-to-zero scoring: hidden tests reported only at the end, so a
   mid-suite crash destroyed partial credit.
2. Checker free-text JSON fragility: one unescaped quote invalidated a
   machine-reliable boolean.
3. Fixed per-attempt timeout: a slow-but-healthy call was re-aborted at the
   same mark; retries burned wall budget without new information.
4. Static-only grading: execution evidence existed (selector self-tests) but
   the grader never saw it; prose review cannot catch a floating-promise bug.

### Rules

1. **Tests report after every check and trap process-level failures**
   (uncaughtException/unhandledRejection); the scorer takes the last tally.
   Enforced by eval/selfcheck.ts.
2. **Machine fields are recovered by regex when JSON parsing fails**
   (`extractBoolField`/`extractEnumField`); free-text recovered this way is
   never trusted.
3. **Per-attempt timeouts escalate** (1×/1.5×/2×) so a retry buys more time,
   not the same failure.
4. **Execution evidence goes to the grader and reviser; a failing probe caps
   the round score at 59** (no early-stop on observed-broken code). Enforced
   deterministically in src/gvr.ts, verified with a stubbed-client check.
5. **Run the analyzer before believing a number**; "pipeline worse than
   baseline" is a DEFECT flag demanding artifact-level root-cause, not a
   conclusion.

## Ceiling effect (run 1 -> run 2 design change)

Context: run 1's flat result on the pro engine was initially read as "no
uplift". The original report's §8.4 (GVR gains concentrate on low-base
tasks: IMO-Hard 12.38 -> 34.29) reframed it: the suite was saturated for the
engine, not the method useless.

Rule: **measure uplift where single-pass actually fails** - run the weak
engine in heavy roles (run 2: flash design 0.89 -> 1.00) and report the strong
engine's null result as a ceiling, honestly. A flat delta at a 0.99 baseline
is a statement about the task suite, not the method.

## TUI silence incident (commit 16eb32b)

Context: first real user test. `/apodex <huge task>` consumed the input line
(slash-command semantics), showed only a footer status, and the user
concluded "ноль реакции" while two runs were in fact executing.

Rule: **every long-running command posts an immediate chat-visible launch
echo, mirrors progress to a widget, and posts failures to chat** - a footer
status is invisible to a user who does not know to look for it. Verify UX
paths by their artifacts (`.apodex/runs/`) since print mode does not echo
custom messages.
