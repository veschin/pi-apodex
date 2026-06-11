```js solution
// --- default sleep (used as fallback) ---
const defaultSleep = (ms, signal) => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    let timeoutId;
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    timeoutId = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      // re‑check immediately after listener registration to prevent a race
      if (signal.aborted) {
        signal.removeEventListener('abort', onAbort);
        clearTimeout(timeoutId);
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      }
    }
  });
};

// --- internal helpers ---
function validateNonNegativeFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`"${name}" must be a non-negative finite number`);
  }
}

/**
 * Async retry helper with exponential backoff.
 *
 * @param {function} fn - (attemptIndex: number) => Promise<any>
 * @param {object} [options]
 * @param {number} [options.retries=3] - number of retries AFTER the first attempt
 * @param {number} [options.baseDelayMs=100] - start backoff
 * @param {number} [options.maxDelayMs=30000] - cap for delay
 * @param {function} [options.retryOn] - (error) => boolean; default retries all
 * @param {AbortSignal} [options.signal]
 * @param {function} [options.sleep] - injectable (ms, signal) => Promise<void>
 * @returns {Promise<any>}
 */
export function retry(fn, options) {
  // ------ synchronous input validation ------
  if (typeof fn !== 'function') {
    throw new TypeError('The "fn" argument must be a function');
  }
  if (options !== undefined && options !== null && typeof options !== 'object') {
    throw new TypeError('The "options" argument must be an object if provided');
  }

  const opts = options ?? {};
  const {
    retries: maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 30000,
    retryOn = () => true,
    signal,
    sleep = defaultSleep,
  } = opts;

  validateNonNegativeFiniteNumber('retries', maxRetries);
  validateNonNegativeFiniteNumber('baseDelayMs', baseDelayMs);
  validateNonNegativeFiniteNumber('maxDelayMs', maxDelayMs);

  if (opts.retryOn !== undefined && typeof retryOn !== 'function') {
    throw new TypeError('"retryOn" must be a function');
  }

  // signal must be undefined/null or a valid AbortSignal‑like object
  if (signal !== undefined && signal !== null) {
    if (
      typeof signal !== 'object' ||
      signal === null ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.aborted !== 'boolean'
    ) {
      throw new TypeError('"signal" must be an AbortSignal');
    }
  }

  // ------ internal retry loop ------
  return (async () => {
    const errors = [];
    const maxAttempts = maxRetries + 1; // total attempts = retries + 1

    for (let i = 0; i < maxAttempts; i++) {
      if (signal?.aborted) break;

      try {
        const result = await fn(i);
        return result; // success
      } catch (attemptErr) {
        errors.push(attemptErr);

        // abort takes precedence over any retry logic
        if (signal?.aborted) break;

        // exhausted all attempts?
        if (i >= maxRetries) break;

        // should we retry? predicate throw → non‑retryable
        let shouldRetry = false;
        try {
          shouldRetry = retryOn(attemptErr);
        } catch {
          break;
        }
        if (!shouldRetry) break;

        // compute backoff delay (k is 1‑based retry index)
        const k = i + 1;
        const delay = Math.min(baseDelayMs * 2 ** (k - 1), maxDelayMs);

        try {
          await sleep(delay, signal);
        } catch (sleepErr) {
          // if abort caused the rejection, stop
          if (signal?.aborted) break;
          // unexpected sleep failure – stop, do NOT add to attempt errors
          break;
        }
      }
    }

    // abort reason has top priority
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }

    throw new AggregateError(errors, `All ${errors.length} attempt(s) failed`);
  })();
}
```

```js selftest
import { retry } from './solution.mjs';
import { strict as assert } from 'node:assert';

// --------------------------------------------------------------------
// Fail on unhandled rejections / uncaught exceptions
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

// --------------------------------------------------------------------
// Minimal test runner
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}
function fail(msg, actual, expected) {
  console.error(`  FAIL: ${msg}`);
  console.error(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  failed++;
}

async function runTests() {
  for (const t of tests) {
    console.log(`\n${t.name}`);
    try {
      await t.fn();
    } catch (e) {
      console.error(`  UNEXPECTED ERROR:`, e);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// --------------------------------------------------------------------
// Helper assertions
function assertEqual(actual, expected, msg) {
  try {
    assert.strictEqual(actual, expected, msg);
    pass(msg);
  } catch (e) {
    fail(msg, actual, expected);
  }
}

function assertOk(condition, msg) {
  try {
    assert.ok(condition, msg);
    pass(msg);
  } catch (e) {
    fail(msg, false, true);
  }
}

function assertThrows(fn, expectedError, msg) {
  try {
    fn();
    fail(msg, 'no throw', expectedError);
  } catch (e) {
    let matches = false;
    if (expectedError instanceof RegExp) {
      matches = expectedError.test(e.message);
    } else if (expectedError && e.name === expectedError.name) {
      matches = true;
    }
    if (matches) {
      pass(msg);
    } else {
      fail(msg, e, expectedError);
    }
  }
}

// ====================================================================
// 1. Synchronous input validation
// ====================================================================
test('fn must be a function', () => {
  assertThrows(() => retry(42), /fn.*function/, 'throws for non-function fn');
  assertThrows(() => retry(null), /fn.*function/, 'throws for null');
});

test('options must be an object if provided', () => {
  assertThrows(() => retry(() => {}, 'string'), /options/, 'throws for string options');
  assertThrows(() => retry(() => {}, 123), /options/, 'throws for number options');
  assert.doesNotThrow(() => retry(() => {}), 'no options OK');
  assert.doesNotThrow(() => retry(() => {}, undefined), 'undefined options OK');
  assert.doesNotThrow(() => retry(() => {}, null), 'null options OK');
  pass('options type check');
});

test('numeric options validate non‑negative finite', () => {
  assertThrows(() => retry(() => {}, { retries: -1 }), /retries/, 'negative retries');
  assertThrows(() => retry(() => {}, { retries: NaN }), /retries/, 'NaN retries');
  assertThrows(() => retry(() => {}, { retries: Infinity }), /retries/, 'Infinity retries');
  assertThrows(() => retry(() => {}, { baseDelayMs: -100 }), /baseDelayMs/, 'negative baseDelayMs');
  assertThrows(() => retry(() => {}, { baseDelayMs: NaN }), /baseDelayMs/, 'NaN baseDelayMs');
  assertThrows(() => retry(() => {}, { maxDelayMs: NaN }), /maxDelayMs/, 'NaN maxDelayMs');
  assert.doesNotThrow(() => retry(() => {}, { retries: 0 }), 'retries = 0 is fine');
  assert.doesNotThrow(() => retry(() => {}, { baseDelayMs: 0 }), 'baseDelayMs = 0 is fine');
  pass('numeric validation');
});

test('retryOn must be a function if given', () => {
  assertThrows(() => retry(() => {}, { retryOn: 123 }), /retryOn/, 'non‑function retryOn');
  assertThrows(() => retry(() => {}, { retryOn: 'yes' }), /retryOn/, 'string retryOn');
  assert.doesNotThrow(() => retry(() => {}, { retryOn: () => false }), 'function is fine');
  pass('retryOn type check');
});

test('signal must be AbortSignal‑like', () => {
  assert.doesNotThrow(() => retry(() => {}, { signal: undefined }), 'undefined signal OK');
  assert.doesNotThrow(() => retry(() => {}, { signal: null }), 'null signal OK');
  assertThrows(() => retry(() => {}, { signal: 42 }), /signal/, 'number signal');
  assertThrows(() => retry(() => {}, { signal: 'x' }), /signal/, 'string signal');
  assertThrows(() => retry(() => {}, { signal: { aborted: false } }), /signal/, 'missing addEventListener');
  assertThrows(() => retry(() => {}, { signal: { addEventListener() {} } }), /signal/, 'missing aborted');
  pass('signal validation');
});

// ====================================================================
// 2. Success / exhaustion
// ====================================================================
test('succeeds on first attempt', async () => {
  const v = await retry((i) => {
    assertEqual(i, 0, 'attempt index = 0');
    return 'ok';
  });
  assertEqual(v, 'ok', 'resolves with fn value');
});

test('succeeds after retries', async () => {
  let calls = 0;
  const v = await retry(() => {
    calls++;
    if (calls < 3) throw new Error('fail');
    return 'done';
  }, { retries: 5 });
  assertEqual(v, 'done', 'resolves correctly');
  assertEqual(calls, 3, 'exactly 3 calls');
});

test('exhausted retries rejects with AggregateError containing all attempt errors', async () => {
  const errors = [new Error('a'), new Error('b'), new Error('c'), new Error('d')];
  let idx = 0;
  try {
    await retry(() => Promise.reject(errors[idx++]), { retries: 3 }); // 4 attempts
    assertOk(false, 'should have rejected');
  } catch (e) {
    assertOk(e instanceof AggregateError, 'AggregateError');
    assertEqual(e.errors.length, 4, '4 errors in array');
    assertEqual(e.errors[0], errors[0], 'first error correct');
    assertEqual(e.errors[3], errors[3], 'last error correct');
    assertOk(e.message.includes('4 attempt'), 'message mentions attempt count');
  }
});

test('retries=0: single attempt, AggregateError on failure', async () => {
  const err = new Error('boom');
  try {
    await retry(() => Promise.reject(err), { retries: 0 });
    assertOk(false, 'should reject');
  } catch (e) {
    assertOk(e instanceof AggregateError, 'AggregateError');
    assertEqual(e.errors.length, 1, 'one error');
    assertEqual(e.errors[0], err, 'the error is the thrown one');
  }
});

// ====================================================================
// 3. retryOn filtering
// ====================================================================
test('retryOn returns false stops retries', async () => {
  let calls = 0;
  const fatal = new Error('fatal');
  try {
    await retry(
      () => { calls++; throw fatal; },
      { retries: 5, retryOn: (e) => e !== fatal }
    );
    assertOk(false, 'should reject');
  } catch (e) {
    assertOk(e instanceof AggregateError, 'AggregateError');
    assertEqual(e.errors.length, 1, 'one error');
    assertEqual(e.errors[0], fatal, 'the fatal error');
    assertEqual(calls, 1, 'only one attempt made');
  }
});

test('retryOn returns true allows retry', async () => {
  let calls = 0;
  const v = await retry(
    () => { calls++; if (calls < 3) throw new Error('retry'); return 'ok'; },
    { retries: 5, retryOn: () => true }
  );
  assertEqual(v, 'ok', 'eventual success');
  assertEqual(calls, 3, '3 attempts');
});

test('retryOn throws → stop, AggregateError contains only attempt error', async () => {
  const attErr = new Error('attempt fail');
  let predicateCalled = false;
  try {
    await retry(
      () => { throw attErr; },
      {
        retries: 2,
        retryOn: () => { predicateCalled = true; throw new Error('predicate explosion'); }
      }
    );
    assertOk(false, 'should reject');
  } catch (e) {
    assertOk(predicateCalled, 'retryOn was invoked');
    assertOk(e instanceof AggregateError, 'AggregateError');
    assertEqual(e.errors.length, 1, 'only the attempt error');
    assertEqual(e.errors[0], attErr, 'predicate error not present');
  }
});

// ====================================================================
// 4. Backoff calculation (via injectable sleep)
// ====================================================================
test('exponential backoff delays (no jitter)', async () => {
  const delays = [];
  const mockSleep = (ms) => { delays.push(ms); return Promise.resolve(); };
  try {
    await retry(() => Promise.reject(new Error()), { retries: 5, baseDelayMs: 100, maxDelayMs: 1000, sleep: mockSleep });
  } catch (_) { /* expected */ }
  assertEqual(delays.length, 5, '5 delays');
  const expected = [100, 200, 400, 800, 1000];
  expected.forEach((exp, idx) => assertEqual(delays[idx], exp, `delay ${idx + 1} is ${exp}ms`));
});

test('delay capping respects maxDelayMs', async () => {
  const delays = [];
  const mockSleep = (ms) => { delays.push(ms); return Promise.resolve(); };
  try {
    await retry(() => Promise.reject(new Error()), { retries: 2, baseDelayMs: 1000, maxDelayMs: 1500, sleep: mockSleep });
  } catch (_) {}
  assertEqual(delays.length, 2, 'two delays');
  assertEqual(delays[0], 1000, 'first = base');
  assertEqual(delays[1], 1500, 'second capped');
});

// ====================================================================
// 5. Abort behaviour
// ====================================================================
test('already aborted signal rejects immediately (fn never called)', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let called = false;
  const p = retry(() => { called = true; return 'x'; }, { signal: ctrl.signal });
  try {
    await p;
    assertOk(false, 'should reject');
  } catch (e) {
    assertOk(e instanceof DOMException, 'DOMException');
    assertEqual(e.name, 'AbortError', 'AbortError name');
    assertOk(!called, 'fn never called');
  }
});

test('abort during backoff wait interrupts and rejects with reason', async () => {
  const ctrl = new AbortController();
  const reason = new Error('custom');
  let attempts = 0;
  const p = retry(
    () => { attempts++; throw new Error('fail'); },
    { retries: 3, baseDelayMs: 500, signal: ctrl.signal }
  );
  setTimeout(() => ctrl.abort(reason), 20);
  const start = Date.now();
  try {
    await p;
    assertOk(false, 'should reject');
  } catch (e) {
    const elapsed = Date.now() - start;
    assertOk(elapsed < 200, `abort interrupted quickly (${elapsed}ms)`);
    assertEqual(attempts, 1, 'only one attempt');
    assertEqual(e, reason, 'rejects with the custom reason');
  }
});

test('abort with no reason yields DOMException AbortError', async () => {
  const ctrl = new AbortController();
  const p = retry(
    () => { throw new Error('fail'); },
    { retries: 1, baseDelayMs: 1000, signal: ctrl.signal }
  );
  setTimeout(() => ctrl.abort(), 10);
  try {
    await p;
    assertOk(false, 'should reject');
  } catch (e) {
    assertOk(e instanceof DOMException, 'DOMException');
    assertEqual(e.name, 'AbortError', 'name AbortError');
  }
});

test('abort after a failed attempt (but before retry) rejects with abort reason', async () => {
  const ctrl = new AbortController();
  const reason = new Error('abort reason');
  let calls = 0;
  // fn will reject after a small delay; we abort before it rejects
  const p = retry(
    () => {
      calls++;
      return new Promise((_, reject) => setTimeout(() => reject(new Error('delayed fail')), 30));
    },
    { retries: 2, signal: ctrl.signal }
  );
  setTimeout(() => ctrl.abort(reason), 5);
  try {
    await p;
    assertOk(false, 'should reject');
  } catch (e) {
    assertEqual(calls, 1, 'first attempt started');
    assertEqual(e, reason, 'rejects with abort reason, not AggregateError');
  }
});

test('abort after success does not interfere', async () => {
  const ctrl = new AbortController();
  const v = await retry(() => 'success', { signal: ctrl.signal });
  assertEqual(v, 'success', 'resolves before abort');
  ctrl.abort(); // no effect
});

test('signal is passed to custom sleep', async () => {
  let receivedSignal;
  const ctrl = new AbortController();
  const mockSleep = (ms, sig) => { receivedSignal = sig; return Promise.resolve(); };
  try {
    await retry(() => { throw new Error(); }, { retries: 1, sleep: mockSleep, signal: ctrl.signal });
  } catch (_) {}
  assertEqual(receivedSignal, ctrl.signal, 'sleep receives the signal');
});

// ====================================================================
// 6. Unexpected sleep failure
// ====================================================================
test('unexpected sleep failure stops retries and rejects with AggregateError of attempt errors', async () => {
  const attemptErr = new Error('attempt error');
  const sleepErr = new Error('sleep bug');
  try {
    await retry(
      () => Promise.reject(attemptErr),
      { retries: 1, sleep: () => Promise.reject(sleepErr) }
    );
    assertOk(false, 'should reject');
  } catch (e) {
    assertOk(e instanceof AggregateError, 'AggregateError');
    assertEqual(e.errors.length, 1, 'only one error (the attempt)');
    assertEqual(e.errors[0], attemptErr, 'contains attempt error');
    assertOk(!e.errors.includes(sleepErr), 'sleep error is NOT included');
  }
});

// ====================================================================
await runTests();
```

---

**Approach & reasoning**

The implementation is a regular (non‑async) function so that input validation throws synchronously as required. Every trust boundary is guarded:

- `fn` must be a function.
- `options`, if provided, must be an object.
- Numeric parameters (`retries`, `baseDelayMs`, `maxDelayMs`) must be finite numbers ≥ 0.
- `retryOn`, if given, must be a function.
- `signal` must be `undefined`, `null`, or an object with `addEventListener` and a boolean `aborted` property.

**Retry loop**

- The loop runs `maxRetries + 1` times, with `attemptIndex` starting at `0`.
- Before every attempt the abort flag is checked, and right after an attempt’s failure we immediately check whether the signal was aborted – this ensures abort takes priority over retry logic.
- If `fn` succeeds, the promise resolves with its return value.
- On failure, the error is pushed into an array.
- If all attempts are exhausted, or `retryOn` returns `false`, or `retryOn` itself throws, the loop stops and later throws an `AggregateError` containing **only the attempt errors** in order. The message mentions the number of attempts.
- Backoff delay before the *k*‑th retry (1‑based) is `min(baseDelayMs * 2**(k‑1), maxDelayMs)`. No jitter.

**Abort handling**

- The injected `sleep` function receives the signal and is expected to reject if aborted.
- After a `sleep` rejection, if the signal is aborted the loop stops and later throws the abort reason (or a `DOMException` `"AbortError"` if no reason).
- If an unexpected sleep failure occurs (not caused by abort), the loop stops but the sleep error is **not** added to the attempt errors – it merely stops further retries. The final rejection is an `AggregateError` with the collected attempt errors.

**Default `sleep` race**

The default timer checks `signal?.aborted` at entry, then sets a `setTimeout`, adds an `abort` listener, and *re‑checks* `signal.aborted` immediately after listener registration. If `abort()` was called between the initial check and the listener attachment, the re‑check catches it and rejects without waiting for the timeout. This eliminates the narrow race window.

**Edge cases covered**

- `retries = 0` → exactly one attempt; failure produces a single‑element `AggregateError`.
- Already‑aborted signal → rejects with abort reason, function never called.
- Abort during a running attempt → when the attempt finally throws, the abort flag is detected and the promise rejects with the abort reason, discarding any attempt error.
- Abort during a backoff wait → `sleep` rejects, loop stops, abort reason thrown.
- `retryOn` throws → treated as non‑retryable; only the attempt error is preserved.
- Unexpected sleep failure → stops retries without polluting the `errors` array.

**Critique rebuttals**

The critique correctly pointed out that the previous version incorrectly included unexpected sleep failures in the `AggregateError.errors` array. The revised implementation no longer does so – sleep errors cause the loop to stop, and the final rejection contains only the actual attempt errors, exactly as the specification demands. The self‑test verifies this with a dedicated case.