---
id: eval
kind: spec
touches: eval/
---

# Evaluation harness

See also: [20_pipeline.md](20_pipeline.md) · [90_lessons.md](90_lessons.md).

## Protocol

- Paired comparison **on the same engine**: baseline = single pass with the
  *identical* generator system prompt / convention / params as the pipeline's
  own generator (isolates the team loop, not prompt engineering).
- Baseline = **mean of 3 samples** (`BASELINE_SAMPLES`) - single-pass failure
  is a frequency. Pipeline = 1 run per task (variance unmeasured; known
  limitation).
- Engines: `--engine pro|flash|both` swaps the heavy roles
  (deepseek-v4-pro / -flash); worker is always flash in both arms.
- Eval safety caps per pipeline run: 20 min wall, $3.

## Buckets and checks (eval/tasks/)

| bucket | check | notes |
|---|---|---|
| code (3) | hidden node test suites (16/10/9 checks), partial credit | tests report `APODEX_TESTS k/TOTAL` **after every check** and trap uncaughtException/unhandledRejection - a mid-suite crash keeps partial credit; scorer takes the LAST match |
| design (3) | locked 8-item rubrics, strict yes/no per item at t=0 | check-errors are surfaced as `?` in the detail, never silently counted as failed requirements |
| incident (3) | known root cause; 1.0 primary / 0.4 mentioned / 0 absent | confidently-wrong (high-confidence wrong primary) tracked separately |

## Non-negotiable disciplines

1. **Selfcheck before trusting anything**: `npx tsx eval/selfcheck.ts` -
   reference solutions MUST score 1.00, broken variants MUST score < 1.00.
   Run after ANY change to hidden tests, scoring, or exec. It validates the
   measurement instrument itself (no LLM calls).
2. **Analyze before believing**: `npx tsx eval/analyze-run.ts
   eval/results/<stamp>` walks all artifacts and flags DEFECT/RISK/NOTE
   (truncation, retry storms, grade failures, budget near-misses, probe-fail
   streaks, revision regressions, judge errors, baseline instability,
   pipeline-underperforms-baseline). Run 1 had 4 defects - all were
   measurement bugs, not model facts. 0 defects is the gate for reporting
   numbers.
3. Hidden tests are never shown to any model; canonical ambiguity choices
   (e.g. empty input -> `[]`) are fixed in the task spec text, not invented at
   scoring time.
4. Scoring checkers use `extractBoolField`/`extractEnumField` fallbacks
   (machine fields survive malformed checker JSON).

## Running

```bash
npx tsx eval/run-eval.ts --engine both --concurrency 3   # full, ~2h, ~$1.10
npx tsx eval/run-eval.ts --smoke                          # 1 task/bucket
npx tsx eval/run-eval.ts --only retry --rounds 2 --candidates 2
```

Outputs: `eval/results/<stamp>/` (gitignored) - summary.txt, results.json,
per-arm answers, `runs/` with full artifact trees for every pipeline,
baseline and scoring client. Published copy of the reported run:
`docs/eval-results/20260611-164416/`.

## Reported numbers (do not restate others as current)

flash: 0.96 -> 1.00 overall, design 0.89 -> 1.00; pro: 0.99 -> 0.99 (saturated);
costs in README §5. The pro null result is real and reported; the suite
cannot measure uplift at a 0.99 ceiling.
