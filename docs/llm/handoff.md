---
id: handoff
kind: guide
---

# Handoff

State as of commit `16eb32b` (main, pushed to
https://github.com/veschin/pi-apodex), 2026-06-11 evening.

## What exists (verified)

- Full pipeline (selector -> GVR with exec probe -> claim audit -> assembly)
  working on all three surfaces: model-initiated tool, `/apodex` command,
  standalone (`eval/smoke-pipeline.ts`).
- **Delivery contract**: spend summary (cost/sub-calls/tokens in-out/wall) +
  inline answer <=1500 chars, else `<runDir>/final.md` path + preview + NEXT
  STEP directive; `/apodex` result wakes the session model (triggerTurn) to
  finish the user's request. File branch + token split verified headless;
  the TUI wake-up needs interactive confirmation after the user's `/reload`
  (see [40_extension.md](40_extension.md)).
- Installed for the user via symlink `~/.pi/agent/extensions/pi-apodex` -
  auto-discovered by plain `pi` (verified by headless tool listing).
- Reported eval `docs/eval-results/20260611-164416`: flash 0.96 -> 1.00
  (design 0.89 -> 1.00), pro 0.99 -> 0.99 (ceiling). Analyzer: 0 defects.
- tsc clean; selfcheck passes; 11 conventional commits; README is a
  paper-style document with diagram and one-liner install.

## What does NOT exist

- No dedicated **judge/grader model bindings** - judge, classifier,
  extractor, auditors all share the single `worker` role (see backlog #1).
- No abort for `/apodex`-launched runs (signal undefined in command context);
  Esc only works for the tool path.
- No detached runs: killing pi kills in-flight runs (artifacts survive;
  final.md does not).
- No web-grounded verification, no sandbox, no cross-family judge panel, no
  consistency-gated cascade (survey-backed roadmap in README §9).
- Pipeline eval arm is single-sample; publication-batch critic round was
  interrupted by the user and never re-run (see Agent errors).

## Current problems (user-facing, live)

1. The user's first interactive test (session in `~/ai/game`) launched two
   concurrent runs of a giant task ("MVP Minecraft") at 22:20/22:22; they die
   with that pi session and their results post only into it. The UX fix
   (launch echo + progress widget, commit 16eb32b) shipped AFTER his session
   started - he must `/reload` (when no runs are in flight) to get it.
2. Double-Enter creates duplicate runs - no debounce/queue on the command
   path.
3. Huge monolithic tasks produce mediocre value per dollar; the tool
   description now states the answer-not-implementation contract, but
   task-splitting guidance still lives only in chat advice.
4. The user's live session predates the delivery/auto-continue changes; the
   TUI wake-up (`triggerTurn`) is unverified interactively until he
   `/reload`s and runs one `/apodex`.

## Next options (user picks; not a queue)

- **A. Dedicated judge role + cross-family panel (~1-2 h).** Add
  `judge`/`grader` as first-class configurable roles (today: judge ⊂ worker;
  the user explicitly wants "another model as judge"). Then optional
  N-vote panel with majority (survey: flash-class judges near random on hard
  pairs; PoLL-style panels beat a single big judge at 7-8× less cost).
- **B. Consistency-gated cascade (~0.5-1 d).** Candidate agreement as a free
  confidence signal: agree -> fewer rounds/shallower verification; disagree ->
  escalate flash->pro. Highest expected value per dollar in the survey.
- **C. Detached runs (~0.5 d).** Run the pipeline in a spawned process with
  result delivery on session return; fixes problem 1 and the kill-pi case.
- **D. Command-path abort + double-submit guard (~1 h).** Wire an
  AbortController into the `/apodex` handler with a `/apodex-stop` command;
  ignore a second submit while one is queued.

## Read order

1. This file.
2. [20_pipeline.md](20_pipeline.md) - invariants before touching any stage.
3. [30_subcall_infra.md](30_subcall_infra.md) + [40_extension.md](40_extension.md)
   as needed for the chosen option.
4. [50_eval.md](50_eval.md) + [90_lessons.md](90_lessons.md) before running
   or trusting any measurement.

## Smoke test (run before touching anything)

```bash
cd ~/ai/pi-apodex && npx tsc --noEmit && npx tsx eval/selfcheck.ts
# expected: no tsc output; selfcheck prints 6 OK lines ending with
# "SELFCHECK PASSED: hidden tests are sound"

cd /tmp && pi -p --no-session --no-skills --no-context-files \
  --provider deepseek --model deepseek-v4-flash \
  "Reply with only the comma-separated names of your custom tools."
# expected: a list containing "apodex" (extension auto-discovered via symlink)
```

Optional full-pipeline smoke (~90 s, ~$0.01): `APODEX_GENERATOR=... -flash`
env trio + `npx tsx eval/smoke-pipeline.ts` - expect `best score: 100`,
`holistic: approve`, exec probe recorded in the run's gvr.json.

## Agent errors to log

1. The final critic round over the publication batch (README/LICENSE/
   packaging) was interrupted by the user and **not re-run** - README factual
   claims were self-checked against artifacts, but the adversarial pass is
   missing.
2. Mid-session a relative-path `mkdir`/`cp` ran from the wrong cwd
   (docs/diagrams) and created a stray tree; caught and removed the same
   minute. Rule: absolute paths in multi-step shell work.
