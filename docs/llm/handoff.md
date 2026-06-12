---
id: handoff
kind: guide
---

# Handoff

State as of 2026-06-12 (second session that day): brief stage (task analyst)
+ heavy judge implemented and verified locally; NOT committed when this file
was written - the session ends with the commit. Previously published state:
commit `7ca3b50` (main, https://github.com/veschin/pi-apodex).

## What exists (verified this session)

- **Brief stage** (`src/brief.ts`, devlog 03): an `analyst` role
  (session-heavy, thinking high) elaborates the raw task BEFORE any solution
  work. Interactive runs can PAUSE: clarification questions or a draft brief
  for user review come back as `ApodexResult.clarification`; the session
  model relays them and re-invokes with `# Clarification answers` /
  `# Approved brief` sections in the task (stateless, chat-mediated).
  Ready briefs join the shared materials as `# Task brief`; acceptance
  criteria are enforced by the selftest convention and the grader.
- **Judge is a heavy role now**: session model + thinking high by default
  (was: mirror of the flash worker, thinking off). Scout still mirrors.
- Full pipeline: brief -> scout context -> classify -> [code: candidates ->
  exec -> judge] -> GVR -> claim audit -> assembly -> delivery. tsc clean,
  selfcheck passes, live flash verification of both brief paths (pause with
  questions; approved-brief end-to-end, $0.0074).
- Eval protocol pin 2 (50_eval.md): brief OFF + judge pinned flash in
  run-eval.ts - published `docs/eval-results/20260611-164416` numbers stay
  comparable. Both smokes pin `APODEX_BRIEF_ENABLED=0`.

## What does NOT exist

- **Validation status (user-mandated note, 2026-06-12): this session's code
  was NOT fully validated and may contain bugs.** What ran: tsc, selfcheck,
  ONE live flash run of the questions path and of the approved-brief path,
  the user's live TUI run of the questions round-trip, two critic rounds.
  What never ran: the brief-review pause live, a full clarification->answers->
  approved-brief->final-answer cycle end-to-end, acceptance-criteria
  enforcement quality on real tasks, any run with the new heavy-judge default
  in the selector path. Treat src/brief.ts and the pipeline wiring as
  lightly-tested until exercised.
- README not updated this session: §3 method description, the roles table,
  and config docs predate the analyst role and brief stage.
- No in-TUI live test of the clarification round-trip (tool result ->
  session model relays -> re-invocation) - verified only at the runApodex
  API level; the wake-up itself is TUI behavior.
- **No execution sandbox** (user-flagged as REQUIRED, 2026-06-12): self-tests
  run model-authored code directly on the host as a bare node process (no
  shell inherited, env stripped to NODE_ENV) - but the test code itself can
  spawn arbitrary processes via child_process, write outside its tempdir, and
  open network connections; heavy tests also compete with the host for
  CPU/RAM. The narrow runner is behavioral discipline, not a boundary.
- Everything from the previous handoff still open: no abort for
  /apodex-launched runs, no detached runs, no web-grounded verification, no
  judge panel, no consistency cascade.
- The eval cannot measure the brief stage or the heavy judge (saturated at
  pro, and both are pinned off for comparability); a harder benchmark is the
  prerequisite - also for the user's "catch up to Opus" question.

## Open design questions (user asked to mark these; resolve later)

See 20_pipeline.md "Open questions (brief stage)": review-stop friction
(every standard-complexity interactive run pauses), analyst runs before
scout (no workspace context when asking), approved-brief marker can match
inside a code fence, no cross-run question cap, complexity gate is prompt
judgment, eval judge pin diverges from in-session defaults.

## Current problems (user-facing, live)

1. The user's live pi session needs `/reload` to get the new extension code,
   then one real `/apodex` with a vague task to see the clarification
   round-trip in the TUI (first live exercise of triggerTurn on
   apodex-clarification messages).
2. Huge monolithic tasks: the analyst now negotiates slicing in the brief,
   but the user still slices projects manually across runs.
3. **Cross-run context (backlog, 2026-06-12, live incident)**: runs are
   stateless and the calling model does not realize it - a follow-up
   "имплементируй диздок" arrived without the previous run's design doc
   (run-20260612-163401); the analyst correctly paused, the session model had
   to be told to inline the prior final.md. Fix directions: state
   STATELESSNESS explicitly in the tool/task param descriptions ("no memory
   of previous runs or this chat - inline prior outputs"), have
   composeDelivery advertise "reference <runDir>/final.md in follow-up
   tasks", and/or let the scout see runsDir artifacts (.apodex/runs is
   gitignored, so invisible to the listing today).
4. **Browser/visual tasks have no verification path (backlog, 2026-06-12,
   live incident)**: the user fed a Three.js/WebGL single-HTML design doc;
   the pipeline can only run node self-tests, so there is NO execution
   evidence for browser code - the session model correctly bailed and
   implemented it directly ("apodex зациклился ... реализую сам"). The
   analyst asks about format but has no verdict for "this task does not fit
   the pipeline - implement outside it"; its outcomes are only questions /
   ready. Fix directions: add an analyst verdict "unfit" (with the reason)
   that tells the caller to implement directly rather than looping; OR a
   browser/headless runner (ties into option F sandbox); until then, the
   honest answer for GUI/visual work is "don't route it through apodex".

## Next options (user picks; not a queue)

- **A. Live TUI round-trip test (~15 min, blocks nothing).** /reload, run
  `/apodex хочу клон факторио в 3д`, answer the questions, approve the brief,
  watch the full flow.
- **B. Harder benchmark (~1 d).** Tasks where pro baseline lands 0.5-0.8;
  unlocks measuring brief/judge/Opus-comparison. Optional third arm: Opus
  single-pass baseline (roles are provider-agnostic).
- **C. README refresh (~1-2 h).** §3 + roles/config tables: analyst, brief,
  clarification contract, judge default.
- **D. Brief-review config gate (~1 h).** `brief.review: always|never` for
  users who want questions but not the review stop.
- **E. Previous options remain**: judge panel, consistency cascade,
  command-path abort, detached runs.
- **F. Execution sandbox (~1-2 d, user-flagged REQUIRED).** Isolated runner
  for self-tests (container or equivalent) with CPU/RAM/time caps and no
  default network: (1) keeps heavy tests from loading the host system,
  (2) makes running model-authored code an actual security boundary instead
  of convention. Prerequisite for untrusted/hostile tasks; unlocks the
  multi-language runner registry (go/python) and any relaxation of the
  no-npm/no-network selftest convention.

## Read order

1. This file.
2. [20_pipeline.md](20_pipeline.md) - invariants 17-18 + open questions are
   new (brief stage).
3. [30_subcall_infra.md](30_subcall_infra.md) - seven roles, scout-only
   mirroring; [40_extension.md](40_extension.md) - clarification contract.
4. [50_eval.md](50_eval.md) - protocol pin 2 - and
   [90_lessons.md](90_lessons.md) before trusting any measurement.
5. [devlog/03_devlog_brief_stage.md](devlog/03_devlog_brief_stage.md) for
   this session's reasoning.

## Smoke test (run before touching anything)

```bash
cd ~/ai/pi-apodex && npx tsc --noEmit && npx tsx eval/selfcheck.ts
# expected: no tsc output; selfcheck ends with
# "SELFCHECK PASSED: hidden tests are sound"

npx tsx eval/smoke-context.ts
# expected: "SMOKE-CONTEXT PASSED" (~80 s, ~$0.02, all-flash, brief pinned off)
```

Brief-stage live check (no committed smoke yet - token-economy decision):
re-create the two-path script from devlog 03 / this session's transcript, or
run option A above. Path assertions: vague task + briefInteractive ->
`clarification.kind === "questions"`; task containing `# Approved brief` ->
no pause, `result.brief !== null`.

## Agent errors to log

1. (carried over, still open) The final critic round over the publication
   batch (README/LICENSE/packaging) was interrupted on 2026-06-11 and never
   re-run.
2. The shared-value wiring lesson struck AGAIN (third time): `enrichedTask`/
   `materials` reached most-but-not-all consumers (assembler, planner,
   handoff renderer missed); the critic caught it, same as devlog 02. The
   90_lessons rule ("grep every call site of the thing it replaces") was not
   applied during implementation - it must run BEFORE handing to the critic.
