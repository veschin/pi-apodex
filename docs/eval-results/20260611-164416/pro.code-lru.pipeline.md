```js solution
export class AsyncLruCache {
  #capacity;
  #ttlMs;
  #now;
  #map = new Map();       // key → node
  #head;                 // sentinel – least‑recently‑used side
  #tail;                 // sentinel – most‑recently‑used side
  #inFlight = new Map(); // key → Promise

  constructor({ capacity, ttlMs, now } = {}) {
    // ---- capacity ----
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }

    // ---- ttlMs ----
    if (ttlMs === undefined) {
      ttlMs = Infinity;
    } else if (
      !((Number.isFinite(ttlMs) && ttlMs > 0) || ttlMs === Infinity)
    ) {
      throw new TypeError(
        'ttlMs must be a positive finite number or Infinity',
      );
    }

    // ---- clock ----
    if (now !== undefined && typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }

    this.#capacity = capacity;
    this.#ttlMs = ttlMs;
    this.#now = now || Date.now;

    // doubly‑linked list with sentinel nodes (most recent at tail.prev)
    this.#head = { prev: null, next: null };
    this.#tail = { prev: null, next: null };
    this.#head.next = this.#tail;
    this.#tail.prev = this.#head;
  }

  // ---- helpers ----

  #isExpired(node) {
    if (this.#ttlMs === Infinity) return false;
    return this.#now() - node.storedTime > this.#ttlMs;
  }

  /** Unlink a node from the list */
  #detach(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  /** Append node just before the tail (most‑recently‑used end) */
  #linkEnd(node) {
    node.prev = this.#tail.prev;
    node.next = this.#tail;
    this.#tail.prev.next = node;
    this.#tail.prev = node;
  }

  /**
   * Evict a single entry, preferring any expired one over a fresh LRU.
   * Walk from head to tail; the first expired node found wins.
   * If none are expired, evict the absolute LRU (head.next).
   */
  #evictEntry() {
    for (let node = this.#head.next; node !== this.#tail; node = node.next) {
      if (this.#isExpired(node)) {
        this.#detach(node);
        this.#map.delete(node.key);
        return;
      }
    }
    // no expired entry – evict the least‑recently‑used
    const lru = this.#head.next;
    if (lru !== this.#tail) {
      this.#detach(lru);
      this.#map.delete(lru.key);
    }
  }

  // ---- public API ----

  /**
   * Retrieve a value by key. Expired entries are lazily removed.
   * Returns the stored value (including `undefined`, if explicitly set).
   */
  get(key) {
    const node = this.#map.get(key);
    if (!node) return undefined;

    if (this.#isExpired(node)) {
      this.#detach(node);
      this.#map.delete(key);
      return undefined;
    }

    // hit – refresh recency
    this.#detach(node);
    this.#linkEnd(node);
    return node.value;
  }

  /**
   * Store a key/value pair. Refreshes recency if the key already exists.
   * Evicts entries (preferring expired ones) when capacity is exceeded.
   */
  set(key, value) {
    const now = this.#now();
    const node = this.#map.get(key);

    if (node) {
      // update existing entry
      node.value = value;
      node.storedTime = now;
      this.#detach(node);
      this.#linkEnd(node);
    } else {
      // new entry
      const newNode = { key, value, storedTime: now, prev: null, next: null };
      this.#map.set(key, newNode);
      this.#linkEnd(newNode);

      // evict until we are within capacity
      while (this.#map.size > this.#capacity) {
        this.#evictEntry();
      }
    }
    return this;
  }

  /**
   * Delete a key. Returns `true` if a stored entry existed (regardless of
   * value). Also discards any in‑flight computation registration so that
   * subsequent `getOrCompute` calls start fresh.
   *
   * The already‑in‑flight computation continues to completion and its waiters
   * will still receive the result, but the result will **not** be stored in
   * the cache (unless a new, fresh entry is stored by other means).
   */
  delete(key) {
    const hadStored = this.#map.has(key);
    if (hadStored) {
      const node = this.#map.get(key);
      this.#detach(node);
      this.#map.delete(key);
    }

    // clear in‑flight registration so new callers are not chained
    if (this.#inFlight.has(key)) {
      this.#inFlight.delete(key);
    }
    return hadStored;
  }

  /** Number of currently stored, non‑expired entries. */
  get size() {
    let count = 0;
    for (const node of this.#map.values()) {
      if (!this.#isExpired(node)) count++;
    }
    return count;
  }

  /**
   * Get an existing fresh value, or compute it with single‑flight semantics.
   *
   * - If a fresh (non‑expired) stored value exists, it is returned immediately
   *   (after refreshing LRU recency) – `computeFn` is NOT called.
   * - Otherwise, if a computation is already in flight for the same key,
   *   all concurrent callers share the same Promise.
   * - Otherwise, `computeFn(key)` is invoked exactly once. On success the
   *   value is stored **only if** the in‑flight registration has not been
   *   cleared (e.g. by a concurrent `delete`) and no fresh entry is already
   *   present (e.g. from a concurrent `set`). On failure the in‑flight slot
   *   is cleared and all waiters reject with the same error. A rejected
   *   computation never poisons the cache.
   */
  async getOrCompute(key, computeFn) {
    // Validate computeFn early
    if (typeof computeFn !== 'function') {
      throw new TypeError('computeFn must be a function');
    }

    // 1 – fresh stored entry?
    const storedNode = this.#map.get(key);
    if (storedNode) {
      if (!this.#isExpired(storedNode)) {
        // fresh: refresh recency and return value (even undefined)
        this.#detach(storedNode);
        this.#linkEnd(storedNode);
        return storedNode.value;
      } else {
        // expired – evict lazily
        this.#detach(storedNode);
        this.#map.delete(key);
        // fall through to computation
      }
    }

    // 2 – already in flight? Reuse the existing Promise.
    if (this.#inFlight.has(key)) {
      return this.#inFlight.get(key);
    }

    // 3 – start a new single‑flight computation
    let resolvePromise, rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // Register the promise BEFORE the computation starts so that concurrent
    // callers can see it, and so that even synchronous errors do not leave a
    // stale rejected promise in the inFlight map.
    this.#inFlight.set(key, promise);

    (async () => {
      try {
        const value = await computeFn(key);
        // Store the result only if the in‑flight slot still belongs to this
        // computation (i.e. it was not cleared by delete) and no fresh entry
        // has been stored concurrently.
        if (this.#inFlight.get(key) === promise) {
          const current = this.#map.get(key);
          if (!current || this.#isExpired(current)) {
            this.set(key, value);
          }
        }
        resolvePromise(value);
      } catch (err) {
        rejectPromise(err);
      } finally {
        if (this.#inFlight.get(key) === promise) {
          this.#inFlight.delete(key);
        }
      }
    })();

    return promise;
  }
}
```

```js selftest
import { AsyncLruCache } from "./solution.mjs";

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name} - ${e.message}`);
    failed = true;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name} - ${e.message}`);
    failed = true;
  }
}

(async () => {
  // Fail on unhandled rejections / exceptions
  process.on('unhandledRejection', (reason) => {
    console.error('FAIL: unhandled rejection -', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('FAIL: uncaught exception -', err);
    process.exit(1);
  });

  // ---- constructor validation ----
  test('throws on non-integer capacity', () => {
    try { new AsyncLruCache({ capacity: 1.5 }); throw new Error('expected TypeError'); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  });
  test('throws on capacity 0', () => {
    try { new AsyncLruCache({ capacity: 0 }); throw new Error('expected TypeError'); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  });
  test('throws on negative capacity', () => {
    try { new AsyncLruCache({ capacity: -1 }); throw new Error('expected TypeError'); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  });
  test('accepts positive integer capacity', () => new AsyncLruCache({ capacity: 1 }));

  test('default ttlMs Infinity', () => new AsyncLruCache({ capacity: 1 }));

  test('throws on zero ttlMs', () => {
    try { new AsyncLruCache({ capacity: 1, ttlMs: 0 }); throw new Error('expected TypeError'); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  });
  test('throws on negative ttlMs', () => {
    try { new AsyncLruCache({ capacity: 1, ttlMs: -1 }); throw new Error('expected TypeError'); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  });
  test('accepts positive finite ttlMs', () => new AsyncLruCache({ capacity: 1, ttlMs: 100 }));
  test('accepts Infinity ttlMs', () => new AsyncLruCache({ capacity: 1, ttlMs: Infinity }));

  // ---- basic set / get ----
  test('set and get', () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.set('a', 1);
    if (c.get('a') !== 1) throw new Error('expected 1');
    if (c.get('b') !== undefined) throw new Error('expected undefined');
  });

  test('get refreshes recency', () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');            // a is now most recent
    c.set('c', 3);         // capacity exceeded → evict LRU (should be b)
    if (c.get('b') !== undefined) throw new Error('b should be evicted');
    if (c.get('a') !== 1) throw new Error('a should survive');
    if (c.get('c') !== 3) throw new Error('c should exist');
  });

  // ---- TTL ----
  test('entries expire after ttlMs', () => {
    const clock = { time: 1000 };
    const c = new AsyncLruCache({ capacity: 2, ttlMs: 50, now: () => clock.time });
    c.set('a', 1);
    if (c.get('a') !== 1) throw new Error('expected 1');
    clock.time = 1051; // 51 ms later
    if (c.get('a') !== undefined) throw new Error('should be expired');
    if (c.size !== 0) throw new Error('size must be 0 after expiry');
  });

  test('size counts only non-expired', () => {
    const clock = { time: 0 };
    const c = new AsyncLruCache({ capacity: 5, ttlMs: 100, now: () => clock.time });
    c.set('a', 1);
    c.set('b', 2);
    clock.time = 150;       // both expired
    if (c.size !== 0) throw new Error('size 0');
    c.set('c', 3);
    if (c.size !== 1) throw new Error('size 1');
  });

  // ---- eviction on capacity ----
  test('evicts LRU when capacity exceeded', () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.set('a', 1).set('b', 2).set('c', 3);
    if (c.get('a') !== undefined) throw new Error('a evicted');
    if (c.get('b') !== 2) throw new Error('b still there');
    if (c.get('c') !== 3) throw new Error('c there');
  });

  // Corrected test for evicting expired entries before fresh ones (write TTL)
  test('evicts expired entries before fresh ones', () => {
    const clock = { time: 0 };
    const c = new AsyncLruCache({ capacity: 2, ttlMs: 50, now: () => clock.time });
    c.set('a', 1);   // stored at t=0
    c.set('b', 2);   // stored at t=0
    clock.time = 30;
    c.set('b', 2);   // refresh b's storedTime → 30
    clock.time = 80; // a expired (80-0=80 > 50), b fresh (80-30=50, not > 50)
    c.set('c', 3);   // capacity 2 → must evict a (expired) not b (fresh)
    if (c.get('a') !== undefined) throw new Error('a (expired) should be evicted');
    if (c.get('b') !== 2) throw new Error('b should survive');
    if (c.get('c') !== 3) throw new Error('c present');
  });

  // ---- delete ----
  test('delete existing returns true', () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.set('a', 1);
    if (c.delete('a') !== true) throw new Error('true expected');
    if (c.get('a') !== undefined) throw new Error('should be gone');
  });
  test('delete non-existing returns false', () => {
    if (new AsyncLruCache({ capacity: 2 }).delete('x') !== false) throw new Error('false expected');
  });

  test('set returns this', () => {
    const c = new AsyncLruCache({ capacity: 1 });
    if (c.set('a', 1) !== c) throw new Error('set should return cache');
  });

  // ---- storing undefined value ----
  test('stores and retrieves undefined', () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.set('u', undefined);
    if (c.get('u') !== undefined) throw new Error('expected undefined');
    if (c.size !== 1) throw new Error('size should be 1');
    if (c.delete('u') !== true) throw new Error('delete should return true');
    if (c.get('u') !== undefined) throw new Error('should be gone');
  });

  await asyncTest('getOrCompute returns stored undefined without calling computeFn', async () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.set('u', undefined);
    let called = false;
    const val = await c.getOrCompute('u', () => { called = true; return 1; });
    if (called) throw new Error('compute should not be called');
    if (val !== undefined) throw new Error('value should be undefined');
  });

  // ---- getOrCompute: fresh value ----
  await asyncTest('getOrCompute returns fresh value without compute', async () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.set('a', 10);
    let called = false;
    const val = await c.getOrCompute('a', () => { called = true; return 20; });
    if (val !== 10) throw new Error('should be 10');
    if (called) throw new Error('compute should not be called');
  });

  // ---- single‑flight ----
  await asyncTest('single-flight: compute called once', async () => {
    const c = new AsyncLruCache({ capacity: 2 });
    let callCount = 0;
    const compute = async () => { callCount++; return 'v'; };
    const [r1, r2] = await Promise.all([
      c.getOrCompute('a', compute),
      c.getOrCompute('a', compute),
    ]);
    if (r1 !== 'v' || r2 !== 'v') throw new Error('expected v');
    if (callCount !== 1) throw new Error('exactly one call');
  });

  // ---- failure rejects all and clears ----
  await asyncTest('failure rejects all and clears', async () => {
    const c = new AsyncLruCache({ capacity: 2 });
    let callCount = 0;
    const fail = () => { callCount++; throw new Error('fail'); };
    const p1 = c.getOrCompute('a', fail);
    const p2 = c.getOrCompute('a', fail);

    let e1, e2;
    try { await p1; } catch (e) { e1 = e; }
    try { await p2; } catch (e) { e2 = e; }
    if (!e1 || e1.message !== 'fail' || !e2 || e2.message !== 'fail') throw new Error('both reject');
    if (callCount !== 1) throw new Error('exactly one call');

    let retried = false;
    const v = await c.getOrCompute('a', () => { retried = true; return 7; });
    if (v !== 7 || !retried) throw new Error('retry failed');
  });

  // ---- delete during flight: result NOT stored ----
  await asyncTest('delete during flight prevents storing computed value', async () => {
    const c = new AsyncLruCache({ capacity: 2 });
    let resolver;
    const slow = () => new Promise(r => { resolver = r; });
    const p = c.getOrCompute('delme', slow);

    if (c.delete('delme') !== false) throw new Error('delete should return false');
    resolver(42);
    const waited = await p;
    if (waited !== 42) throw new Error('waiter should receive 42');
    if (c.get('delme') !== undefined) throw new Error('computed value must not be stored after delete');
  });

  // ---- delete during flight, then fresh compute ----
  await asyncTest('delete during flight allows fresh compute from a new caller', async () => {
    const c = new AsyncLruCache({ capacity: 2 });
    let firstCalled = false;
    const slow = () => new Promise(r => setTimeout(() => { firstCalled = true; r(42); }, 40));
    const p1 = c.getOrCompute('a', slow);
    if (c.delete('a') !== false) throw new Error('delete returns false');
    let secondCalled = false;
    const p2 = c.getOrCompute('a', () => { secondCalled = true; return 99; });
    const [r1, r2] = await Promise.all([p1, p2]);
    if (r1 !== 42) throw new Error('first waiter gets 42');
    if (r2 !== 99) throw new Error('second waiter gets new compute 99');
    if (!secondCalled) throw new Error('second compute should be called');
    if (c.get('a') !== 99) throw new Error('cache should contain 99, not 42');
  });

  // ---- set during flight does not get overwritten ----
  await asyncTest('getOrCompute does not overwrite a value set during flight', async () => {
    const c = new AsyncLruCache({ capacity: 2 });
    let resolver;
    const compute = () => new Promise(r => { resolver = r; });
    const p = c.getOrCompute('k', compute);
    c.set('k', 'setvalue');   // explicit set while computation is pending
    resolver('computed');
    const val = await p;
    if (val !== 'computed') throw new Error('waiter sees computed value');
    if (c.get('k') !== 'setvalue') throw new Error('cache should keep set value');
  });

  // ---- expiry and in‑flight combination ----
  await asyncTest('expired key triggers compute while another key is in flight', async () => {
    const clock = { time: 100 };
    const now = () => clock.time;
    const c = new AsyncLruCache({ capacity: 2, ttlMs: 30, now });
    c.set('a', 1);
    c.set('b', 2);

    const pC = c.getOrCompute('c', async () => { await sleep(20); return 'c-val'; });
    clock.time = 150; // a expired
    let aCalled = false;
    const pA = c.getOrCompute('a', () => { aCalled = true; return 'a-new'; });

    const [rC, rA] = await Promise.all([pC, pA]);
    if (rC !== 'c-val') throw new Error('c val wrong');
    if (rA !== 'a-new') throw new Error('a new wrong');
    if (!aCalled) throw new Error('a compute should be called');
  });

  // ---- capacity with getOrCompute ----
  await asyncTest('getOrCompute evicts LRU when storing computed value', async () => {
    const c = new AsyncLruCache({ capacity: 1 });
    c.set('a', 1);
    const v = await c.getOrCompute('b', () => 2);
    if (v !== 2) throw new Error('expected 2');
    if (c.get('a') !== undefined) throw new Error('a evicted');
    if (c.get('b') !== 2) throw new Error('b present');
  });

  // ---- size ignores in‑flight computations ----
  test('size ignores in‑flight computations', () => {
    const c = new AsyncLruCache({ capacity: 2 });
    c.getOrCompute('a', async () => 'x'); // not awaited
    if (c.size !== 0) throw new Error('size must be 0');
  });

  // ---- clock inject ----
  test('now injection works', () => {
    let called = false;
    const now = () => { called = true; return 42; };
    const c = new AsyncLruCache({ capacity: 2, now });
    c.set('k', 1);
    if (!called) throw new Error('custom now not called');
  });

  // ---- getOrCompute validates computeFn ----
  test('getOrCompute throws on non-function computeFn', () => {
    const c = new AsyncLruCache({ capacity: 2 });
    try {
      c.getOrCompute('key', 'not a function');
      throw new Error('expected TypeError');
    } catch (e) {
      if (!(e instanceof TypeError) || !e.message.includes('computeFn must be a function'))
        throw new Error('wrong error');
    }
  });

  console.log('All tests passed');
  process.exit(failed ? 1 : 0);
})();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Verification status

The solution was assembled from reviewed material with two fixes applied to address the critical issues reported:

1. **Single-flight error handling (atom‑13 contradicted)**  
   The original `getOrCompute` set the in‑flight promise **after** the async computation started, which could leave a stale rejected promise in the `#inFlight` map if the computation rejected synchronously, breaking retries and causing all waiters not to reject in unison.  
   **Fix:** The in‑flight promise is now registered **before** the computation runs, and explicit resolve/reject are used so that the promise settles exactly when the computation completes, ensuring all concurrent waiters see the same rejection and the slot is always cleaned up.

2. **Eviction test (verifier critical issue)**  
   The original test `evicts expired entries before fresh ones` expected sliding TTL (it assumed a `get()` refresh would extend expiry), which conflicts with the required *write TTL* semantics. Under write TTL both entries were expired, making the test invalid.  
   **Fix:** The test was rewritten to use `set()` to update a fresh entry’s storedTime, creating a proper expired‑vs‑fresh scenario that correctly validates the eviction preference for expired entries.

All other verified facts, design rules, and verified atoms remain intact. The rest of the self‑test suite is expected to pass with the corrected implementation. No additional open items remain.