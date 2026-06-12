---
id: devlog-context-delivery
kind: log
---

# Devlog 02 - eyes, hands-off delivery, and a real judge (2026-06-12)

Trigger: first external-user feedback. Users gave apodex repo-grounded tasks
("read the repository and ..."); sub-calls are tool-less by design, saw only
the task string, and either refused or hallucinated. Verdict from the user:
"no real pi integration - the model spins on its own". Second explicit ask:
bind the critic/judge to a different model the way the worker role is bound.

## What shipped (one session, commit-pair)

1. **Workspace context stage** (`src/context.ts`, new): deterministic listing
   (`git ls-files -z --cached --others --exclude-standard`, fallback
   depth-capped walk) -> `scout` role requests paths as strict JSON -> the
   ORCHESTRATOR reads them (containment + realpath symlink guard, binary
   sniff, 16 KB/file + 48 KB/pack caps, credential deny list) -> up to 2
   rounds -> pack prepended to the task as shared `materials` for every
   downstream stage. Sub-calls stay tool-less; scope item 5 intact.
2. **Delivery stage** (`src/delivery.ts`, new): worker call classifies task
   shape (implementation/analysis/answer) and extracts apply steps / key
   points / open items; `delivery.json` + deterministic `handoff.md` land in
   the run dir; `composeDelivery` now ALWAYS carries final.md + handoff.md
   paths, renders the plan, and attaches a shape-specific NEXT STEP directive
   on every channel (tool inline included - previously chat-only).
3. **judge + scout roles**: pairwise judge moved off the worker role;
   both bindable via `.apodex.json` / `APODEX_JUDGE` / `APODEX_SCOUT`; unset
   models mirror the FINAL worker model (config step 3.5).
4. **Transparency**: `[team]` roster line (role=provider/model for all six
   roles), `[stage]`-prefixed progress everywhere, `progress.jsonl` artifact.

Eval protocol pinned: pipeline arm disables context+delivery (self-contained
tasks; repo files would confound pipeline-vs-baseline; see 50_eval.md).

## Critic round (5 confirmed findings, 3 accepted)

- **Accepted, fixed**: partial role-override object with an INVALID model
  still marked judge/scout "explicit" and blocked mirroring while applying
  the temperature (config.ts) - `applyRoleOverride` now returns
  model-applied; mirroring copies only the model field, so temperature-only
  customization keeps following the worker model.
- **Accepted, fixed**: mode classifier received the bare task while every
  other stage got `materials` - "fix the bug in src/x.ts" with no pasted code
  would misclassify to general and silently disable exec probing + the
  fail-score cap. Classifier now sees `materials` (invariant 16).
- **Accepted, fixed**: deny list missed kubeconfig, `*.tfvars`, `.htpasswd`,
  and non-`id_`-prefixed private keys (`deploy_rsa`); extended.
- **Refuted**: "delivery planner needs its own role" - it is mechanical
  extraction, worker-class by definition; documented instead.
- **Refuted**: "pack.rounds misleading" - the field is defined in types.ts as
  scout calls made, and matches that definition.

## Verification evidence

- `eval/smoke-context.ts` (new, strict assertions): repo-grounded question
  from this repo -> scout gathered `src/json.ts` first round, 5-6 files,
  ~40-48 KB, grounded answer (score 95-100, holistic approve, 14/14 then
  12/12 atoms verified), all artifacts present, roster + stage prefixes
  asserted. ~80 s, ~$0.02 all-flash.
- `eval/smoke-pipeline.ts` with `APODEX_JUDGE=deepseek/deepseek-v4-pro`:
  subcalls.jsonl shows `selector.judge.0v1 judge deepseek-v4-pro` while scout
  and workers stayed flash; the self-contained chunk task produced a clean
  scout skip ("task is fully self-contained", 0 files) and task shape
  implementation with 4 apply steps.
- Config unit checks: env-follow mirror, partial-invalid-object mirror with
  preserved temperature, explicit pin; deny-list 10-denied/7-allowed table.
- tsc clean; selfcheck passes; headless pi lists the apodex tool.

## Known deferred

- README §3 method description predates the two new stages (flagged in
  20_pipeline.md); needs its own careful pass.
- Command-path abort / double-submit guard and detached runs: unchanged
  backlog from devlog 01.
- Prompt-injection via workspace file contents: the pack is framed as
  authoritative material; a hostile repo file could try to steer the
  pipeline. Accepted at current scale (single-user, local repos); revisit
  before any multi-tenant use.
