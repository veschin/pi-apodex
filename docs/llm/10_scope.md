---
id: scope
kind: spec
touches: src/, eval/, index.ts
---

# Scope

See also: [20_pipeline.md](20_pipeline.md) · [50_eval.md](50_eval.md) · [90_lessons.md](90_lessons.md).

pi-apodex is a **verification-centric inference-time reasoning layer** for the
Pi coding agent: an open replication of the inference-time portion of the
Apodex-1.0 agent-team method (candidates -> execution-grounded selection ->
generate-verify-revise -> claim-level external audit -> evidence-disciplined
assembly). It raises answer reliability on hard engineering tasks by spending
extra budget-capped LLM sub-calls, not by changing or training models.

## Verifiable current state (2026-06-11)

- `npx tsc --noEmit` - clean, strict mode.
- `npx tsx eval/selfcheck.ts` - passes: 3 reference solutions score 1.00,
  3 broken variants score 0.50-0.56 on the hidden tests.
- Reported evaluation: `docs/eval-results/20260611-164416/` - flash engine
  0.96 -> 1.00 overall (design 0.89 -> 1.00), pro engine 0.99 -> 0.99
  (saturated, reported honestly).
- Published: https://github.com/veschin/pi-apodex (public, MIT).
- Installed locally via symlink `~/.pi/agent/extensions/pi-apodex`.

## Explicitly OUT of scope (v1)

1. **Training / fine-tuning** - the original report's three-stage
   post-training pipeline is not replicated; inference-time only.
2. **Datacenter-scale orchestration** - no async 150-agent swarm, no custom
   runtime kernel, no model-driven planner. Orchestration is deterministic
   TypeScript; 3-10 concurrent sub-calls.
3. **Security sandboxing** - `src/exec.ts` runs candidate self-tests with
   local `node` in a temp dir as an *evidence channel*; it is NOT a boundary
   against untrusted code.
4. **Web-grounded verification** - atoms are audited against task-internal
   materials only. (Roadmap item; survey: docs/research/test-time-boosting.md.)
5. **Tool-using sub-agents** - sub-calls are tool-less single-turn
   completions by design (cost + isolation).
6. **Detached/background runs** - a pipeline run lives inside the invoking
   process (pi session or tsx); killing the process kills the run.

Adding anything from this list is a scope decision for the user, not a
default. The high-leverage backlog lives in [handoff.md](handoff.md).
