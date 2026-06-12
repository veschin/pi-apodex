# pi-apodex

Verification-centric inference-time reasoning layer for the Pi coding agent:
an open replication of the Apodex-1.0 agent-team method (parallel candidates
-> execution-grounded selection -> generate-verify-revise -> claim-level audit ->
evidence-disciplined assembly), shipped as a Pi extension. TypeScript strict,
ESM, runs under pi's jiti loader (in-session) and tsx (standalone eval).

State: tsc clean; `eval/selfcheck.ts` passing; reported eval
`docs/eval-results/20260611-164416` (flash 0.96->1.00, pro 0.99->0.99);
published at https://github.com/veschin/pi-apodex.

## Session start

1. Read `docs/llm/handoff.md` first - current state, live problems, next
   options, smoke-test commands.
2. Run the smoke test from the handoff before changing anything.

## Reference docs (load on demand)

- `docs/llm/10_scope.md` - what this project is NOT; read before adding any
  capability.
- `docs/llm/20_pipeline.md` - stage invariants; read before touching
  src/{pipeline,gvr,selector,verifier,prompts,context,delivery}.ts.
- `docs/llm/30_subcall_infra.md` - sub-call/retry/budget/config/store
  contracts; read before touching src/{llm,roles,budget,config,store,exec,json}.ts.
- `docs/llm/40_extension.md` - pi integration + packaging facts (jiti
  aliasing, devDependencies decision); read before touching index.ts or
  package.json.
- `docs/llm/50_eval.md` - protocol and the selfcheck/analyzer disciplines;
  read before running or trusting any measurement.
- `docs/llm/90_lessons.md` - measured post-mortems; the rules there are
  enforced in code, do not regress them.
- `NOTES.md` - Pi SDK integration research; `DEVLOG.md` - decision log;
  `docs/research/test-time-boosting.md` - literature survey behind the
  roadmap.

## Update rule

Public-contract changes update the matching `docs/llm/` spec in the same
commit. `docs/llm/handoff.md` is rewritten at session end; devlogs and
lessons are append-only. After adding/renaming any doc:
`./docs/llm/validate.sh` must exit 0.
