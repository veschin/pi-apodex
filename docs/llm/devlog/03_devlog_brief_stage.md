---
id: devlog-03
kind: devlog
---

# Devlog 03 - brief stage (task analyst) + heavy judge (2026-06-12)

## Why

User feedback session: his hifi standards in a system prompt are ignored by
deepseek ("дипсик нахуячит просто код"), while the eval already proved the
loop enforces what the prompt cannot (flash design 0.79-0.92 baseline with
the SAME hifi generator prompt -> 1.00 through the pipeline). The missing
piece was thinking BEFORE code: use-case understanding, scope negotiation,
acceptance criteria. Decision: a deep, dialog-capable elaboration step on a
smart model, hifi encoded as per-task non-functional requirements + criteria.

## What was built

- `analyst` role (session-heavy, thinking high, `APODEX_ANALYST`).
- `src/brief.ts`: one analyst call + bounded re-ask -> questions /
  brief-review / ready / skipped. Stateless re-invocation protocol via task
  text markers (`# Clarification answers`, `# Approved brief`).
- Pipeline stage before scout; pauses return `ApodexResult.clarification`,
  run.json status `needs-clarification`; ready briefs join materials as
  `# Task brief` (invariant-18 shared material).
- Acceptance criteria are enforced: selftest convention requires one check
  per criterion; grader counts an unmet criterion as a substantive violation.
- Judge default: worker-mirror(flash, thinking off) -> session + thinking
  high (JudgeBench: flash-class judges below random on hard pairs). Scout
  still mirrors the worker.
- Eval protocol pin 2: brief off + judge pinned flash in run-eval.ts; both
  smokes pin `APODEX_BRIEF_ENABLED=0`.

## Verified

tsc clean; selfcheck passes; live flash run: "Build me a game." paused with
4 anchored questions (analyst cited pipeline delivery limits unprompted);
approved-brief task ran end-to-end with the brief applied ($0.0074).
smoke-context re-run not needed (brief pinned off there); command-path
wake-up still only verified headless (pre-existing gap).

## Critic catches (1 round)

The repo's known wiring lesson recurred: `enrichedTask`/`materials` reached
most-but-not-all consumers. Fixed: assembler now gets `materials` (it is on
the invariant-13 list and must see acceptance criteria), delivery planner and
handoff renderer get `enrichedTask`, and a latent silent fall-through for
ready-without-brief became an explicit warning.

## Open questions

Recorded in 20_pipeline.md "Open questions (brief stage)" - review-stop
friction, analyst-before-scout ordering, marker-in-code-fence, no cross-run
question cap, prompt-judged complexity gate, eval judge pin vs in-session
defaults. To be resolved in a future session.
