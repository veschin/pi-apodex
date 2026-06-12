// RunStore - persists every run as an auditable artifact tree:
//
//   <runsDir>/<runId>/
//     run.json        final manifest (config snapshot, result summary, budget)
//     subcalls.jsonl  every sub-call: role, model, prompts, response, usage, timing
//     <step>.json     intermediate step outputs (grades, pair verdicts, atoms, ...)
//     final.md        the final answer
//
// Store creation failures throw (a run that cannot be audited must not start
// silently); mid-run append failures degrade to warnings so a disk hiccup does
// not destroy paid work.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SubCallRecord } from "./types.ts";

export class RunStore {
  readonly runId: string;
  readonly runDir: string;
  private readonly warningsSink: (warning: string) => void;

  constructor(baseDir: string, runId: string, onWarning: (warning: string) => void) {
    this.runId = runId;
    this.runDir = path.resolve(baseDir, runId);
    this.warningsSink = onWarning;
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  static newRunId(prefix = "run"): string {
    const now = new Date();
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+$/, "")
      .replace("T", "-");
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${stamp}-${rand}`;
  }

  appendSubCall(record: SubCallRecord): void {
    this.appendJsonl("subcalls.jsonl", record);
  }

  appendJsonl(name: string, value: unknown): void {
    this.safeWrite(() => {
      fs.appendFileSync(path.join(this.runDir, name), `${JSON.stringify(value)}\n`, "utf8");
    }, `${name} append`);
  }

  writeJson(name: string, value: unknown): void {
    this.safeWrite(() => {
      fs.writeFileSync(path.join(this.runDir, name), JSON.stringify(value, null, 2), "utf8");
    }, `${name} write`);
  }

  writeText(name: string, text: string): void {
    this.safeWrite(() => {
      fs.writeFileSync(path.join(this.runDir, name), text, "utf8");
    }, `${name} write`);
  }

  private safeWrite(fn: () => void, what: string): void {
    try {
      fn();
    } catch (err) {
      this.warningsSink(`store: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
