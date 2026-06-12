---
id: handoff
kind: guide
---

# Handoff

State as of 2026-06-12: context + delivery stages, judge/scout roles, and
stage transparency implemented and verified locally; NOT yet committed when
this file was written - the session ends with the commit(s). Previous
published state: commit `6f684ab` (main, https://github.com/veschin/pi-apodex).

## What exists (verified this session)

- **Full pipeline**: scout context gathering -> mode classify (sees
  materials) -> [code: N candidates -> exec -> pairwise judge] -> GVR ->
  claim audit -> assembly -> delivery plan + handoff.md. All stage events are
  `[stage]`-prefixed, a `[team] role=model` roster opens every run,
  progress.jsonl persists the timeline.
- **Workspace context stage** (`src/context.ts`): the answer to the first
  external-user feedback ("apodex can't read the repo, no pi integration").
  Scout requests listing paths as JSON; the orchestrator reads them
  (containment + realpath guards, binary sniff, credential deny list,
  16 KB/file, 48 KB/pack, <=2 rounds). Verified: `eval/smoke-context.ts` -
  repo question -> src/json.ts gathered first, grounded answer, score
  95-100, approve, ~$0.02.
- **Delivery stage** (`src/delivery.ts`): task shape + apply steps / key
  points / open items; delivery.json + deterministic handoff.md;
  composeDelivery always shows final.md + handoff.md paths and a
  shape-specific NEXT STEP on every channel.
- **judge/scout roles**: `APODEX_JUDGE` / `APODEX_SCOUT` / `.apodex.json`;
  unset models mirror the final worker model. Verified via subcalls.jsonl
  (judge on pro while everything else flash).
- Eval protocol pinned (context+delivery OFF in the pipeline arm,
  eval/run-eval.ts) - published numbers `docs/eval-results/20260611-164416`
  stay comparable. tsc clean; selfcheck passes; headless pi lists the tool.

## What does NOT exist

- No abort for `/apodex`-launched runs (signal undefined in command context);
  Esc only works for the tool path. No double-submit debounce either.
- No detached runs: killing pi kills in-flight runs.
- No web-grounded verification, no sandbox, no cross-family judge panel, no
  consistency-gated cascade (README §9 roadmap).
- No prompt-injection defense beyond framing: a hostile workspace file
  becomes trusted material (accepted at single-user scale; devlog 02).
- README §3 method description predates the context/delivery stages.

## Current problems (user-facing, live)

1. The user's live pi session predates ALL of this; he must `/reload` (when
   no runs are in flight) to get the new extension code, then run one
   `/apodex` to interactively confirm the triggerTurn wake-up (still only
   verified headless).
2. Other users' sessions likewise need a fresh `pi install` /
   `git pull` of the extension.
3. Huge monolithic tasks still produce mediocre value per dollar -
   task-splitting guidance lives only in the tool description.

## Next options (user picks; not a queue)

- **A. Cross-family judge panel (~0.5 d).** judge role exists; add N-vote
  majority with per-vote artifacts (survey: PoLL panels beat a single big
  judge at 7-8x less cost).
- **B. Consistency-gated cascade (~0.5-1 d).** Candidate agreement as a free
  confidence signal; highest expected value per dollar in the survey.
- **C. Command-path abort + double-submit guard (~1 h).** AbortController in
  the `/apodex` handler + `/apodex-stop`; ignore a second submit while one
  is queued.
- **D. Detached runs (~0.5 d).** Spawned-process pipeline with result
  delivery on session return.
- **E. README §3 refresh (~1 h).** Fold the context/delivery stages into the
  method description + diagram.

## Read order

1. This file.
2. [20_pipeline.md](20_pipeline.md) - invariants 13-16 are new (context,
   scout discipline, delivery, classifier materials).
3. [30_subcall_infra.md](30_subcall_infra.md) - six roles + mirroring;
   [40_extension.md](40_extension.md) - new delivery contract.
4. [50_eval.md](50_eval.md) + [90_lessons.md](90_lessons.md) before running
   or trusting any measurement; note the protocol pin.

## Smoke test (run before touching anything)

```bash
cd ~/ai/pi-apodex && npx tsc --noEmit && npx tsx eval/selfcheck.ts
# expected: no tsc output; selfcheck prints 6 OK lines ending with
# "SELFCHECK PASSED: hidden tests are sound"

npx tsx eval/smoke-context.ts
# expected: "SMOKE-CONTEXT PASSED" - scout gathers src/json.ts from this
# repo, artifacts + stage prefixes asserted (~80 s, ~$0.02, all-flash)

cd /tmp && pi -p --no-session --no-skills --no-context-files \
  --provider deepseek --model deepseek-v4-flash \
  "Reply with only the comma-separated names of your custom tools."
# expected: a list containing "apodex"
```

Optional code-path smoke (~85 s, ~$0.01): `APODEX_GENERATOR/GRADER/VERIFIER=
...-flash npx tsx eval/smoke-pipeline.ts` - expect scout skip
("self-contained"), early stop, task shape implementation.

## Agent errors to log

1. (carried over, still open) The final critic round over the publication
   batch (README/LICENSE/packaging) was interrupted by the user on 2026-06-11
   and never re-run; README factual claims were self-checked only.
2. This session's critic round caught a real cross-file bug pattern twice
   missed during implementation: a new shared input (`materials`) was wired
   into most-but-not-all consumers (classifier missed), and a tracking flag
   (`explicitRoles`) conflated "any field applied" with "model applied".
   Rule reinforced: after introducing a shared value, grep EVERY call site of
   the thing it replaces before declaring the wiring done.
