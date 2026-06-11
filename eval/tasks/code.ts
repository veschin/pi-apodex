// Code bucket: non-trivial implementation tasks with hidden deterministic tests.
// The hidden test is never shown to either arm; it imports ./solution.mjs and
// prints "APODEX_TESTS <passed>/<total>".

import { scoreCodeWithHiddenTest } from "../scoring.ts";
import type { EvalTask } from "../types.ts";

const OUTPUT_NOTE = `Output the complete solution in one fenced block tagged exactly \`\`\`js solution
(ESM, default and/or named exports as specified). You may add a \`\`\`js selftest block
with your own tests (it must import from "./solution.mjs").`;

// ---------------------------------------------------------------------------
// Task 1: interval subtraction with half-open semantics.

const intervalPrompt = `Implement interval subtraction for half-open integer intervals [start, end).

Export (ESM): export function subtractIntervals(a, b)

- "a" and "b" are arrays of [start, end) pairs of finite integers, possibly
  unsorted and possibly overlapping WITHIN each list.
- Return a minus b: the set of points covered by "a" but not by "b", as a
  minimal sorted list of disjoint [start, end) pairs.
- Normalize inputs first (sort + merge overlapping/touching intervals within each list).
- Throw a TypeError for: non-array input, an element that is not a 2-tuple of
  finite integers, or a pair with start > end. A pair with start === end is
  valid and denotes the empty interval (ignore it).
- Must handle: empty lists, b fully covering a, b splitting one interval of a
  into several pieces, adjacent boundaries (touching intervals do NOT overlap:
  [1,3) minus [3,5) is [1,3)).

${OUTPUT_NOTE}`;

const intervalHiddenTest = `import { subtractIntervals } from "./solution.mjs";
let passed = 0, total = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function check(name, fn) {
  total++;
  try {
    const r = fn();
    if (r === true) { passed++; console.log("ok " + name); }
    else console.log("FAIL " + name + " -> " + JSON.stringify(r));
  } catch (e) { console.log("FAIL " + name + " threw " + e.message); }
}
function throws(fn) {
  try { fn(); return false; } catch (e) { return e instanceof TypeError; }
}
check("basic split", () => eq(subtractIntervals([[0, 10]], [[3, 5]]), [[0, 3], [5, 10]]));
check("empty a", () => eq(subtractIntervals([], [[1, 2]]), []));
check("empty b", () => eq(subtractIntervals([[1, 2]], []), [[1, 2]]));
check("b covers a", () => eq(subtractIntervals([[2, 4]], [[0, 10]]), []));
check("touching not overlapping", () => eq(subtractIntervals([[1, 3]], [[3, 5]]), [[1, 3]]));
check("unsorted overlapping a", () => eq(subtractIntervals([[5, 8], [0, 6]], [[2, 3]]), [[0, 2], [3, 8]]));
check("unsorted overlapping b", () => eq(subtractIntervals([[0, 10]], [[7, 9], [1, 3], [2, 4]]), [[0, 1], [4, 7], [9, 10]]));
check("empty interval in input ignored", () => eq(subtractIntervals([[1, 1], [2, 4]], [[3, 3]]), [[2, 4]]));
check("multiple splits", () => eq(subtractIntervals([[0, 20]], [[2, 4], [6, 8], [10, 12]]), [[0, 2], [4, 6], [8, 10], [12, 20]]));
check("exact match", () => eq(subtractIntervals([[1, 5]], [[1, 5]]), []));
check("negative coords", () => eq(subtractIntervals([[-10, -2]], [[-5, -4]]), [[-10, -5], [-4, -2]]));
check("throws on non-array", () => throws(() => subtractIntervals("x", [])));
check("throws on bad pair", () => throws(() => subtractIntervals([[1]], [])));
check("throws on start>end", () => throws(() => subtractIntervals([[5, 1]], [])));
check("throws on non-integer", () => throws(() => subtractIntervals([[1.5, 3]], [])));
check("throws on NaN", () => throws(() => subtractIntervals([[NaN, 3]], [])));
console.log(\`APODEX_TESTS \${passed}/\${total}\`);
process.exit(passed === total ? 0 : 1);
`;

// ---------------------------------------------------------------------------
// Task 2: async retry with injectable sleep, deterministic backoff, abort.

const retryPrompt = `Implement a production-grade async retry helper.

Export (ESM): export function retry(fn, options) - returns a Promise.
NOTE: declare it as a regular (non-async) function so that input validation can
throw synchronously (an "async function" turns throws into rejections).

Options (all optional unless stated):
- retries: number of RETRIES after the first attempt (default 3). retries=0 means exactly one attempt.
- baseDelayMs: first backoff delay (default 100).
- maxDelayMs: cap for any delay (default 30000).
- retryOn: (error) => boolean; only errors passing it are retried (default: retry all).
- signal: AbortSignal. Aborting must (a) prevent further attempts, and (b) interrupt
  an in-progress backoff wait immediately. On abort, reject with the signal's reason
  if set, else a DOMException named "AbortError".
- sleep: injectable (ms, signal) => Promise<void> used for backoff waits (default:
  real timer that resolves after ms or rejects on abort). Tests rely on this seam.

Behavior:
- Attempt fn(attemptIndex) with attemptIndex starting at 0.
- On success: resolve with fn's value.
- On failure: if attempts are exhausted OR retryOn(error) is false, reject with
  an AggregateError whose "errors" array contains EVERY attempt error in order
  (even when only one attempt was made) and whose message mentions the attempt
  count. When the signal aborts, reject promptly - either with the abort reason
  or with an AggregateError that includes it; no further attempts or waits.
- Backoff before retry k (1-based) is min(baseDelayMs * 2**(k-1), maxDelayMs) - no jitter.
- Validate inputs: fn must be a function; numeric options must be non-negative
  finite numbers; throw TypeError synchronously on violations.

${OUTPUT_NOTE}`;

const retryHiddenTest = `import { retry } from "./solution.mjs";
let passed = 0, total = 0;
async function check(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r === true) { passed++; console.log("ok " + name); }
    else console.log("FAIL " + name + " -> " + JSON.stringify(r));
  } catch (e) { console.log("FAIL " + name + " threw " + (e && e.message)); }
}
const fakeSleep = (log) => (ms, _signal) => { log.push(ms); return Promise.resolve(); };

await check("success first try, no sleeps", async () => {
  const delays = [];
  const v = await retry(async () => 42, { sleep: fakeSleep(delays) });
  return v === 42 && delays.length === 0;
});
await check("retries then succeeds; exponential delays", async () => {
  const delays = [];
  let n = 0;
  const v = await retry(async () => { if (++n < 4) throw new Error("e" + n); return "ok"; },
    { retries: 5, baseDelayMs: 100, sleep: fakeSleep(delays) });
  return v === "ok" && JSON.stringify(delays) === JSON.stringify([100, 200, 400]);
});
await check("maxDelay caps", async () => {
  const delays = [];
  let n = 0;
  await retry(async () => { if (++n < 5) throw new Error("x"); return 1; },
    { retries: 6, baseDelayMs: 1000, maxDelayMs: 2500, sleep: fakeSleep(delays) });
  return JSON.stringify(delays) === JSON.stringify([1000, 2000, 2500, 2500]);
});
await check("AggregateError with all errors in order", async () => {
  const delays = [];
  let n = 0;
  try {
    await retry(async () => { throw new Error("err" + (n++)); }, { retries: 2, sleep: fakeSleep(delays) });
    return "did not reject";
  } catch (e) {
    return e instanceof AggregateError && e.errors.length === 3
      && e.errors[0].message === "err0" && e.errors[2].message === "err2";
  }
});
await check("retryOn=false stops immediately", async () => {
  let attempts = 0;
  try {
    await retry(async () => { attempts++; throw new Error("fatal"); },
      { retries: 5, retryOn: (e) => e.message !== "fatal", sleep: fakeSleep([]) });
    return "did not reject";
  } catch (e) {
    return attempts === 1 && e instanceof AggregateError && e.errors.length === 1;
  }
});
await check("retries=0 means one attempt", async () => {
  let attempts = 0;
  try {
    await retry(async () => { attempts++; throw new Error("x"); }, { retries: 0, sleep: fakeSleep([]) });
    return "did not reject";
  } catch (e) { return attempts === 1 && e instanceof AggregateError; }
});
await check("abort prevents further attempts", async () => {
  const ac = new AbortController();
  let attempts = 0;
  try {
    await retry(async () => { attempts++; ac.abort(); throw new Error("boom"); },
      { retries: 5, signal: ac.signal, sleep: fakeSleep([]) });
    return "did not reject";
  } catch (e) { return attempts === 1; }
});
await check("abort interrupts backoff wait", async () => {
  const ac = new AbortController();
  // first attempt fails fast, then implementation enters a 60s real backoff;
  // abort at +50ms must interrupt it. Race against 3s so a non-abortable
  // implementation fails THIS check without hanging the whole suite.
  const t0 = Date.now();
  const timer = setTimeout(() => ac.abort(), 50);
  const attempt = retry(async () => { throw new Error("always"); },
    { retries: 3, baseDelayMs: 60000, signal: ac.signal })
    .then(() => "did not reject", () => (Date.now() - t0 < 3000 ? true : "rejected too slowly"));
  const guard = new Promise((resolve) => setTimeout(() => resolve("hung past 3s"), 3000));
  const result = await Promise.race([attempt, guard]);
  clearTimeout(timer);
  attempt.catch(() => {});
  return result;
});
await check("validates fn", async () => {
  try { retry("nope", {}); return "no throw"; } catch (e) { return e instanceof TypeError; }
});
await check("validates negative retries", async () => {
  try { retry(async () => 1, { retries: -1 }); return "no throw"; } catch (e) { return e instanceof TypeError; }
});
console.log(\`APODEX_TESTS \${passed}/\${total}\`);
process.exit(passed === total ? 0 : 1);
`;

// ---------------------------------------------------------------------------
// Task 3: LRU + TTL + single-flight getOrCompute.

const lruPrompt = `Implement an async-aware LRU cache with TTL and single-flight computation.

Export (ESM): export class AsyncLruCache

Constructor: new AsyncLruCache({ capacity, ttlMs, now }) where
- capacity: positive integer, max number of STORED entries (in-flight computations
  do not count until they resolve). Throw TypeError otherwise.
- ttlMs: entry lifetime in ms, positive finite number or Infinity (default Infinity).
- now: injectable clock () => number (default Date.now). Tests rely on this seam.

Methods:
- get(key): value or undefined. An expired entry must behave as absent (and be
  evicted lazily). A hit refreshes LRU recency; expiry is measured from when the
  value was STORED (write TTL, not sliding).
- set(key, value): store value, refresh recency, evict least-recently-used entry
  if capacity exceeded. Returns this.
- delete(key): boolean.
- get size(): number of stored, non-expired entries (expired entries must not be counted).
- async getOrCompute(key, computeFn): if a fresh value exists, return it WITHOUT
  calling computeFn. Otherwise call computeFn(key) exactly once even when called
  concurrently for the same key (single-flight: concurrent callers await the same
  in-flight promise). On success the value is stored (subject to capacity/TTL,
  timestamped at completion time). On failure the in-flight slot is cleared so a
  later call retries, and ALL concurrent waiters reject with the same error.
  A rejected computation must NOT poison the cache.

Edge cases that must work: capacity 1; getOrCompute for a key whose stored value
expired while a computation for another key is in flight; delete() of a key that
has an in-flight computation (waiters still resolve, but the result of the deleted
computation must still be stored only if delete happened BEFORE completion - define
and implement a consistent rule and document it: simplest correct rule is that
delete() also discards the in-flight registration so the next getOrCompute starts fresh).

${OUTPUT_NOTE}`;

const lruHiddenTest = `import { AsyncLruCache } from "./solution.mjs";
let passed = 0, total = 0;
async function check(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r === true) { passed++; console.log("ok " + name); }
    else console.log("FAIL " + name + " -> " + JSON.stringify(r));
  } catch (e) { console.log("FAIL " + name + " threw " + (e && e.message)); }
}
function clock(start = 0) { let t = start; return { now: () => t, tick: (ms) => { t += ms; } }; }

await check("validates capacity", async () => {
  try { new AsyncLruCache({ capacity: 0 }); return "no throw"; } catch (e) { return e instanceof TypeError; }
});
await check("basic set/get + recency eviction", async () => {
  const c = new AsyncLruCache({ capacity: 2 });
  c.set("a", 1).set("b", 2);
  c.get("a");            // a is now most recent
  c.set("c", 3);         // evicts b
  return c.get("a") === 1 && c.get("b") === undefined && c.get("c") === 3;
});
await check("ttl expiry via injected clock", async () => {
  const k = clock();
  const c = new AsyncLruCache({ capacity: 5, ttlMs: 100, now: k.now });
  c.set("x", "v");
  k.tick(99);
  const fresh = c.get("x") === "v";
  k.tick(2);
  return fresh && c.get("x") === undefined && c.size === 0;
});
await check("size excludes expired", async () => {
  const k = clock();
  const c = new AsyncLruCache({ capacity: 5, ttlMs: 50, now: k.now });
  c.set("a", 1); k.tick(60); c.set("b", 2);
  return c.size === 1;
});
await check("single-flight: concurrent getOrCompute computes once", async () => {
  const c = new AsyncLruCache({ capacity: 5 });
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return "V"; };
  const [r1, r2, r3] = await Promise.all([
    c.getOrCompute("k", slow), c.getOrCompute("k", slow), c.getOrCompute("k", slow),
  ]);
  return calls === 1 && r1 === "V" && r2 === "V" && r3 === "V" && c.get("k") === "V";
});
await check("fresh value short-circuits computeFn", async () => {
  const c = new AsyncLruCache({ capacity: 5 });
  c.set("k", 7);
  let called = false;
  const v = await c.getOrCompute("k", async () => { called = true; return 9; });
  return v === 7 && called === false;
});
await check("failed computation rejects all waiters and does not poison", async () => {
  const c = new AsyncLruCache({ capacity: 5 });
  let calls = 0;
  const failing = async () => { calls++; await new Promise(r => setTimeout(r, 10)); throw new Error("nope"); };
  const results = await Promise.allSettled([c.getOrCompute("k", failing), c.getOrCompute("k", failing)]);
  const bothRejected = results.every(r => r.status === "rejected");
  const v = await c.getOrCompute("k", async () => "recovered");
  return calls === 1 && bothRejected && v === "recovered" && c.get("k") === "recovered";
});
await check("expired entry recomputed", async () => {
  const k = clock();
  const c = new AsyncLruCache({ capacity: 5, ttlMs: 100, now: k.now });
  let calls = 0;
  await c.getOrCompute("k", async () => { calls++; return calls; });
  k.tick(150);
  const v = await c.getOrCompute("k", async () => { calls++; return calls; });
  return calls === 2 && v === 2;
});
await check("capacity 1 with getOrCompute", async () => {
  const c = new AsyncLruCache({ capacity: 1 });
  await c.getOrCompute("a", async () => 1);
  await c.getOrCompute("b", async () => 2);
  return c.get("b") === 2 && c.get("a") === undefined && c.size === 1;
});
console.log(\`APODEX_TESTS \${passed}/\${total}\`);
process.exit(passed === total ? 0 : 1);
`;

export const codeTasks: EvalTask[] = [
  {
    id: "code-intervals",
    bucket: "code",
    prompt: intervalPrompt,
    score: (answer, ctx) => scoreCodeWithHiddenTest(answer, intervalHiddenTest, ctx),
  },
  {
    id: "code-retry",
    bucket: "code",
    prompt: retryPrompt,
    score: (answer, ctx) => scoreCodeWithHiddenTest(answer, retryHiddenTest, ctx),
  },
  {
    id: "code-lru",
    bucket: "code",
    prompt: lruPrompt,
    score: (answer, ctx) => scoreCodeWithHiddenTest(answer, lruHiddenTest, ctx),
  },
];

// ---------------------------------------------------------------------------
// Harness self-check fixtures (eval/selfcheck.ts): reference solutions that
// must score 1.00, plus broken variants that must score < 1.00. These are
// never shown to any model - they validate the hidden tests themselves.

const intervalReference = `export function subtractIntervals(a, b) {
  const norm = (list, name) => {
    if (!Array.isArray(list)) throw new TypeError(name + " must be an array");
    const pairs = list.map((p) => {
      if (!Array.isArray(p) || p.length !== 2) throw new TypeError("element must be a 2-tuple");
      const [s, e] = p;
      if (!Number.isInteger(s) || !Number.isInteger(e)) throw new TypeError("bounds must be finite integers");
      if (s > e) throw new TypeError("start > end");
      return [s, e];
    }).filter(([s, e]) => s < e).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const merged = [];
    for (const [s, e] of pairs) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged;
  };
  const A = norm(a, "a");
  const B = norm(b, "b");
  const out = [];
  let bi = 0;
  for (const [s, e] of A) {
    while (bi < B.length && B[bi][1] <= s) bi++;
    let cur = s;
    let bj = bi;
    while (bj < B.length && B[bj][0] < e) {
      const [bs, be] = B[bj];
      if (bs > cur) out.push([cur, Math.min(bs, e)]);
      cur = Math.max(cur, be);
      if (cur >= e) break;
      bj++;
    }
    if (cur < e) out.push([cur, e]);
  }
  return out;
}
`;

const retryReference = `export function retry(fn, options = {}) {
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  const {
    retries = 3,
    baseDelayMs = 100,
    maxDelayMs = 30000,
    retryOn = () => true,
    signal,
    sleep = defaultSleep,
  } = options;
  for (const [name, v] of [["retries", retries], ["baseDelayMs", baseDelayMs], ["maxDelayMs", maxDelayMs]]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new TypeError(name + " must be a non-negative finite number");
    }
  }
  if (typeof retryOn !== "function") throw new TypeError("retryOn must be a function");
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");

  return (async () => {
    const errors = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) throw abortReason(signal);
      try {
        return await fn(attempt);
      } catch (err) {
        errors.push(err);
        if (attempt === retries || !retryOn(err)) {
          throw new AggregateError(errors, "retry failed after " + errors.length + " attempt(s)");
        }
        if (signal?.aborted) throw abortReason(signal);
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await sleep(delay, signal);
      }
    }
    throw new AggregateError(errors, "retry failed after " + errors.length + " attempt(s)");
  })();
}

function abortReason(signal) {
  return signal.reason !== undefined ? signal.reason : new DOMException("Aborted", "AbortError");
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
`;

const lruReference = `export class AsyncLruCache {
  #capacity; #ttlMs; #now;
  #map = new Map();      // key -> { value, at }
  #inflight = new Map(); // key -> { promise }
  constructor({ capacity, ttlMs = Infinity, now = Date.now } = {}) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new TypeError("capacity must be a positive integer");
    if (typeof ttlMs !== "number" || Number.isNaN(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive number or Infinity");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.#capacity = capacity;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }
  #expired(entry) { return this.#ttlMs !== Infinity && this.#now() - entry.at >= this.#ttlMs; }
  #purge() { for (const [k, e] of this.#map) if (this.#expired(e)) this.#map.delete(k); }
  get(key) {
    const e = this.#map.get(key);
    if (!e) return undefined;
    if (this.#expired(e)) { this.#map.delete(key); return undefined; }
    this.#map.delete(key);
    this.#map.set(key, e);
    return e.value;
  }
  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, { value, at: this.#now() });
    this.#purge();
    while (this.#map.size > this.#capacity) {
      this.#map.delete(this.#map.keys().next().value);
    }
    return this;
  }
  delete(key) {
    this.#inflight.delete(key); // discard in-flight registration: next getOrCompute starts fresh
    return this.#map.delete(key);
  }
  get size() {
    this.#purge();
    return this.#map.size;
  }
  async getOrCompute(key, computeFn) {
    if (typeof computeFn !== "function") throw new TypeError("computeFn must be a function");
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const inflight = this.#inflight.get(key);
    if (inflight) return inflight.promise;
    const record = { promise: null };
    this.#inflight.set(key, record);
    record.promise = (async () => {
      try {
        const value = await computeFn(key);
        if (this.#inflight.get(key) === record) this.set(key, value);
        return value;
      } finally {
        if (this.#inflight.get(key) === record) this.#inflight.delete(key);
      }
    })();
    return record.promise;
  }
}
`;

export interface SelfCheckFixture {
  id: string;
  hiddenTest: string;
  /** Must score 1.00. */
  reference: string;
  /** Must score < 1.00 (a realistic partial implementation). */
  broken: string;
}

export const codeSelfCheckFixtures: SelfCheckFixture[] = [
  {
    id: "code-intervals",
    hiddenTest: intervalHiddenTest,
    reference: intervalReference,
    // Broken: ignores normalization of overlapping inputs and skips validation.
    broken: `export function subtractIntervals(a, b) {
  const out = [];
  for (const [s, e] of [...a].sort((x, y) => x[0] - y[0])) {
    let cur = s;
    for (const [bs, be] of [...b].sort((x, y) => x[0] - y[0])) {
      if (be <= cur || bs >= e) continue;
      if (bs > cur) out.push([cur, bs]);
      cur = Math.max(cur, be);
    }
    if (cur < e) out.push([cur, e]);
  }
  return out;
}
`,
  },
  {
    id: "code-retry",
    hiddenTest: retryHiddenTest,
    reference: retryReference,
    // Broken: async function (no sync throw), forgets error aggregation order
    // and ignores abort during backoff.
    broken: `export async function retry(fn, options = {}) {
  const { retries = 3, baseDelayMs = 100, maxDelayMs = 30000, retryOn = () => true, sleep } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === retries || !retryOn(err)) throw new AggregateError([lastError], "failed");
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      if (sleep) await sleep(delay); else await new Promise(r => setTimeout(r, delay));
    }
  }
}
`,
  },
  {
    id: "code-lru",
    hiddenTest: lruHiddenTest,
    reference: lruReference,
    // Broken: no single-flight (every concurrent caller computes), TTL sliding
    // instead of write-based, size counts expired entries.
    broken: `export class AsyncLruCache {
  constructor({ capacity, ttlMs = Infinity, now = Date.now } = {}) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new TypeError("bad capacity");
    this.capacity = capacity; this.ttlMs = ttlMs; this.now = now; this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.ttlMs !== Infinity && this.now() - e.at >= this.ttlMs) { this.map.delete(key); return undefined; }
    e.at = this.now(); // BUG: sliding TTL
    this.map.delete(key); this.map.set(key, e);
    return e.value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
    return this;
  }
  delete(key) { return this.map.delete(key); }
  get size() { return this.map.size; } // BUG: counts expired
  async getOrCompute(key, computeFn) {
    const v = this.get(key);
    if (v !== undefined) return v;
    const value = await computeFn(key); // BUG: no single-flight
    this.set(key, value);
    return value;
  }
}
`,
  },
];
