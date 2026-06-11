// Robust JSON extraction from LLM responses that may wrap JSON in markdown
// fences or prose. Balanced-brace scan, string/escape aware.

export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json|JSON)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through to balanced scan */
  }
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Clamp an arbitrary value to a finite integer in [min, max], or null. */
export function asBoundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n < min || n > max) return Math.min(max, Math.max(min, n));
  return n;
}

export function asStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .slice(0, maxItems)
    .map((s) => (s.length > maxLen ? `${s.slice(0, maxLen)}...` : s));
}

/**
 * Robust boolean-field extraction from model output. Models occasionally emit
 * structurally invalid JSON (an unescaped quote inside a string broke a real
 * eval run) while machine-generated boolean fields stay reliable - fall back
 * to a targeted regex before declaring the output unusable.
 */
export function extractBoolField(text: string, field: string): boolean | null {
  const parsed = parseJsonLoose<Record<string, unknown>>(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed[field] === "boolean") {
    return parsed[field];
  }
  const match = new RegExp(`"${field}"\\s*:\\s*(true|false)`).exec(text);
  if (match) return match[1] === "true";
  return null;
}

/** Same fallback discipline for short string-enum fields. */
export function extractEnumField(text: string, field: string, values: readonly string[]): string | null {
  const parsed = parseJsonLoose<Record<string, unknown>>(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const value = parsed[field];
    if (typeof value === "string" && values.includes(value)) return value;
  }
  const match = new RegExp(`"${field}"\\s*:\\s*"(${values.join("|")})"`).exec(text);
  if (match && match[1] !== undefined) return match[1];
  return null;
}
