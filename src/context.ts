// Workspace context gathering - the pipeline's "eyes".
//
// Sub-calls stay tool-less by design (isolation, budget); instead the
// ORCHESTRATOR mediates reads: a deterministic listing of the workspace is
// shown to the scout role, the scout requests specific paths as strict JSON,
// this module reads them (path-guarded, size-capped, secret-filtered) and
// feeds the contents back for at most `maxRounds` rounds. The resulting
// ContextPack becomes shared task material for every downstream stage -
// identical for generator, grader, judge, and auditors, so candidate
// comparability and grader isolation are preserved.
//
// Failure discipline: nothing in here may kill a run. Listing/read errors
// degrade to warnings; scout failures end the loop with whatever was gathered.
// Only BudgetExhaustedError / external aborts propagate (SubCallClient).

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { asStringArray, extractEnumField, parseJsonLoose } from "./json.ts";
import type { SubCallClient } from "./llm.ts";
import { SCOUT_SYSTEM, scoutUser } from "./prompts.ts";
import type { ContextConfig, ContextFileEntry, ContextPack, ProgressFn } from "./types.ts";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
]);

/** Path segments that must never be listed or read (credential carriers). */
const DENIED_SEGMENTS = new Set([".ssh", ".aws", ".gnupg"]);

/**
 * Well-known credential files: excluded from the listing AND from reads so a
 * scout request can never pack secrets into prompts (which are persisted to
 * subcalls.jsonl and sent to third-party providers).
 */
const DENIED_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".htpasswd",
  "auth.json",
  "credentials.json",
  "service-account.json",
  "kubeconfig",
  ".kubeconfig",
]);
const DENIED_BASENAME_PATTERNS = [
  /^\.env(\..+)?$/,
  // SSH-style private keys regardless of prefix: id_rsa, deploy_rsa, ci_ed25519...
  /(^|_)(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
];
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".tfvars", ".kdbx"]);

const BINARY_SNIFF_BYTES = 8_192;
const LIST_WALK_MAX_DEPTH = 6;
const GIT_LS_TIMEOUT_MS = 10_000;
/** Per-round cap on scout requests; total files are capped by config.maxFiles. */
const MAX_FILES_PER_ROUND = 10;

export interface ListingEntry {
  path: string;
  bytes: number;
}

export function isDeniedPath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((s) => DENIED_SEGMENTS.has(s))) return true;
  const base = segments[segments.length - 1] ?? relPath;
  if (DENIED_BASENAMES.has(base)) return true;
  if (DENIED_BASENAME_PATTERNS.some((re) => re.test(base))) return true;
  const ext = path.extname(base).toLowerCase();
  if (DENIED_EXTENSIONS.has(ext)) return true;
  return false;
}

async function gitListFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: GIT_LS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const paths = stdout.split("\0").filter((p) => p !== "");
    return paths.length > 0 ? paths : null;
  } catch {
    return null; // not a git repo / git unavailable -> directory walk fallback
  }
}

function walkListFiles(cwd: string, maxEntries: number, warnings: string[]): string[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: ".", depth: 0 }];
  while (queue.length > 0 && found.length < maxEntries * 2) {
    const item = queue.shift();
    if (!item) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(cwd, item.dir), { withFileTypes: true });
    } catch (err) {
      warnings.push(`context: cannot list ${item.dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const entry of entries) {
      const rel = item.dir === "." ? entry.name : `${item.dir}/${entry.name}`;
      if (entry.isDirectory()) {
        // Skip dot-directories and known dependency/output trees; this branch
        // only runs when git metadata is unavailable.
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        if (item.depth + 1 <= LIST_WALK_MAX_DEPTH) queue.push({ dir: rel, depth: item.depth + 1 });
      } else if (entry.isFile()) {
        found.push(rel);
      }
    }
  }
  return found;
}

async function listWorkspace(
  cwd: string,
  maxEntries: number,
  warnings: string[],
): Promise<{ entries: ListingEntry[]; truncated: boolean }> {
  const rawPaths = (await gitListFiles(cwd)) ?? walkListFiles(cwd, maxEntries, warnings);
  const entries: ListingEntry[] = [];
  for (const rel of rawPaths) {
    if (isDeniedPath(rel)) continue;
    try {
      const stat = fs.statSync(path.join(cwd, rel));
      if (!stat.isFile()) continue;
      entries.push({ path: rel, bytes: stat.size });
    } catch {
      continue; // listed but unreadable/vanished - not listable material
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const truncated = entries.length > maxEntries;
  return { entries: truncated ? entries.slice(0, maxEntries) : entries, truncated };
}

type ReadResult = { ok: true; entry: ContextFileEntry } | { ok: false; reason: string };

function readFileCapped(cwd: string, relPath: string, byteBudget: number): ReadResult {
  const abs = path.resolve(cwd, relPath);
  // Containment guard: the requested path must stay inside cwd even after
  // symlink resolution (the listing is trusted, but defense in depth is cheap).
  const relCheck = path.relative(cwd, abs);
  if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    return { ok: false, reason: "path escapes the workspace" };
  }
  let real: string;
  let realCwd: string;
  try {
    real = fs.realpathSync(abs);
    realCwd = fs.realpathSync(cwd);
  } catch (err) {
    return { ok: false, reason: `cannot resolve: ${err instanceof Error ? err.message : String(err)}` };
  }
  const realRel = path.relative(realCwd, real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    return { ok: false, reason: "symlink target escapes the workspace" };
  }

  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { ok: false, reason: "not a regular file" };
    const toRead = Math.min(stat.size, byteBudget);
    const fd = fs.openSync(real, "r");
    let buf: Buffer;
    try {
      buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, 0);
    } finally {
      fs.closeSync(fd);
    }
    const sniff = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
    if (sniff.includes(0)) return { ok: false, reason: "binary file" };
    return {
      ok: true,
      entry: {
        path: relPath,
        bytes: buf.length,
        totalBytes: stat.size,
        truncated: stat.size > buf.length,
        content: buf.toString("utf8"),
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

interface ScoutReply {
  decision: "done" | "need-files";
  files: string[];
  map: string;
  reason: string;
}

const SCOUT_DECISIONS = ["done", "need-files"] as const;

function parseScoutReply(text: string, maxFiles: number): ScoutReply | null {
  const raw = parseJsonLoose<{ decision?: unknown; files?: unknown; map?: unknown; reason?: unknown }>(text);
  let decision: string | null = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.decision === "string") {
    decision = raw.decision;
  }
  if (decision === null) decision = extractEnumField(text, "decision", SCOUT_DECISIONS);
  if (decision !== "done" && decision !== "need-files") return null;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    decision,
    files: asStringArray(obj.files, maxFiles, 1_000),
    map: typeof obj.map === "string" ? obj.map : "",
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
}

function listingToText(entries: ListingEntry[], truncated: boolean): string {
  const lines = entries.map((e) => `${e.path}\t${e.bytes}`);
  if (truncated) lines.push(`... [listing truncated at ${entries.length} entries]`);
  return lines.join("\n");
}

function gatheredToText(files: ContextFileEntry[]): string | null {
  if (files.length === 0) return null;
  return files
    .map(
      (f) =>
        `## ${f.path} (${f.bytes}${f.truncated ? ` of ${f.totalBytes}` : ""} bytes${f.truncated ? ", truncated" : ""})\n\n\`\`\`\`\n${f.content}\n\`\`\`\``,
    )
    .join("\n\n");
}

export interface GatherContextOptions {
  client: SubCallClient;
  task: string;
  cwd: string;
  config: ContextConfig;
  onProgress?: ProgressFn;
}

export async function gatherContext(opts: GatherContextOptions): Promise<ContextPack> {
  const warnings: string[] = [];
  const pack: ContextPack = {
    gathered: false,
    map: "",
    files: [],
    listingCount: 0,
    listingTruncated: false,
    rounds: 0,
    totalBytes: 0,
    warnings,
  };
  if (!opts.config.enabled) {
    pack.skippedReason = "disabled by config";
    return pack;
  }

  const { entries, truncated } = await listWorkspace(opts.cwd, opts.config.maxListingEntries, warnings);
  pack.listingCount = entries.length;
  pack.listingTruncated = truncated;
  if (entries.length === 0) {
    pack.skippedReason = "workspace has no listable files";
    return pack;
  }
  const listingText = listingToText(entries, truncated);
  const listingSet = new Set(entries.map((e) => e.path));
  const requested = new Set<string>();
  let lastReason = "";

  for (let round = 1; round <= opts.config.maxRounds; round++) {
    pack.rounds = round;
    const remainingFiles = opts.config.maxFiles - pack.files.length;
    const remainingBytes = opts.config.maxTotalBytes - pack.totalBytes;
    const userText = scoutUser(opts.task, listingText, gatheredToText(pack.files), remainingFiles, remainingBytes);

    let reply: ScoutReply | null = null;
    const first = await opts.client.call({
      role: "scout",
      label: `context.scout.r${round}`,
      systemPrompt: SCOUT_SYSTEM,
      userText,
      temperature: 0,
    });
    if (first.ok) reply = parseScoutReply(first.text, Math.min(remainingFiles, MAX_FILES_PER_ROUND));
    if (reply === null) {
      // One bounded re-ask (house pattern), then degrade - context is an
      // enhancement, never a run-killer.
      const second = await opts.client.call({
        role: "scout",
        label: `context.scout.r${round}.retry`,
        systemPrompt: SCOUT_SYSTEM,
        userText: `${userText}\n\nIMPORTANT: your previous reply was not parseable. Return ONLY the JSON object described in your instructions.`,
        temperature: 0,
      });
      if (second.ok) reply = parseScoutReply(second.text, Math.min(remainingFiles, MAX_FILES_PER_ROUND));
      if (reply === null) {
        warnings.push(
          `context: scout round ${round} unusable (${first.error ?? second.error ?? "unparseable JSON twice"}); proceeding with ${pack.files.length} gathered files`,
        );
        break;
      }
    }
    if (reply.map !== "") pack.map = reply.map;
    if (reply.reason !== "") lastReason = reply.reason;

    const accepted: string[] = [];
    let invalid = 0;
    for (const rel of reply.files) {
      if (accepted.length >= Math.min(remainingFiles, MAX_FILES_PER_ROUND)) break;
      const normalized = rel.trim();
      if (!listingSet.has(normalized) || requested.has(normalized)) {
        invalid += 1;
        continue;
      }
      requested.add(normalized);
      accepted.push(normalized);
    }
    if (invalid > 0) {
      warnings.push(`context: scout round ${round} requested ${invalid} path(s) outside the listing or duplicated; ignored`);
    }

    let byteBudgetReached = false;
    for (const rel of accepted) {
      const budget = Math.min(opts.config.maxFileBytes, opts.config.maxTotalBytes - pack.totalBytes);
      if (budget <= 0) {
        byteBudgetReached = true;
        break;
      }
      const result = readFileCapped(opts.cwd, rel, budget);
      if (!result.ok) {
        warnings.push(`context: skipped ${rel}: ${result.reason}`);
        continue;
      }
      pack.files.push(result.entry);
      pack.totalBytes += result.entry.bytes;
      opts.onProgress?.(
        `[context] read ${rel} (${result.entry.bytes}${result.entry.truncated ? ` of ${result.entry.totalBytes}` : ""} bytes)`,
      );
    }

    if (reply.decision === "done") break;
    if (accepted.length === 0) break; // nothing new requested - more rounds change nothing
    if (byteBudgetReached || pack.files.length >= opts.config.maxFiles) {
      warnings.push("context: pack budget reached before the scout finished; proceeding with what was gathered");
      break;
    }
    if (round === opts.config.maxRounds && reply.decision === "need-files") {
      warnings.push("context: scout still wanted more files at the round cap; proceeding with what was gathered");
    }
  }

  pack.gathered = pack.files.length > 0;
  if (!pack.gathered && pack.skippedReason === undefined) {
    pack.skippedReason = lastReason !== "" ? `scout: ${lastReason}` : "scout requested no files";
  }
  return pack;
}

/**
 * Renders the pack as shared task material. Four-backtick fences keep file
 * contents containing ``` from breaking the structure.
 */
export function contextPackToText(pack: ContextPack): string {
  const sections: string[] = [
    "# Workspace context (read-only excerpts gathered from the user's repository)",
    "",
    "Treat this as authoritative task material: ground every claim about the",
    "repository in these excerpts and do not invent file contents beyond them.",
    "Truncated files are marked; absence of a file here does not prove it",
    "does not exist.",
  ];
  if (pack.map !== "") {
    sections.push("", "## Workspace map (scout orientation)", "", pack.map);
  }
  for (const file of pack.files) {
    const sizeNote = file.truncated ? `first ${file.bytes} of ${file.totalBytes} bytes` : `${file.bytes} bytes`;
    sections.push("", `## File: ${file.path} (${sizeNote})`, "", "````", file.content, "````");
  }
  return sections.join("\n");
}
