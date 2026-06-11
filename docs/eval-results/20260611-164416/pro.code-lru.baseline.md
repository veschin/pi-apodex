```js solution
// solution.mjs
export class AsyncLruCache {
  #map;         // Map<key, { value, storedAt }>
  #inflight;    // Map<key, Promise>   // in-flight computations
  #capacity;    // max fresh entries
  #ttlMs;       // entry lifetime in ms (Infinity means no expiry)
  #now;         // () => number
  #size;        // number of entries thought to be fresh (lazily corrected)

  /**
   * @param {{
   *   capacity: number,
   *   ttlMs?: number,       // positive finite or Infinity, default Infinity
   *   now?: () => number    // default Date.now
   * }} options
   * @throws {TypeError} if capacity is not a positive integer,
   *         if ttlMs is provided and not a positive finite number or Infinity,
   *         if now is provided and not a function
   */
  constructor({ capacity, ttlMs = Infinity, now = Date.now }) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }
    if (ttlMs !== Infinity && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new TypeError('ttlMs must be a positive finite number or Infinity');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }

    this.#map = new Map();
    this.#inflight = new Map();
    this.#capacity = capacity;
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#size = 0;
  }

  /**
   * Number of stored, non-expired entries.
   * Expired entries are removed lazily; calling this getter prunes all expired entries.
   */
  get size() {
    // Clean all expired entries and adjust the cached size.
    for (const [key, entry] of this.#map) {
      if (this.#isExpired(entry)) {
        this.#map.delete(key);
        this.#size--;
      }
    }
    return this.#size;
  }

  // ----- public methods -----

  /**
   * Retrieve a value by key.
   * Returns `undefined` if absent or expired.  Hit refreshes LRU recency.
   */
  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;

    if (this.#isExpired(entry)) {
      // Lazy eviction of expired entry
      this.#map.delete(key);
      this.#size--;          // it was counted as fresh until now
      return undefined;
    }

    // Refresh LRU recency: move to end by delete & re-add (write-TTL, storedAt preserved)
    this.#map.delete(key);
    this.#map.set(key, entry);   // size unchanged
    return entry.value;
  }

  /**
   * Store `value` under `key`.  Refreshes recency.  Evicts least-recently-used fresh
   * entry if capacity is exceeded.
   * @returns {this}
   */
  set(key, value) {
    // Remove existing entry (if any) so we can insert fresh one cleanly
    if (this.#map.has(key)) {
      this.#map.delete(key);
      this.#size--;                  // correct the count (entry was counted, even if expired)
    }

    const entry = { value, storedAt: this.#now() };
    this.#map.set(key, entry);
    this.#size++;

    this.#evictIfNeeded();
    return this;
  }

  /**
   * Delete a key.  Returns `true` if the key was present in the store (even if expired),
   * `false` otherwise.
   *
   * **Interaction with in-flight computations**: If a computation for this key is
   * currently in-flight, the in-flight registration is discarded so that subsequent
   * `getOrCompute` calls start a fresh computation.  Existing waiters that already
   * obtained the promise will still receive the result, but the result **will not**
   * be stored (the delete happened before the computation completed, so the cache
   * stays clean).
   */
  delete(key) {
    const existed = this.#map.has(key);
    if (existed) {
      this.#map.delete(key);
      this.#size--;          // correct count
    }

    // Also discard any in-flight computation so the next getOrCompute starts fresh.
    this.#inflight.delete(key);

    return existed;
  }

  /**
   * Single-flight computation with caching.
   *
   * - If a fresh (non-expired) value exists, returns it immediately **without** calling `computeFn`.
   * - Otherwise, calls `computeFn(key)` **exactly once** even when invoked concurrently
   *   for the same key – all concurrent callers share the same promise.
   * - On success the value is stored (subject to capacity/TTL) with a timestamp
   *   taken at completion time; LRU order is updated.
   * - On failure the in-flight slot is cleared so a later call will retry, and
   *   **all** concurrent waiters reject with the same error.  A failed computation
   *   does **not** leave any entry in the cache.
   */
  async getOrCompute(key, computeFn) {
    // Check for a fresh, non-expired entry first.
    const fresh = this.get(key);   // also handles recency refresh and lazy expiry
    if (fresh !== undefined) {
      return fresh;
    }

    // If an inflight computation already exists, share it.
    if (this.#inflight.has(key)) {
      return this.#inflight.get(key);
    }

    // Start a new computation.
    const promise = (async () => {
      try {
        const value = await computeFn(key);
        // Only store if this promise is still the "official" in-flight one.
        // delete() may have removed it while we were computing.
        if (this.#inflight.get(key) === promise) {
          this.#inflight.delete(key);
          this.set(key, value);   // will honour capacity / TTL
        }
        return value;
      } catch (err) {
        // On failure, clear the in-flight slot (if still ours) so next call can retry.
        if (this.#inflight.get(key) === promise) {
          this.#inflight.delete(key);
        }
        throw err;
      }
    })();

    this.#inflight.set(key, promise);
    return promise;
  }

  // ----- private helpers -----

  #isExpired(entry) {
    return this.#now() - entry.storedAt >= this.#ttlMs;
  }

  /**
   * Evict least-recently-used **fresh** entry (first in insertion order) while accounting
   * for expired entries we encounter along the way.  Runs until `#size <= #capacity`.
   */
  #evictIfNeeded() {
    while (this.#size > this.#capacity) {
      let evictedFresh = false;
      // Map iteration order is insertion order; the first entry is LRU.
      for (const [key, entry] of this.#map) {
        if (this.#isExpired(entry)) {
          // Expired entry – remove it and correct the size.
          this.#map.delete(key);
          this.#size--;
        } else {
          // Fresh entry – evict it.
          this.#map.delete(key);
          this.#size--;
          evictedFresh = true;
          break;
        }
      }
      if (!evictedFresh) {
        // Should never happen while #size > #capacity, but guard against infinite loop.
        break;
      }
    }
  }
}
```

```js selftest
// selftest.mjs
import { AsyncLruCache } from "./solution.mjs";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Set up global rejection / exception handlers so any unobserved failure fails the test.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

// A tiny test runner to avoid heavy dependencies.
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
function runTests() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${name} – ${e.message || e}`);
      console.error(e.stack);
      failed++;
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------------------
// Helper to create a cache with a controllable clock.
function controlledCache({ capacity, ttlMs = Infinity } = {}) {
  let time = 0;
  const now = () => time;
  const cache = new AsyncLruCache({ capacity, ttlMs, now });
  return { cache, now, advance: (ms) => (time += ms), time: () => time };
}

// ===================================================================
// Constructor validation
// ===================================================================
test("constructor throws for non-integer capacity", () => {
  assert.throws(() => new AsyncLruCache({ capacity: 1.5 }), TypeError);
});
test("constructor throws for capacity <= 0", () => {
  assert.throws(() => new AsyncLruCache({ capacity: 0 }), TypeError);
  assert.throws(() => new AsyncLruCache({ capacity: -1 }), TypeError);
});
test("constructor throws for invalid ttlMs", () => {
  assert.throws(() => new AsyncLruCache({ capacity: 2, ttlMs: -1 }), TypeError);
  assert.throws(() => new AsyncLruCache({ capacity: 2, ttlMs: NaN }), TypeError);
  assert.throws(() => new AsyncLruCache({ capacity: 2, ttlMs: 0 }), TypeError);
});
test("constructor throws if now is not a function", () => {
  assert.throws(() => new AsyncLruCache({ capacity: 2, now: 123 }), TypeError);
});

// ===================================================================
// Basic operations (no expiration)
// ===================================================================
test("get / set / size / delete (no expiry)", () => {
  const { cache } = controlledCache({ capacity: 3 });
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.size, 0);

  assert.strictEqual(cache.set("a", 1), cache); // returns this
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.get("a"), 1);

  cache.set("b", 2).set("c", 3);
  assert.strictEqual(cache.size, 3);
  assert.strictEqual(cache.get("a"), 1);
  assert.strictEqual(cache.get("b"), 2);
  assert.strictEqual(cache.get("c"), 3);

  assert.strictEqual(cache.delete("b"), true);
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.get("b"), undefined);
  assert.strictEqual(cache.delete("nonexistent"), false);
});

test("LRU eviction (capacity 2)", () => {
  const { cache } = controlledCache({ capacity: 2 });
  cache.set("a", 1).set("b", 2);
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.get("a"), 1);
  assert.strictEqual(cache.get("b"), 2);

  cache.set("c", 3);          // should evict "a" (oldest)
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.get("b"), 2);
  assert.strictEqual(cache.get("c"), 3);
});

test("LRU recency refresh on get", () => {
  const { cache } = controlledCache({ capacity: 2 });
  cache.set("a", 1).set("b", 2);
  cache.get("a");              // makes "a" most recently used
  cache.set("c", 3);           // should evict "b"
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.get("a"), 1);
  assert.strictEqual(cache.get("b"), undefined);
  assert.strictEqual(cache.get("c"), 3);
});

test("set refreshes recency for existing key", () => {
  const { cache } = controlledCache({ capacity: 2 });
  cache.set("a", 1).set("b", 2);
  cache.set("a", 10);          // update "a", moves to MRU
  cache.set("c", 3);           // should evict "b"
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.get("a"), 10);
  assert.strictEqual(cache.get("b"), undefined);
  assert.strictEqual(cache.get("c"), 3);
});

// ===================================================================
// TTL expiration
// ===================================================================
test("expired entry is absent and removed lazily", () => {
  const { cache, advance } = controlledCache({ capacity: 3, ttlMs: 100 });
  cache.set("x", 42);
  assert.strictEqual(cache.get("x"), 42);
  assert.strictEqual(cache.size, 1);

  advance(101);
  assert.strictEqual(cache.get("x"), undefined);    // expired, no longer visible
  assert.strictEqual(cache.size, 0);                // cleaned by size getter
});

test("size only counts non-expired entries", () => {
  const { cache, advance } = controlledCache({ capacity: 3, ttlMs: 50 });
  cache.set("a", 1);
  cache.set("b", 2);
  advance(60);
  // Both should be expired but still in map
  assert.strictEqual(cache.size, 0);   // size getter prunes them
});

test("getOrCompute skips expired value and recomputes", async () => {
  const { cache, advance } = controlledCache({ capacity: 3, ttlMs: 50 });
  cache.set("k", "old");
  advance(60);
  let called = false;
  const val = await cache.getOrCompute("k", () => {
    called = true;
    return "new";
  });
  assert.strictEqual(called, true);
  assert.strictEqual(val, "new");
  assert.strictEqual(cache.get("k"), "new");
});

// ===================================================================
// getOrCompute – single-flight & caching
// ===================================================================
test("getOrCompute returns fresh value without calling computeFn", async () => {
  const { cache } = controlledCache({ capacity: 3 });
  cache.set("k", "stored");
  let called = false;
  const val = await cache.getOrCompute("k", () => { called = true; return "wrong"; });
  assert.strictEqual(called, false);
  assert.strictEqual(val, "stored");
});

test("getOrCompute single-flight: concurrent callers share computation", async () => {
  const { cache } = controlledCache({ capacity: 3 });
  let callCount = 0;
  const computeFn = () => new Promise(resolve => setTimeout(() => resolve(++callCount), 10));

  const [r1, r2, r3] = await Promise.all([
    cache.getOrCompute("key", computeFn),
    cache.getOrCompute("key", computeFn),
    cache.getOrCompute("key", computeFn),
  ]);
  assert.strictEqual(callCount, 1);     // only one invocation
  assert.strictEqual(r1, 1);
  assert.strictEqual(r2, 1);
  assert.strictEqual(r3, 1);
  assert.strictEqual(cache.get("key"), 1);  // stored
});

test("getOrCompute caches result on success", async () => {
  const { cache } = controlledCache({ capacity: 3 });
  let count = 0;
  const val1 = await cache.getOrCompute("k", () => ++count);
  assert.strictEqual(val1, 1);
  const val2 = await cache.getOrCompute("k", () => { throw new Error("should not be called"); });
  assert.strictEqual(val2, 1);
  assert.strictEqual(count, 1);
});

test("getOrCompute failure clears inflight and rejects all waiters", async () => {
  const { cache } = controlledCache({ capacity: 3 });
  let attempts = 0;
  const faultyFn = () => { attempts++; return Promise.reject(new Error("fail")); };

  // First call will fail
  await assert.rejects(cache.getOrCompute("k", faultyFn), { message: "fail" });
  assert.strictEqual(attempts, 1);
  // Inflight should be cleared, next call retries
  let retry = false;
  const val = await cache.getOrCompute("k", () => { retry = true; return "ok"; });
  assert.strictEqual(retry, true);
  assert.strictEqual(val, "ok");
  assert.strictEqual(cache.get("k"), "ok");
});

test("concurrent waiters reject with the same error", async () => {
  const { cache } = controlledCache({ capacity: 3 });
  let count = 0;
  const err = new Error("boom");
  const compute = () => {
    count++;
    // resolve after tick to simulate async work
    return new Promise((_, reject) => setTimeout(() => reject(err), 10));
  };

  const p1 = cache.getOrCompute("k", compute);
  const p2 = cache.getOrCompute("k", compute);
  const p3 = cache.getOrCompute("k", compute);

  await assert.rejects(p1, { message: "boom" });
  await assert.rejects(p2, { message: "boom" });
  await assert.rejects(p3, { message: "boom" });
  assert.strictEqual(count, 1);       // single attempt
  // Cache must NOT have an entry for "k"
  assert.strictEqual(cache.get("k"), undefined);
});

// ===================================================================
// delete() interaction with in-flight computation
// ===================================================================
test("delete during in-flight computation: waiters still resolve but result not stored", async () => {
  const { cache } = controlledCache({ capacity: 3 });
  let resolveComp;
  const computeFn = () => new Promise(resolve => { resolveComp = resolve; });

  const waiter = cache.getOrCompute("k", computeFn);
  // Before computation completes, delete the key
  assert.strictEqual(cache.delete("k"), false);  // no stored entry yet
  // Complete the computation
  resolveComp("computed");

  const result = await waiter;           // waiters still get the value
  assert.strictEqual(result, "computed");
  // Result must NOT be stored
  assert.strictEqual(cache.get("k"), undefined);
  assert.strictEqual(cache.size, 0);
});

test("delete during in-flight: next getOrCompute starts a fresh computation", async () => {
  const { cache } = controlledCache({ capacity: 3 });
  let resolve1;
  const compute1 = () => new Promise(resolve => { resolve1 = resolve; });

  const p1 = cache.getOrCompute("k", compute1);
  cache.delete("k");            // discard in-flight registration
  // Start a new computation while first is still in-flight
  let called2 = false;
  const p2 = cache.getOrCompute("k", () => { called2 = true; return "second"; });

  resolve1("first");
  await p1;                      // first resolves but does not store
  const val2 = await p2;
  assert.strictEqual(called2, true);
  assert.strictEqual(val2, "second");
  assert.strictEqual(cache.get("k"), "second");
});

// ===================================================================
// Capacity edge cases
// ===================================================================
test("capacity 1 eviction works", () => {
  const { cache } = controlledCache({ capacity: 1 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.get("b"), 2);
});

test("eviction during getOrCompute success respects capacity", async () => {
  const { cache } = controlledCache({ capacity: 1 });
  cache.set("a", 1);
  // compute a new key that will evict "a" on store
  const val = await cache.getOrCompute("b", () => "bval");
  assert.strictEqual(val, "bval");
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.get("b"), "bval");
});

// ===================================================================
// Non-expiry mixed with expiry
// ===================================================================
test("mix of expired and fresh entries – size and LRU order", () => {
  const { cache, advance } = controlledCache({ capacity: 2, ttlMs: 50 });
  cache.set("a", 1);
  advance(60);
  // "a" is now expired but still in map
  cache.set("b", 2);           // fresh
  assert.strictEqual(cache.size, 1);  // only b is fresh (size getter prunes expired)
  // The expired entry should be cleaned, and LRU order should still work
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.get("b"), 2);
  cache.set("c", 3);           // evicts b?
  // Actually capacity 2, after pruning a, fresh count=1, add c becomes 2, no eviction.
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.get("b"), 2);
  assert.strictEqual(cache.get("c"), 3);
});

// ===================================================================
// computeFn receives key argument
// ===================================================================
test("getOrCompute passes key to computeFn", async () => {
  const { cache } = controlledCache({ capacity: 2 });
  const val = await cache.getOrCompute("mykey", (k) => {
    assert.strictEqual(k, "mykey");
    return "ok";
  });
  assert.strictEqual(val, "ok");
});

// ===================================================================
// Run all tests
// ===================================================================
runTests();
```

**How the solution works**

- **Storage**: A `Map` holds entries as `{ value, storedAt }`.  Insertion order serves as LRU order – when a hit occurs, the entry is deleted and re‑added at the end, keeping the least‑recently‑used entry at the front.
- **TTL expiry**: Entries are never proactively purged.  On every access (`get`, `set`, `getOrCompute`, `size`) an entry whose `storedAt + ttlMs ≤ now()` is treated as absent and removed, adjusting the size counter.  The `size` getter iterates the whole map, deleting all expired entries to return the accurate fresh count.  Expired entries that remain in the map are corrected lazily: their “count” is removed the moment they are discovered.
- **LRU eviction**: After storing a fresh entry, if `#size > capacity` a loop scans the map from the front (oldest).  Any expired entries encountered are cleaned first; then the first fresh entry is evicted.  This repeats until the fresh count fits inside capacity.
- **Single‑flight (`getOrCompute`)**: An `#inflight` map tracks promises.  When no fresh value exists and no in‑flight promise is present for a key, a new promise is started.  On success, it checks whether it is still the “current” in‑flight promise (it may have been removed by `delete`) and only then stores the result via `set`.  On failure, the in‑flight slot is cleared so retries work, and all waiters reject with the same error.
- **Delete with in‑flight computations**: `delete(key)` removes any stored entry and also discards the in‑flight registration from `#inflight`.  Waiters that already hold the promise still resolve (they receive the computed value), but the result is **not** written back because the check in the success path fails.  A subsequent `getOrCompute` will start a fresh computation.

**Edge cases covered**

- Capacity of 1 and general eviction during `set` and `getOrCompute`.
- Keys that are expired but still physically present – correctly skipped and cleaned.
- `delete` during an in‑flight computation; the promised value is delivered to current waiters but not stored.
- Multiple concurrent `getOrCompute` callers sharing a single computation and rejecting/failing together.
- `computeFn` receiving the key argument.
- Constructor validation for all described parameters.

**Limitations / Unverified aspects**

- The tests use `setTimeout` for a few async scenarios, which relies on Node’s event loop.  They are still fully deterministic given the controlled clock, but the timing of microtasks is guaranteed.
- The solution was not run in this environment; the selftest block is designed to be executed with `node --experimental-vm-modules` or a recent Node version that supports ESM.  The import path `./solution.mjs` assumes the solution file is named `solution.mjs` in the same directory.  All assertions cover the stated requirements.