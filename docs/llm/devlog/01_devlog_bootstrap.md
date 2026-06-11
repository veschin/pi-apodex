---
id: devlog-bootstrap
kind: log
---

# Devlog 01 - zero to published in one session (2026-06-11)

Built the entire project in one autonomous session: SDK research -> core
engine -> extension -> eval harness -> two measured runs -> research survey ->
improvement batch -> public GitHub release -> first live user test.

## The build

- **Step 0 research** (NOTES.md): found `completeSimple()` in
  `@earendil-works/pi-ai` as the nested fresh-context primitive; jiti alias
  table in pi's loader proves SDK imports resolve to pi's copies inside a
  session. Rejected subprocess-per-call (1-2 s startup) and nested agent
  sessions (tool overhead).
- Core engine + extension: ~2.5 kLOC TS strict. First full-pipeline smoke:
  selector ran both candidates' self-tests, GVR went 87 -> 100 off the
  written critique (visible proof the loop != best-of-K), 14/14 atoms
  verified, $0.028 / 22 calls / 336 s.
- Three critic rounds across the session; the first produced a MUST-FIX
  (dangling rejections in parallel candidate lanes under budget exhaustion ->
  `Promise.allSettled`), plus retry-usage accounting and scoring-visibility
  fixes. Final publication-batch critic round was interrupted by the user -
  logged in handoff as an open item.

## Eval: run 1 was a measurement post-mortem, not a result

Run 1 (pro engine): baseline 1.00 everywhere, all pipeline deltas negative.
Every regression root-caused from artifacts; three of three were harness
defects (crash-to-zero scoring, checker JSON fragility, timeout-retry wall
burn) - full gap table in [../90_lessons.md](../90_lessons.md). One genuine
method gap: a floating-promise bug survived static grading (grader gave 100;
hidden suite crashed). Dead ends worth remembering: `tsx -e` compiles CJS (no
top-level await); `tail -f | while ... exit` monitors hang after the final
line (no SIGPIPE until next write).

## Paper cross-check + survey

User-provided link resolved to the same Apodex-1.0 PDF as the brief; read
pp. 1-8, 16-31. §8.4's "GVR gains concentrate on low-base tasks" reframed
run 1's flat pro result as a ceiling effect -> run 2 measures both engines.
Parallel research agent produced docs/research/test-time-boosting.md (~130
sources): consensus = external/grounded feedback works, intrinsic
self-critique doesn't; models fix located errors, not described ones; weak×N
beats strong×1 only under execution-grounded selection.

## Run 2 (reported) + improvement batch

- flash: 0.96 -> 1.00 overall, design 0.89 -> 1.00 (+0.11), unstable baselines
  (0.75/0.88/0.75) pinned to 1.00; flash+pipeline ≈ pro single-pass quality
  at ~1.9× one pro pass's cost. pro: 0.99 -> 0.99 (honest null).
- Costs: flash pipeline $0.139 / 192 calls; pro pipeline $0.691 / 220 calls.
- Built `eval/analyze-run.ts`; on run 2: 0 defects, 6 risks (wall near-misses
  93-109 %, two revision regressions absorbed by best-tracking, one judge
  verdict recovered as tie).
- Improvement batch from analysis + survey: per-round exec probe with
  verbatim output to grader/reviser and a deterministic 59-cap on failing
  probes (verified live + stubbed-client determinism check: lenient 95 -> 59,
  early-stop suppressed); judge verdict enum-regex recovery; shared
  `extractBoolField`/`extractEnumField`.

## Publication + first user contact

- Academic-style README (abstract/ToC/methodology/threats-to-validity), D2
  sequence diagram, published eval artifacts, MIT; repo
  github.com/veschin/pi-apodex; pushed via SSH. Local quirk: HTTPS to
  github.com is reset on this network - README gained an SSH install
  fallback; pristine-clone load (no node_modules) verified the
  devDependencies packaging decision.
- First live test: user typed `/apodex <giant Minecraft task>` and saw
  nothing - slash commands consume the input line and progress lived only in
  the footer. Two runs were actually executing (artifacts confirmed). Shipped
  launch echo + progress widget + chat-visible failures (commit 16eb32b).
  Lesson recorded in [../90_lessons.md](../90_lessons.md).

## Numbers

11 commits, ~440 LLM sub-calls across eval runs and smokes, total model
spend ≈ $1.6. Final state: tsc clean, selfcheck 6/6 expectations, analyzer
0 defects on the reported run.

## Seeds

- "The eval harness lied before the model did" - measurement-first
  engineering for LLM pipelines.
- "87 -> 100 off a written critique" - what separates GVR from best-of-K in
  practice.
- "Weak engine + verification ≈ strong engine" - the cascade economics angle
  with real dollar numbers.
