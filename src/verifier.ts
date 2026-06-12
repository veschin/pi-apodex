// External verification: evidence discipline.
//
// 1. A worker extracts the answer's load-bearing claims as atoms.
// 2. Each atom is audited independently (worker, fresh context, parallel
//    batches) against the materials: task text + answer + execution evidence.
// 3. The verifier role issues a holistic verdict over the audited atoms.
//
// The verifier audits conclusions against evidence; it never continues the
// generator's reasoning and never sees it.

import { BudgetExhaustedError } from "./budget.ts";
import { execEvidenceToText } from "./exec.ts";
import { parseJsonLoose, asStringArray } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import {
  ATOM_AUDITOR_SYSTEM,
  CLAIM_EXTRACTOR_SYSTEM,
  HOLISTIC_VERIFIER_SYSTEM,
  atomAuditorUser,
  claimExtractorUser,
  holisticVerifierUser,
} from "./prompts.ts";
import type {
  AtomKind,
  AtomVerdict,
  EvidenceAtom,
  ExecEvidence,
  HolisticVerdict,
  ProgressFn,
  VerificationReport,
} from "./types.ts";

const MAX_ATOMS = 14;
const AUDIT_BATCH_SIZE = 5;

const ATOM_KINDS: readonly AtomKind[] = ["fact", "causal", "execution", "design", "recommendation"];
const ATOM_VERDICTS: readonly AtomVerdict[] = ["verified", "unsupported", "contradicted"];

function isAtomKind(value: unknown): value is AtomKind {
  return typeof value === "string" && (ATOM_KINDS as readonly string[]).includes(value);
}

function isAtomVerdict(value: unknown): value is AtomVerdict {
  return typeof value === "string" && (ATOM_VERDICTS as readonly string[]).includes(value);
}

const execEvidenceText = execEvidenceToText;

interface RawAtom {
  claim?: unknown;
  kind?: unknown;
  support?: unknown;
}

function parseAtoms(text: string): EvidenceAtom[] | null {
  const raw = parseJsonLoose<RawAtom[]>(text);
  if (!Array.isArray(raw)) return null;
  const atoms: EvidenceAtom[] = [];
  for (const item of raw.slice(0, MAX_ATOMS)) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.claim !== "string" || item.claim.trim() === "") continue;
    atoms.push({
      id: `atom-${atoms.length + 1}`,
      claim: item.claim.trim(),
      kind: isAtomKind(item.kind) ? item.kind : "fact",
      support: typeof item.support === "string" ? item.support : "none stated",
      verdict: null,
      note: "",
    });
  }
  return atoms;
}

interface RawAuditResult {
  verdict?: unknown;
  note?: unknown;
}

export interface VerifierOptions {
  client: SubCallClient;
  task: string;
  answer: string;
  execEvidence: ExecEvidence | null;
  onProgress?: ProgressFn;
}

async function extractAtoms(opts: VerifierOptions): Promise<{ atoms: EvidenceAtom[]; error?: string }> {
  const outcome = await opts.client.call({
    role: "worker",
    label: "verify.extract-claims",
    systemPrompt: CLAIM_EXTRACTOR_SYSTEM,
    userText: claimExtractorUser(opts.task, opts.answer),
    temperature: 0,
  });
  if (!outcome.ok) return { atoms: [], error: outcome.error ?? "claim extraction failed" };
  const atoms = parseAtoms(outcome.text);
  if (atoms === null) {
    // One bounded re-ask on parse failure.
    const retry = await opts.client.call({
      role: "worker",
      label: "verify.extract-claims.retry",
      systemPrompt: CLAIM_EXTRACTOR_SYSTEM,
      userText: `${claimExtractorUser(opts.task, opts.answer)}\n\nIMPORTANT: your previous reply was not parseable. Return ONLY the JSON array described in your instructions.`,
      temperature: 0,
    });
    if (!retry.ok) return { atoms: [], error: retry.error ?? "claim extraction failed twice" };
    const retryAtoms = parseAtoms(retry.text);
    if (retryAtoms === null) return { atoms: [], error: "claim extraction returned unparseable JSON twice" };
    return { atoms: retryAtoms };
  }
  return { atoms };
}

async function auditAtom(opts: VerifierOptions, atom: EvidenceAtom): Promise<void> {
  const outcome = await opts.client.call({
    role: "worker",
    label: `verify.audit.${atom.id}`,
    systemPrompt: ATOM_AUDITOR_SYSTEM,
    userText: atomAuditorUser(
      opts.task,
      opts.answer,
      execEvidenceText(opts.execEvidence),
      `[${atom.kind}] ${atom.claim}\nStated support: ${atom.support}`,
    ),
    temperature: 0,
  });
  if (!outcome.ok) {
    atom.verdict = "unsupported";
    atom.note = `audit call failed (${outcome.error ?? "unknown"}); conservatively marked unsupported`;
    return;
  }
  const raw = parseJsonLoose<RawAuditResult>(outcome.text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !isAtomVerdict(raw.verdict)) {
    atom.verdict = "unsupported";
    atom.note = "audit verdict unparseable; conservatively marked unsupported";
    return;
  }
  atom.verdict = raw.verdict;
  atom.note = typeof raw.note === "string" ? raw.note : "";
}

interface RawHolistic {
  verdict?: unknown;
  summary?: unknown;
  critical_issues?: unknown;
}

function parseHolistic(text: string): HolisticVerdict | null {
  const raw = parseJsonLoose<RawHolistic>(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.verdict !== "approve" && raw.verdict !== "revise" && raw.verdict !== "reject") return null;
  return {
    verdict: raw.verdict,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    criticalIssues: asStringArray(raw.critical_issues, 20, 600),
  };
}

export function atomsReportText(atoms: EvidenceAtom[]): string {
  if (atoms.length === 0) return "(no atoms extracted)";
  return atoms
    .map(
      (atom) =>
        `${atom.id} [${atom.kind}] ${atom.verdict ?? "unaudited"}\n  claim: ${atom.claim}\n  support: ${atom.support}\n  note: ${atom.note || "-"}`,
    )
    .join("\n");
}

export async function runVerification(opts: VerifierOptions): Promise<VerificationReport> {
  opts.onProgress?.("[verify] extracting claim atoms");
  const { atoms, error: extractError } = await extractAtoms(opts);

  const report: VerificationReport = { atoms, holistic: null };
  if (extractError !== undefined) {
    // No atoms - the holistic audit still runs on the raw answer, with the gap
    // recorded so downstream consumers know atom-level discipline is missing.
    report.holisticError = `claim extraction degraded: ${extractError}`;
    opts.onProgress?.(`[verify] ${report.holisticError}`);
  }

  if (atoms.length > 0) {
    opts.onProgress?.(`[verify] auditing ${atoms.length} atoms`);
    // Parallel batches keep concurrency bounded (worker is the cheap model,
    // but each call still counts against the budget guard).
    for (let i = 0; i < atoms.length; i += AUDIT_BATCH_SIZE) {
      const batch = atoms.slice(i, i + AUDIT_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map((atom) => auditAtom(opts, atom)));
      for (const result of results) {
        if (result.status === "rejected") {
          if (result.reason instanceof BudgetExhaustedError) throw result.reason;
          // auditAtom handles its own failures; a rejection here is unexpected.
          opts.onProgress?.(
            `[verify] atom audit rejected unexpectedly: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
    }
  }

  opts.onProgress?.("[verify] holistic audit");
  const holistic = await opts.client.call({
    role: "verifier",
    label: "verify.holistic",
    systemPrompt: HOLISTIC_VERIFIER_SYSTEM,
    userText: holisticVerifierUser(
      opts.task,
      opts.answer,
      atomsReportText(atoms),
      execEvidenceText(opts.execEvidence),
    ),
  });
  if (holistic.ok) {
    const parsed = parseHolistic(holistic.text);
    if (parsed) {
      report.holistic = parsed;
    } else {
      report.holisticError = `${report.holisticError ? `${report.holisticError}; ` : ""}holistic verdict unparseable`;
    }
  } else {
    report.holisticError = `${report.holisticError ? `${report.holisticError}; ` : ""}holistic audit failed: ${holistic.error ?? "unknown"}`;
  }
  return report;
}
