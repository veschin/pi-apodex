// Configuration: defaults, environment overrides, and boundary validation.
// Every numeric knob is clamped to a safe range; out-of-range inputs produce a
// warning instead of silently running away.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ApodexConfig, RoleName, RoleSpec } from "./types.ts";

export const SESSION_MODEL = "session";
export const DEFAULT_HEAVY_MODEL = "deepseek/deepseek-v4-pro";
export const DEFAULT_WORKER_MODEL = "deepseek/deepseek-v4-flash";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function defaultConfig(): ApodexConfig {
  return {
    roles: {
      generator: { model: SESSION_MODEL, thinking: "high", temperature: 0.7, maxTokens: 16384 },
      grader: { model: SESSION_MODEL, thinking: "high", temperature: 0, maxTokens: 8192 },
      verifier: { model: SESSION_MODEL, thinking: "high", temperature: 0.2, maxTokens: 8192 },
      worker: { model: DEFAULT_WORKER_MODEL, thinking: "off", temperature: 0, maxTokens: 8192 },
      // judge/scout mirror the (possibly overridden) worker spec unless set
      // explicitly via .apodex.json or APODEX_JUDGE / APODEX_SCOUT - see the
      // mirroring step in loadConfig.
      judge: { model: DEFAULT_WORKER_MODEL, thinking: "off", temperature: 0, maxTokens: 8192 },
      scout: { model: DEFAULT_WORKER_MODEL, thinking: "off", temperature: 0, maxTokens: 8192 },
    },
    rounds: 4,
    candidates: 4,
    scoreThreshold: 92,
    budget: {
      maxSubCalls: 60,
      maxTotalTokens: 3_000_000,
      maxCostUsd: 5,
      maxWallTimeMs: 30 * 60_000,
      subCallTimeoutMs: 360_000,
      subCallMaxRetries: 2,
    },
    exec: { enabled: true, timeoutMs: 10_000 },
    context: {
      enabled: true,
      maxRounds: 2,
      maxFiles: 16,
      maxFileBytes: 16_384,
      maxTotalBytes: 49_152,
      maxListingEntries: 1_500,
    },
    delivery: { planEnabled: true },
    runsDir: ".apodex/runs",
  };
}

interface ClampSpec {
  min: number;
  max: number;
}

const CLAMPS: Record<string, ClampSpec> = {
  rounds: { min: 1, max: 10 },
  candidates: { min: 1, max: 8 },
  scoreThreshold: { min: 50, max: 100 },
  "budget.maxSubCalls": { min: 1, max: 200 },
  "budget.maxTotalTokens": { min: 10_000, max: 20_000_000 },
  "budget.maxCostUsd": { min: 0.01, max: 50 },
  "budget.maxWallTimeMs": { min: 30_000, max: 2 * 60 * 60_000 },
  "budget.subCallTimeoutMs": { min: 10_000, max: 900_000 },
  "budget.subCallMaxRetries": { min: 0, max: 5 },
  "exec.timeoutMs": { min: 1_000, max: 60_000 },
  "context.maxRounds": { min: 1, max: 4 },
  "context.maxFiles": { min: 1, max: 40 },
  "context.maxFileBytes": { min: 1_024, max: 262_144 },
  "context.maxTotalBytes": { min: 4_096, max: 1_048_576 },
  "context.maxListingEntries": { min: 50, max: 5_000 },
};

function clamp(name: string, value: number, warnings: string[]): number {
  const spec = CLAMPS[name];
  if (!spec) return value;
  if (!Number.isFinite(value)) {
    warnings.push(`config: ${name}=${String(value)} is not a finite number; using min ${spec.min}`);
    return spec.min;
  }
  if (value < spec.min) {
    warnings.push(`config: ${name}=${value} below min; clamped to ${spec.min}`);
    return spec.min;
  }
  if (value > spec.max) {
    warnings.push(`config: ${name}=${value} above max; clamped to ${spec.max}`);
    return spec.max;
  }
  return value;
}

/** "provider/model-id" or "session". Returns an error string for anything else. */
export function validateModelSpec(spec: string): string | null {
  if (spec === SESSION_MODEL) return null;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    return `model spec "${spec}" must be "session" or "<provider>/<model-id>"`;
  }
  return null;
}

function isThinkingLevel(value: string): value is RoleSpec["thinking"] {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function readJsonFile(filePath: string, warnings: string[]): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`config: ${filePath} is not a JSON object; ignored`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    warnings.push(`config: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Returns true when a VALID model spec was applied for the role. The flag
 * feeds the judge/scout mirroring decision: only an explicit (and valid)
 * MODEL pins those roles - non-model fields (temperature, thinking) may be
 * customized while the model keeps following the worker role. */
function applyRoleOverride(
  roles: Record<RoleName, RoleSpec>,
  role: RoleName,
  value: unknown,
  source: string,
  warnings: string[],
): boolean {
  if (typeof value === "string") {
    const err = validateModelSpec(value);
    if (err) {
      warnings.push(`config(${source}): ${err}; override ignored`);
      return false;
    }
    roles[role] = { ...roles[role], model: value };
    return true;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const next = { ...roles[role] };
    let modelApplied = false;
    if (typeof obj.model === "string") {
      const err = validateModelSpec(obj.model);
      if (err) warnings.push(`config(${source}): ${err}; model kept as ${next.model}`);
      else {
        next.model = obj.model;
        modelApplied = true;
      }
    }
    if (typeof obj.thinking === "string") {
      if (isThinkingLevel(obj.thinking)) next.thinking = obj.thinking;
      else warnings.push(`config(${source}): invalid thinking "${obj.thinking}" for ${role}; kept ${next.thinking}`);
    }
    if (typeof obj.temperature === "number" && Number.isFinite(obj.temperature)) {
      next.temperature = Math.min(2, Math.max(0, obj.temperature));
    }
    if (typeof obj.maxTokens === "number" && Number.isFinite(obj.maxTokens)) {
      next.maxTokens = Math.min(384_000, Math.max(256, Math.floor(obj.maxTokens)));
    }
    roles[role] = next;
    return modelApplied;
  }
  warnings.push(`config(${source}): role override for ${role} must be a string or object; ignored`);
  return false;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export interface LoadConfigOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Inline overrides (e.g. tool params), applied last. */
  overrides?: Partial<Pick<ApodexConfig, "rounds" | "candidates">>;
}

export interface LoadedConfig {
  config: ApodexConfig;
  warnings: string[];
}

/**
 * Effective config = defaults <- .apodex.json (cwd) <- env APODEX_* <- inline overrides,
 * then clamped. Order matters: explicit beats ambient.
 */
export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  const warnings: string[] = [];
  const env = opts.env ?? process.env;
  const config = defaultConfig();
  // Roles whose MODEL was set explicitly and validly (file or env);
  // judge/scout without an explicit model mirror the FINAL worker model so
  // "make the worker cheaper" does not silently leave them on the old model.
  const explicitModelRoles = new Set<RoleName>();

  // 1. Project file.
  const fileConfig = readJsonFile(path.join(opts.cwd, ".apodex.json"), warnings);
  if (fileConfig) {
    const roles = fileConfig.roles;
    if (typeof roles === "object" && roles !== null && !Array.isArray(roles)) {
      for (const role of ["generator", "grader", "verifier", "worker", "judge", "scout"] as RoleName[]) {
        const value = (roles as Record<string, unknown>)[role];
        if (value !== undefined && applyRoleOverride(config.roles, role, value, ".apodex.json", warnings)) {
          explicitModelRoles.add(role);
        }
      }
    }
    for (const key of ["rounds", "candidates", "scoreThreshold"] as const) {
      const n = numberFrom(fileConfig[key]);
      if (n !== null) config[key] = n;
    }
    const budget = fileConfig.budget;
    if (typeof budget === "object" && budget !== null && !Array.isArray(budget)) {
      const b = budget as Record<string, unknown>;
      for (const key of [
        "maxSubCalls",
        "maxTotalTokens",
        "maxCostUsd",
        "maxWallTimeMs",
        "subCallTimeoutMs",
        "subCallMaxRetries",
      ] as const) {
        const n = numberFrom(b[key]);
        if (n !== null) config.budget[key] = n;
      }
    }
    const exec = fileConfig.exec;
    if (typeof exec === "object" && exec !== null && !Array.isArray(exec)) {
      const e = exec as Record<string, unknown>;
      if (typeof e.enabled === "boolean") config.exec.enabled = e.enabled;
      const n = numberFrom(e.timeoutMs);
      if (n !== null) config.exec.timeoutMs = n;
    }
    const context = fileConfig.context;
    if (typeof context === "object" && context !== null && !Array.isArray(context)) {
      const c = context as Record<string, unknown>;
      if (typeof c.enabled === "boolean") config.context.enabled = c.enabled;
      for (const key of ["maxRounds", "maxFiles", "maxFileBytes", "maxTotalBytes", "maxListingEntries"] as const) {
        const n = numberFrom(c[key]);
        if (n !== null) config.context[key] = n;
      }
    }
    const delivery = fileConfig.delivery;
    if (typeof delivery === "object" && delivery !== null && !Array.isArray(delivery)) {
      const d = delivery as Record<string, unknown>;
      if (typeof d.planEnabled === "boolean") config.delivery.planEnabled = d.planEnabled;
    }
    if (typeof fileConfig.runsDir === "string" && fileConfig.runsDir.trim() !== "") {
      config.runsDir = fileConfig.runsDir;
    }
  }

  // 2. Environment.
  const envRole: Array<[RoleName, string]> = [
    ["generator", "APODEX_GENERATOR"],
    ["grader", "APODEX_GRADER"],
    ["verifier", "APODEX_VERIFIER"],
    ["worker", "APODEX_WORKER"],
    ["judge", "APODEX_JUDGE"],
    ["scout", "APODEX_SCOUT"],
  ];
  for (const [role, key] of envRole) {
    const value = env[key];
    if (value && applyRoleOverride(config.roles, role, value, key, warnings)) {
      explicitModelRoles.add(role);
    }
  }
  const envNum: Array<[keyof Pick<ApodexConfig, "rounds" | "candidates" | "scoreThreshold">, string]> = [
    ["rounds", "APODEX_ROUNDS"],
    ["candidates", "APODEX_CANDIDATES"],
    ["scoreThreshold", "APODEX_SCORE_THRESHOLD"],
  ];
  for (const [key, envKey] of envNum) {
    const n = numberFrom(env[envKey]);
    if (n !== null) config[key] = n;
    else if (env[envKey] !== undefined) warnings.push(`config(${envKey}): not a number; ignored`);
  }
  const envBudget: Array<[keyof ApodexConfig["budget"], string]> = [
    ["maxSubCalls", "APODEX_MAX_SUBCALLS"],
    ["maxTotalTokens", "APODEX_MAX_TOTAL_TOKENS"],
    ["maxCostUsd", "APODEX_MAX_COST_USD"],
    ["maxWallTimeMs", "APODEX_MAX_WALL_TIME_MS"],
    ["subCallTimeoutMs", "APODEX_SUBCALL_TIMEOUT_MS"],
    ["subCallMaxRetries", "APODEX_SUBCALL_MAX_RETRIES"],
  ];
  for (const [key, envKey] of envBudget) {
    const n = numberFrom(env[envKey]);
    if (n !== null) config.budget[key] = n;
    else if (env[envKey] !== undefined) warnings.push(`config(${envKey}): not a number; ignored`);
  }
  if (env.APODEX_EXEC_ENABLED !== undefined) {
    config.exec.enabled = env.APODEX_EXEC_ENABLED !== "0" && env.APODEX_EXEC_ENABLED !== "false";
  }
  if (env.APODEX_CONTEXT_ENABLED !== undefined) {
    config.context.enabled = env.APODEX_CONTEXT_ENABLED !== "0" && env.APODEX_CONTEXT_ENABLED !== "false";
  }
  if (env.APODEX_DELIVERY_PLAN !== undefined) {
    config.delivery.planEnabled = env.APODEX_DELIVERY_PLAN !== "0" && env.APODEX_DELIVERY_PLAN !== "false";
  }
  const envContext: Array<[keyof Omit<ApodexConfig["context"], "enabled">, string]> = [
    ["maxRounds", "APODEX_CONTEXT_MAX_ROUNDS"],
    ["maxFiles", "APODEX_CONTEXT_MAX_FILES"],
    ["maxFileBytes", "APODEX_CONTEXT_MAX_FILE_BYTES"],
    ["maxTotalBytes", "APODEX_CONTEXT_MAX_TOTAL_BYTES"],
    ["maxListingEntries", "APODEX_CONTEXT_MAX_LISTING"],
  ];
  for (const [key, envKey] of envContext) {
    const n = numberFrom(env[envKey]);
    if (n !== null) config.context[key] = n;
    else if (env[envKey] !== undefined) warnings.push(`config(${envKey}): not a number; ignored`);
  }
  if (env.APODEX_RUNS_DIR) config.runsDir = env.APODEX_RUNS_DIR;

  // 3. Inline overrides.
  if (opts.overrides?.rounds !== undefined) config.rounds = opts.overrides.rounds;
  if (opts.overrides?.candidates !== undefined) config.candidates = opts.overrides.candidates;

  // 3.5. Judge/scout without an explicit model mirror the final worker MODEL;
  // their other fields (thinking/temperature/maxTokens) stay as defaulted or
  // explicitly customized.
  if (!explicitModelRoles.has("judge")) config.roles.judge.model = config.roles.worker.model;
  if (!explicitModelRoles.has("scout")) config.roles.scout.model = config.roles.worker.model;

  // 4. Clamp everything numeric.
  config.rounds = Math.floor(clamp("rounds", config.rounds, warnings));
  config.candidates = Math.floor(clamp("candidates", config.candidates, warnings));
  config.scoreThreshold = clamp("scoreThreshold", config.scoreThreshold, warnings);
  config.budget.maxSubCalls = Math.floor(clamp("budget.maxSubCalls", config.budget.maxSubCalls, warnings));
  config.budget.maxTotalTokens = Math.floor(clamp("budget.maxTotalTokens", config.budget.maxTotalTokens, warnings));
  config.budget.maxCostUsd = clamp("budget.maxCostUsd", config.budget.maxCostUsd, warnings);
  config.budget.maxWallTimeMs = Math.floor(clamp("budget.maxWallTimeMs", config.budget.maxWallTimeMs, warnings));
  config.budget.subCallTimeoutMs = Math.floor(
    clamp("budget.subCallTimeoutMs", config.budget.subCallTimeoutMs, warnings),
  );
  config.budget.subCallMaxRetries = Math.floor(
    clamp("budget.subCallMaxRetries", config.budget.subCallMaxRetries, warnings),
  );
  config.exec.timeoutMs = Math.floor(clamp("exec.timeoutMs", config.exec.timeoutMs, warnings));
  config.context.maxRounds = Math.floor(clamp("context.maxRounds", config.context.maxRounds, warnings));
  config.context.maxFiles = Math.floor(clamp("context.maxFiles", config.context.maxFiles, warnings));
  config.context.maxFileBytes = Math.floor(clamp("context.maxFileBytes", config.context.maxFileBytes, warnings));
  config.context.maxTotalBytes = Math.floor(clamp("context.maxTotalBytes", config.context.maxTotalBytes, warnings));
  config.context.maxListingEntries = Math.floor(
    clamp("context.maxListingEntries", config.context.maxListingEntries, warnings),
  );

  return { config, warnings };
}
