---
id: index
kind: index
---

# docs/llm index

Operational reference graph. English only. Short, structured, cheap to load.
Each entry declares `id` and `kind`. Describes what IS, verified against the
code - never aspirational.

## Entries

- [handoff.md](handoff.md) - next-session action plan, current problems,
  backlog choices. **Read first.**
- [10_scope.md](10_scope.md) - what this project is and is explicitly NOT
  (read before adding any new capability).
- [20_pipeline.md](20_pipeline.md) - the verification pipeline's stage
  contracts and numbered invariants (read before touching src/gvr.ts,
  src/selector.ts, src/verifier.ts, src/pipeline.ts, src/prompts.ts).
- [30_subcall_infra.md](30_subcall_infra.md) - sub-call client, roles,
  budgets, config precedence, artifact store (read before touching
  src/llm.ts, src/roles.ts, src/budget.ts, src/config.ts, src/store.ts,
  src/exec.ts, src/json.ts).
- [40_extension.md](40_extension.md) - pi integration surface, jiti aliasing
  constraint, packaging/install (read before touching index.ts or
  package.json).
- [50_eval.md](50_eval.md) - evaluation protocol, scoring, selfcheck
  discipline, analyzer (read before touching eval/ or trusting any number).
- [90_lessons.md](90_lessons.md) - post-mortems with measured gaps; rules
  born from real failures this project already had.
- devlog/ - append-only session logs (raw history + article material).

## Kinds

| kind | meaning |
|------|---------|
| `index` | this file |
| `spec` | contract / invariants - source of truth for its `touches:` paths |
| `guide` | synthesized how-to; the handoff |
| `lesson` | post-mortem; rules traced to a specific failure |
| `log` | devlog entry, dry session facts |

## Update rule

Any change to a public contract - a pipeline invariant, a role default, the
sub-call retry/budget policy, the artifact layout, an eval scoring rule, the
extension's tool/command surface - updates the matching spec **in the same
commit** as the code. `handoff.md` is rewritten (never appended) at session
end. Devlogs and 90-class lessons are append-only.

## Validation

`./validate.sh` checks every relative link resolves; exit 0 = clean.
