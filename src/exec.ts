// Execution evidence for code candidates: run a candidate's self-test with the
// local node binary in a throwaway tempdir. Constraints: hard timeout with
// SIGKILL escalation, minimal env, output capped. This is NOT a security
// sandbox - it is an evidence channel for locally-authored code; full isolation
// is deferred (see README).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecEvidence } from "./types.ts";

const OUTPUT_CAP_BYTES = 64 * 1024;

export interface ExecRequest {
  /** File name -> contents. Must contain `entry`. */
  files: Record<string, string>;
  /** Entry file executed as `node <entry>`. */
  entry: string;
  timeoutMs: number;
}

function capped(buf: string): string {
  if (buf.length <= OUTPUT_CAP_BYTES) return buf;
  return `${buf.slice(0, OUTPUT_CAP_BYTES)}\n...[output truncated at 64KB]`;
}

export async function runNodeScript(req: ExecRequest): Promise<ExecEvidence> {
  if (!Object.prototype.hasOwnProperty.call(req.files, req.entry)) {
    return {
      ran: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      skippedReason: `entry file ${req.entry} missing from files`,
    };
  }
  for (const name of Object.keys(req.files)) {
    // Path traversal guard: file names must stay inside the tempdir.
    if (name.includes("..") || path.isAbsolute(name)) {
      return {
        ran: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        skippedReason: `unsafe file name: ${name}`,
      };
    }
  }

  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "apodex-exec-"));
  } catch (err) {
    return {
      ran: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      skippedReason: `tempdir creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    for (const [name, contents] of Object.entries(req.files)) {
      const filePath = path.join(dir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf8");
    }

    return await new Promise<ExecEvidence>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn(process.execPath, [req.entry], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        // Minimal env: candidate code gets no inherited secrets.
        env: { NODE_ENV: "test" },
      });

      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const killTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        sigkillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2_000);
        sigkillTimer.unref();
      }, req.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < OUTPUT_CAP_BYTES * 2) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < OUTPUT_CAP_BYTES * 2) stderr += chunk.toString();
      });

      const settle = (evidence: ExecEvidence) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve(evidence);
      };

      child.on("close", (code) => {
        settle({
          ran: true,
          exitCode: code,
          stdout: capped(stdout),
          stderr: capped(stderr),
          timedOut,
        });
      });
      child.on("error", (err) => {
        settle({
          ran: false,
          exitCode: null,
          stdout: capped(stdout),
          stderr: capped(stderr),
          timedOut,
          skippedReason: `spawn failed: ${err.message}`,
        });
      });
    });
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* tempdir cleanup is best-effort */
    }
  }
}

/** Single source of truth for rendering exec evidence into prompts. */
export function execEvidenceToText(evidence: ExecEvidence | null): string {
  if (!evidence) return "(no execution evidence)";
  if (!evidence.ran) {
    return `Self-test was NOT executed. Reason: ${evidence.skippedReason ?? "unknown"}.`;
  }
  const status = evidence.timedOut
    ? "TIMED OUT"
    : `exit code ${evidence.exitCode ?? "unknown"} (${evidence.exitCode === 0 ? "PASS" : "FAIL"})`;
  return [
    `Self-test executed: ${status}`,
    evidence.stdout.trim() ? `--- stdout ---\n${evidence.stdout.trim()}` : "(empty stdout)",
    evidence.stderr.trim() ? `--- stderr ---\n${evidence.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SOLUTION_BLOCK = /```(?:js|javascript|mjs)\s+solution\s*\n([\s\S]*?)```/;
const SELFTEST_BLOCK = /```(?:js|javascript|mjs)\s+selftest\s*\n([\s\S]*?)```/;

export interface ExtractedCode {
  solution: string | null;
  selftest: string | null;
}

/**
 * Code-mode answers follow a convention (enforced by the generator prompt):
 * a ```js solution``` block and a ```js selftest``` block; the self-test
 * imports "./solution.mjs" and exits non-zero on failure.
 */
export function extractCodeBlocks(answer: string): ExtractedCode {
  const solution = SOLUTION_BLOCK.exec(answer)?.[1] ?? null;
  const selftest = SELFTEST_BLOCK.exec(answer)?.[1] ?? null;
  return { solution, selftest };
}

export async function runCandidateSelfTest(answer: string, timeoutMs: number): Promise<ExecEvidence> {
  const { solution, selftest } = extractCodeBlocks(answer);
  if (!solution || !selftest) {
    return {
      ran: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      skippedReason: !solution ? "no `js solution` block in answer" : "no `js selftest` block in answer",
    };
  }
  return runNodeScript({
    files: { "solution.mjs": solution, "selftest.mjs": selftest },
    entry: "selftest.mjs",
    timeoutMs,
  });
}
