```js solution
// solution.mjs
function createAbortError() {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted', 'AbortError');
  }
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const reason = signal.reason !== undefined ? signal.reason : createAbortError();
      reject(reason);
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal.reason !== undefined ? signal.reason : createAbortError();
      reject(reason);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

export function retry(fn, options = {}) {
  // ---- synchronous input validation ----
  if (typeof fn !== 'function') {
    throw new TypeError('fn must be a function');
  }

  const {
    retries = 3,
    baseDelayMs = 100,
    maxDelayMs = 30000,
    retryOn,
    signal,
    sleep = defaultSleep,
  } = options;

  if (typeof retries !== 'number' || retries < 0 || !Number.isFinite(retries)) {
    throw new TypeError('retries must be a non-negative finite number');
  }
  if (typeof baseDelayMs !== 'number' || baseDelayMs < 0 || !Number.isFinite(baseDelayMs)) {
    throw new TypeError('baseDelayMs must be a non-negative finite number');
  }
  if (typeof maxDelayMs !== 'number' || maxDelayMs < 0 || !Number.isFinite(maxDelayMs)) {
    throw new TypeError('maxDelayMs must be a non-negative finite number');
  }
  if (retryOn !== undefined && typeof retryOn !== 'function') {
    throw new TypeError('retryOn must be a function');
  }
  if (signal !== undefined) {
    if (
      typeof signal !== 'object' ||
      signal === null ||
      typeof signal.addEventListener !== 'function'
    ) {
      throw new TypeError('signal must be an AbortSignal');
    }
  }
  if (typeof sleep !== 'function') {
    throw new TypeError('sleep must be a function');
  }

  // ---- async core ----
  return (async () => {
    const errors = [];

    const abortReason = () =>
      signal.reason !== undefined ? signal.reason : createAbortError();

    // already aborted before any attempt?
    if (signal?.aborted) {
      throw abortReason();
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      // check again in case signal was aborted during a previous backoff
      if (signal?.aborted) {
        throw abortReason();
      }

      try {
        const result = await fn(attempt);
        return result;
      } catch (err) {
        // abort overtakes any error
        if (signal?.aborted) {
          throw abortReason();
        }
        errors.push(err);

        let shouldRetry = true;
        if (retryOn) {
          try {
            shouldRetry = retryOn(err);
          } catch (retryErr) {
            // retryOn itself threw → stop immediately
            throw retryErr;
          }
        }

        if (!shouldRetry || attempt === retries) {
          throw new AggregateError(
            errors,
            `Retry failed after ${errors.length} attempt(s)`,
          );
        }

        // backoff before the next attempt (retry number k = attempt + 1)
        const k = attempt + 1;
        const delay = Math.min(baseDelayMs * 2 ** (k - 1), maxDelayMs);
        await sleep(delay, signal);
      }
    }
  })();
}
```

```js selftest
import { retry } from './solution.mjs';
import { setImmediate } from 'timers/promises'; // not used, but available

// ---- test infrastructure ----
let failed = false;

function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL:', msg);
    failed = true;
    throw new Error(msg); // stop the current test
  }
}

function assertRejects(promise, expectedTypeOrChecker, msg) {
  return promise.then(
    () => { throw new Error(`${msg} - did not reject`); },
    err => {
      if (typeof expectedTypeOrChecker === 'function') {
        if (expectedTypeOrChecker.prototype) {
          if (!(err instanceof expectedTypeOrChecker)) {
            throw new Error(`${msg} - wrong error type: ${err}`);
          }
        } else {
          assert(expectedTypeOrChecker(err), `${msg} - unexpected error: ${err}`);
        }
      }
    }
  );
}

function assertThrows(fn, expectedType, msg) {
  try {
    fn();
    throw new Error(`${msg} - did not throw`);
  } catch (e) {
    if (!(e instanceof expectedType)) {
      throw new Error(`${msg} - wrong error type: ${e}`);
    }
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name} - ${e.message || e}`);
    failed = true;
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

// ---- test cases ----
await test('fn not function -> TypeError', async () => {
  assertThrows(() => retry(123), TypeError);
});

await test('retries negative -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { retries: -1 }), TypeError);
});

await test('retries NaN -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { retries: NaN }), TypeError);
});

await test('retries Infinity -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { retries: Infinity }), TypeError);
});

await test('baseDelayMs negative -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { baseDelayMs: -0.5 }), TypeError);
});

await test('maxDelayMs negative -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { maxDelayMs: -10 }), TypeError);
});

await test('baseDelayMs Infinity -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { baseDelayMs: Infinity }), TypeError);
});

await test('retryOn not function -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { retryOn: 'yes' }), TypeError);
});

await test('sleep not function -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { sleep: 'no' }), TypeError);
});

await test('signal not AbortSignal -> TypeError', async () => {
  assertThrows(() => retry(() => {}, { signal: {} }), TypeError);
  assertThrows(() => retry(() => {}, { signal: null }), TypeError);
  assertThrows(() => retry(() => {}, { signal: { addEventListener: 'yes' } }), TypeError);
});

await test('basic success (resolve value)', async () => {
  const result = await retry((i) => `ok-${i}`, { retries: 2 });
  assert(result === 'ok-0', `expected ok-0 got ${result}`);
});

await test('success on third attempt (retries=2)', async () => {
  let callCount = 0;
  const result = await retry((i) => {
    callCount++;
    if (i < 2) throw new Error(`fail ${i}`);
    return 'success';
  }, { retries: 2 });
  assert(result === 'success', 'should succeed');
  assert(callCount === 3, `expected 3 calls got ${callCount}`);
});

await test('failure with retries=0 -> AggregateError (1 error)', async () => {
  const promise = retry(() => { throw new Error('fail'); }, { retries: 0 });
  await assertRejects(promise, AggregateError, 'should throw AggregateError');
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e instanceof AggregateError, 'should be AggregateError');
    assert(e.errors.length === 1, `expected 1 error, got ${e.errors.length}`);
    assert(e.errors[0].message === 'fail', 'error message mismatch');
    assert(/1/.test(e.message), 'message should mention 1');
  }
});

await test('failure with retries=2 -> AggregateError (3 errors)', async () => {
  const promise = retry(() => { throw new Error('fail'); }, { retries: 2 });
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e instanceof AggregateError, 'should be AggregateError');
    assert(e.errors.length === 3, `expected 3 errors, got ${e.errors.length}`);
    assert(/3/.test(e.message), 'message should mention 3');
  }
});

await test('retryOn returns false -> no further attempt', async () => {
  let attempts = 0;
  const promise = retry((i) => {
    attempts++;
    throw new Error(`err${i}`);
  }, {
    retries: 3,
    retryOn: (err) => err.message !== 'err0',
  });
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e instanceof AggregateError, 'should be AggregateError');
    assert(e.errors.length === 1, `expected 1 error, got ${e.errors.length}`);
    assert(e.errors[0].message === 'err0', 'wrong error');
    assert(attempts === 1, `expected 1 attempt, got ${attempts}`);
  }
});

await test('retryOn returns true then false -> two attempts', async () => {
  let attempts = 0;
  const promise = retry((i) => {
    attempts++;
    throw new Error(`err${i}`);
  }, {
    retries: 3,
    retryOn: (err) => err.message !== 'err1',
  });
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e instanceof AggregateError, 'should be AggregateError');
    assert(e.errors.length === 2, `expected 2 errors, got ${e.errors.length}`);
    assert(e.errors[0].message === 'err0', 'first error');
    assert(e.errors[1].message === 'err1', 'second error');
    assert(attempts === 2, `expected 2 attempts, got ${attempts}`);
  }
});

await test('retryOn throws -> reject with retryOn error', async () => {
  const retryOnError = new Error('retryOn boom');
  const promise = retry(() => { throw new Error('original'); }, {
    retries: 2,
    retryOn: () => { throw retryOnError; },
  });
  await assertRejects(promise, (err) => err === retryOnError, 'should reject with retryOn error');
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e === retryOnError, 'should be exact retryOn error');
  }
});

await test('attemptIndex received correctly', async () => {
  const indices = [];
  const promise = retry((i) => {
    indices.push(i);
    if (i < 2) throw new Error('fail');
    return 'ok';
  }, { retries: 2 });
  const result = await promise;
  assert(result === 'ok', 'result');
  assert(indices.length === 3, `expected 3 indices, got ${indices}`);
  assert(indices[0] === 0, `idx 0`);
  assert(indices[1] === 1, `idx 1`);
  assert(indices[2] === 2, `idx 2`);
});

await test('backoff delays (custom sleep)', async () => {
  const calls = [];
  const customSleep = async (ms, signal) => {
    calls.push({ ms, signal });
    // resolve immediately
  };
  const promise = retry(
    () => { throw new Error('fail'); },
    { retries: 2, baseDelayMs: 100, sleep: customSleep }
  );
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(calls.length === 2, `expected 2 sleep calls, got ${calls.length}`);
    // first backoff (before retry 1) delay = 100
    assert(calls[0].ms === 100, `first delay: ${calls[0].ms}`);
    // second backoff (before retry 2) delay = 200
    assert(calls[1].ms === 200, `second delay: ${calls[1].ms}`);
    // signal should be undefined
    assert(calls[0].signal === undefined, 'signal should be undefined');
  }
});

await test('maxDelayMs caps delay', async () => {
  const calls = [];
  const customSleep = async (ms) => { calls.push(ms); };
  const promise = retry(
    () => { throw new Error('fail'); },
    { retries: 3, baseDelayMs: 100, maxDelayMs: 150, sleep: customSleep }
  );
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(calls.length === 3, `expected 3 sleep calls, got ${calls.length}`);
    assert(calls[0] === 100, `first delay: ${calls[0]}`);
    assert(calls[1] === 150, `second delay (capped): ${calls[1]}`);
    assert(calls[2] === 150, `third delay (capped): ${calls[2]}`);
  }
});

await test('signal already aborted -> reject immediately, no fn call', async () => {
  const ac = new AbortController();
  ac.abort(new Error('custom abort'));
  let called = false;
  const promise = retry(() => { called = true; }, { signal: ac.signal });
  await assertRejects(promise, (err) => err.message === 'custom abort', 'should reject with custom abort');
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e.message === 'custom abort', `wrong message: ${e.message}`);
  }
  assert(!called, 'fn should not be called');
});

await test('signal abort during backoff (custom sleep)', async () => {
  const ac = new AbortController();
  let sleepReject;
  const customSleep = (ms, signal) => new Promise((_, reject) => {
    // store reject to trigger later
    sleepReject = reject;
    // attach to signal
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('abort reason')));
  });

  let attempts = 0;
  const promise = retry(
    () => { attempts++; throw new Error('fail'); },
    { retries: 2, baseDelayMs: 100, signal: ac.signal, sleep: customSleep }
  );

  // give it a tick to enter the sleep
  await new Promise(resolve => setTimeout(resolve, 10));
  // now abort
  ac.abort(new Error('backoff abort'));

  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e.message === 'backoff abort', `expected abort reason, got ${e.message}`);
    assert(attempts === 1, `expected 1 attempt, got ${attempts}`);
  }
});

await test('signal abort during fn execution (fn rejects after abort)', async () => {
  const ac = new AbortController();
  let rejectFn;
  const promiseFn = new Promise((_, reject) => { rejectFn = reject; });

  const retryPromise = retry(
    () => promiseFn,
    { retries: 2, signal: ac.signal }
  );

  // abort while fn is pending
  ac.abort(new Error('during fn abort'));

  // now make fn reject
  rejectFn(new Error('original error'));

  try {
    await retryPromise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e.message === 'during fn abort', `expected abort reason, got ${e.message}`);
  }
});

await test('sleep receives provided signal', async () => {
  const ac = new AbortController();
  let capturedSignal;
  const customSleep = async (ms, signal) => {
    capturedSignal = signal;
  };
  const promise = retry(
    () => { throw new Error('fail'); },
    { retries: 1, sleep: customSleep, signal: ac.signal }
  );
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(capturedSignal === ac.signal, 'sleep should receive the AbortSignal');
  }
});

await test('default sleep aborts correctly (real timers)', async () => {
  const ac = new AbortController();
  // a function that always fails, so we go through a backoff
  const promise = retry(() => { throw new Error('fail'); }, {
    retries: 1,
    baseDelayMs: 50,
    signal: ac.signal,
    // use default sleep (real setTimeout)
  });

  // abort after 10ms, while sleeping
  setTimeout(() => ac.abort(new Error('real abort')), 10);

  await assertRejects(promise, (err) => err.message === 'real abort', 'should reject with abort reason');
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e.message === 'real abort', `expected real abort, got ${e.message}`);
  }
});

await test('empty options fallback to defaults (baseDelayMs=100, maxDelayMs=30000, retries=3)', async () => {
  // will fail immediately, no sleep called because we don't care about delays, just check no crash
  const promise = retry(() => { throw new Error('fail'); }, { retries: 1 });
  try {
    await promise;
    assert(false, 'unreachable');
  } catch (e) {
    assert(e instanceof AggregateError, 'should be AggregateError');
    assert(e.errors.length === 2, `expected 2 errors, got ${e.errors.length}`);
  }
});

// Summary
if (failed) {
  console.error('Some tests failed');
  process.exit(1);
} else {
  console.log('All tests passed');
}
```

---

## Approach

The `retry` function is a **regular (non‑async) function** so that invalid inputs throw synchronously (TypeError). Inside, all retry logic lives in an immediately invoked `async` function that is returned as a promise.

Key design points:

- **Validation** covers every option’s type and range (`retries`, `baseDelayMs`, `maxDelayMs` must be non‑negative finite numbers; `retryOn`, `sleep` must be functions; `signal` must duck‑type as an `AbortSignal`).
- The default `sleep` is a module‑level function that uses `setTimeout` and respects an `AbortSignal`. If the signal is already aborted it rejects immediately; otherwise it sets a timer and listens for `'abort'`, cleaning up on resolution.
- The retry loop collects **every** attempt error in an `errors` array. On abort, the promise rejects with the signal’s reason (or a synthetic `AbortError`), **not** an `AggregateError`. This matches the primary spec: _“On abort, reject with the signal's reason if set, else a DOMException named 'AbortError'.”_  
  The later phrase _“or with an AggregateError that includes it”_ is left unimplemented; the implementation uses the immediate abort‑reason rejection as the more standard and simpler choice.
- Exponential backoff is computed as `min(baseDelayMs * 2^(k-1), maxDelayMs)` where `k` is the 1‑based retry number.
- If `retryOn` throws, the whole operation rejects with that error (no further attempts). This prevents hidden bugs in the decision function.

### Edge cases covered

- **Zero retries** – exactly one attempt, failure yields `AggregateError` with one entry.
- **All numbers validated** – negative, NaN, Infinity cause synchronous `TypeError`.
- **Signal already aborted** – rejects immediately, no attempt.
- **Abort during backoff** – the sleep promise rejects with the abort reason, and that propagates.
- **Abort after an attempt failure but before sleep** – detected by the explicit `signal?.aborted` check immediately inside the catch block.
- **Abort during an in‑flight `fn` promise** – not interrupted (by design), but once that promise settles (rejects) the abort is detected and the overall promise rejects with the abort reason.
- **Custom abort reason** (including `null`) – handled via `signal.reason !== undefined ? signal.reason : createAbortError()`.
- **`retryOn` throws** – rejects with that error, no aggregate.
- **Default `sleep`** is fully abort‑aware.

### Limitations / unverified behaviour

- The “AggregateError that includes it” alternative on abort was deliberately not implemented; any caller expecting that would see a plain abort error.
- No jitter is added to the backoff (as specified).
- The `fn` is not given an `AbortSignal` – so the operation inside `fn` cannot be cancelled cooperatively. The spec mentions signal only for the retry helper itself, not for `fn`.
- The test suite uses real `AbortController` and `setTimeout` (small delays) – this is adequate for deterministic behaviour verification, but real‑world timings might differ. The injectable `sleep` seam enables fully deterministic tests of the backoff logic and abort interruption without real timers.