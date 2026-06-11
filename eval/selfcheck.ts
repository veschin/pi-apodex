// Harness self-check: validates the hidden tests themselves before any eval.
// Reference solutions must score 1.00; deliberately broken variants must score
// strictly less. No LLM calls - pure local execution.
//
// Usage: npx tsx eval/selfcheck.ts

import { scoreCodeWithHiddenTest } from "./scoring.ts";
import { codeSelfCheckFixtures } from "./tasks/code.ts";
import type { ScoreContext } from "./types.ts";

function asAnswer(code: string): string {
  return ["Here is the solution.", "", "```js solution", code, "```", ""].join("\n");
}

async function main(): Promise<void> {
  // Code scoring never touches the LLM client; pass an explicit poison proxy so
  // any accidental use fails loudly instead of silently calling a model.
  const ctx: ScoreContext = {
    client: new Proxy({} as ScoreContext["client"], {
      get() {
        throw new Error("selfcheck: scoring unexpectedly used the LLM client");
      },
    }),
    execTimeoutMs: 30_000,
  };

  let failures = 0;
  for (const fixture of codeSelfCheckFixtures) {
    const ref = await scoreCodeWithHiddenTest(asAnswer(fixture.reference), fixture.hiddenTest, ctx);
    const refOk = ref.score === 1;
    console.log(`${fixture.id} reference: score=${ref.score.toFixed(2)} ${refOk ? "OK" : "EXPECTED 1.00"} (${ref.detail})`);
    if (!refOk) failures++;

    const broken = await scoreCodeWithHiddenTest(asAnswer(fixture.broken), fixture.hiddenTest, ctx);
    const brokenOk = broken.score < 1;
    console.log(
      `${fixture.id} broken:    score=${broken.score.toFixed(2)} ${brokenOk ? "OK" : "EXPECTED < 1.00"} (${broken.detail})`,
    );
    if (!brokenOk) failures++;
  }

  if (failures > 0) {
    console.error(`\nSELFCHECK FAILED: ${failures} expectation(s) violated - hidden tests are unsound`);
    process.exit(1);
  }
  console.log("\nSELFCHECK PASSED: hidden tests are sound");
}

main().catch((err) => {
  console.error("selfcheck crashed:", err);
  process.exit(1);
});
