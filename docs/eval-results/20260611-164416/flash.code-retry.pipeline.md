```js solution
/**
 * Production-grade async retry helper.
 *
 * @param {Function} fn  – (attemptIndex) => any; called with 0‑based index.
 * @param {object}  [options]
 * @param {number}  [options.retries=3]       – retries AFTER the first attempt; must be non‑negative integer.
 * @param {number}  [options.baseDelayMs=100] – first backoff delay in ms.
 * @param {number}  [options.maxDelayMs=30000]– cap for any delay.
 * @param {Function}[options.retryOn]         – (error) => boolean; default retry all.
 * @param {AbortSignal}[options.signal]
 * @param {Function}[options.sleep]           – (ms, signal) => Promise<void> for backoff waits.
 * @returns {Promise<any>}
 * @throws {TypeError} synchronously on invalid inputs.
 */
export function retry(fn, options) {
  // --- guard against null / undefined options ---
  options = options ?? {};

  // --- synchronous validation ---
  if (typeof fn !== 'function') {
    throw new TypeError('fn must be a function');
  }

  const { retries, baseDelayMs, maxDelayMs, retryOn, signal, sleep } = options;

  if (retries !== undefined) {
    if (typeof retries !== 'number' || !Number.isFinite(retries) || retries < 0 || !Number.isInteger(retries)) {
      throw new TypeError('retries must be a non‑negative finite integer');
    }
  }
  if (baseDelayMs !== undefined) {
    if (typeof baseDelayMs !== 'number' || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
      throw new TypeError('baseDelayMs must be a non‑negative finite number');
    }
  }
  if (maxDelayMs !== undefined) {
    if (typeof maxDelayMs !== 'number' || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
      throw new TypeError('maxDelayMs must be a non‑negative finite number');
    }
  }
  if (retryOn !== undefined && typeof retryOn !== 'function') {
    throw new TypeError('retryOn must be a function');
  }
  if (sleep !== undefined && typeof sleep !== 'function') {
    throw new TypeError('sleep must be a function');
  }

  // --- defaults ---
  const maxRetries = retries ?? 3;                      // number of *retries* after the first attempt
  const baseDelay = baseDelayMs ?? 100;
  const maxDelay = maxDelayMs ?? 30000;
  const shouldRetry = retryOn ?? (() => true);
  const sleepFn = sleep ?? defaultSleep;

  // --- execution ---
  return new Promise((resolve, reject) => {
    const errors = [];
    let attemptIndex = 0;

    async function run() {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // 1) Before each attempt, check if already aborted
        if (signal?.aborted) {
          const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
          return reject(
            errors.length === 0
              ? reason
              : new AggregateError([...errors, reason], `retry aborted after ${attemptIndex} attempt(s)`)
          );
        }

        // 2) Perform the attempt
        let value;
        try {
          value = await fn(attemptIndex);
        } catch (err) {
          errors.push(err);
          attemptIndex++;

          // Exhausted allowed attempts?
          if (attemptIndex > maxRetries) {
            return reject(
              new AggregateError(errors, `retry failed after ${attemptIndex} attempt(s)`)
            );
          }

          // Check retryOn predicate
          if (!shouldRetry(err)) {
            return reject(
              new AggregateError(errors, `retry failed after ${attemptIndex} attempt(s)`)
            );
          }

          // 3) Compute backoff delay (k = 1‑based retry index = attemptIndex)
          const k = attemptIndex;
          const delay = Math.min(baseDelay * Math.pow(2, k - 1), maxDelay);

          // 4) Wait for backoff – catch both abort and unexpected sleep errors
          try {
            await sleepFn(delay, signal);
          } catch (sleepErr) {
            if (signal?.aborted) {
              // sleep rejection due to abort – treat as abort
              const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
              return reject(
                new AggregateError([...errors, reason], `retry aborted after ${attemptIndex} attempt(s)`)
              );
            } else {
              // sleep failed for an unexpected reason – propagate with previous attempt errors
              return reject(
                new AggregateError(
                  [...errors, sleepErr],
                  `retry encountered unexpected sleep error after ${attemptIndex} attempt(s)`
                )
              );
            }
          }
          continue; // next attempt
        }

        // Success
        return resolve(value);
      }
    }

    run();
  });
}

// ---------------------------------------------------------------------------
// Default sleep – resolves after ms, rejects immediately on abort
// ---------------------------------------------------------------------------
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort);
  });
}
```

```js selftest
// --- selftest.mjs ---
import { retry } from "./solution.mjs";
import assert from "assert";

// Catch unhandled rejections and uncaught exceptions
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

let pass = 0;
const total = 27; // updated count

function ok(condition, msg) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    process.exit(1);
  }
}

function assertReject(promise, expectedMessage, expectedErrorsLength) {
  return promise.then(
    () => { throw new Error("Expected rejection"); },
    (err) => {
      ok(err instanceof AggregateError, "rejected with AggregateError");
      ok(err.errors.length === expectedErrorsLength, `errors length = ${expectedErrorsLength}`);
      ok(err.message.includes("attempt"), `message mentions attempt count: "${err.message}"`);
      return err;
    }
  );
}

// ── 1. Basic success ──
{
  const r = retry(() => "ok", { retries: 0 });
  const v = await r;
  ok(v === "ok", "resolves with value on first success");
}

// ── 2. Success after one retry ──
{
  let i = 0;
  const r = retry(() => { if (i++ === 0) throw new Error("first fail"); return "ok"; }, { retries: 2 });
  const v = await r;
  ok(v === "ok", "succeeds after one retry");
  ok(i === 2, "fn called exactly twice");
}

// ── 3. Exhaust all retries – reject with all errors ──
{
  const errs = [new Error("1"), new Error("2"), new Error("3")];
  let idx = 0;
  const r = retry(() => { throw errs[idx++]; }, { retries: 2 });
  const rejected = await assertReject(r, "retry failed after 3 attempt(s)", 3);
  ok(rejected.errors[0] === errs[0], "first error in order");
  ok(rejected.errors[1] === errs[1], "second error in order");
  ok(rejected.errors[2] === errs[2], "third error in order");
}

// ── 4. retries=0 – exactly one attempt ──
{
  const r = retry(() => { throw new Error("fail"); }, { retries: 0 });
  const rejected = await assertReject(r, "failed after 1 attempt(s)", 1);
}

// ── 5. retryOn false – stop immediately ──
{
  const err = new Error("bad");
  const r = retry(() => { throw err; }, { retries: 3, retryOn: (e) => e.message === "retryable" });
  const rejected = await assertReject(r, "failed after 1 attempt(s)", 1);
  ok(rejected.errors[0] === err, "only one error");
}

// ── 6. retryOn true – keep retrying ──
{
  let i = 0;
  const r = retry(() => { if (++i < 3) throw new Error("retryable"); return "ok"; }, { retries: 3, retryOn: (e) => true });
  const v = await r;
  ok(v === "ok", "retryOn true allows retries");
  ok(i === 3, "fn called 3 times");
}

// ── 7. Signal abort before any attempt ──
{
  const ac = new AbortController();
  ac.abort("my reason");
  const r = retry(() => "won't run", { retries: 3, signal: ac.signal });
  const rejected = await r.catch(e => e);
  ok(String(rejected) === "my reason", "abort rejects with signal.reason");
}

// ── 8. Signal abort during backoff – reject with aggregate ──
{
  const ac = new AbortController();
  const errs = [new Error("first")];
  const r = retry(() => { throw errs[0]; }, {
    retries: 3,
    baseDelayMs: 100000,
    maxDelayMs: 100000,
    signal: ac.signal,
    sleep: (ms, sig) => {
      setTimeout(() => ac.abort("timeout"), 5);
      return new Promise((resolve, reject) => {
        if (sig.aborted) return reject(sig.reason);
        const timer = setTimeout(resolve, ms);
        const onAbort = () => { clearTimeout(timer); reject(sig.reason); };
        sig.addEventListener("abort", onAbort);
      });
    }
  });
  const rejected = await r.catch(e => e);
  ok(rejected instanceof AggregateError, "aggregate on abort during backoff");
  ok(rejected.errors.length === 2, "two errors: original + abort reason");
  ok(rejected.errors[0] === errs[0], "first error preserved");
  ok(rejected.errors[1] === "timeout", "abort reason included");
  ok(rejected.message.includes("attempt"), "message mentions attempt count");
}

// ── 9. Signal abort after some attempts, but not during backoff ──
{
  const ac = new AbortController();
  let attempts = 0;
  const r = retry(() => {
    attempts++;
    if (attempts === 1) throw new Error("first");
    return "should not reach";
  }, {
    retries: 3,
    baseDelayMs: 10,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort("stop"), 2);
  const rejected = await r.catch(e => e);
  ok(rejected instanceof AggregateError, "aggregate on abort before second attempt");
  ok(rejected.errors.length === 2, "first error + abort reason");
  ok(rejected.errors[0].message === "first", "original error first");
  ok(attempts === 1, "only one attempt made");
}

// ── 10. Signal abort with no reason – DOMException ──
{
  const ac = new AbortController();
  ac.abort();
  const r = retry(() => "x", { retries: 3, signal: ac.signal });
  const rejected = await r.catch(e => e);
  ok(rejected instanceof DOMException, "rejected with DOMException");
  ok(rejected.name === "AbortError", "name is AbortError");
}

// ── 11. Injectable sleep is called with (ms, signal) ──
{
  let sleepArgs = [];
  const customSleep = (ms, signal) => {
    sleepArgs.push({ ms, signal });
    return Promise.resolve();
  };
  let i = 0;
  const r = retry(() => { if (i++ < 2) throw new Error("fail"); return "ok"; }, {
    retries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    sleep: customSleep,
  });
  const v = await r;
  ok(v === "ok", "custom sleep used");
  ok(sleepArgs.length === 2, "sleep called twice");
  ok(sleepArgs[0].ms === 100, `first sleep ms = ${sleepArgs[0].ms}`);
  ok(sleepArgs[1].ms === 200, `second sleep ms = ${sleepArgs[1].ms}`);
  ok(sleepArgs[0].signal === undefined, "passed signal (undefined)");
}

// ── 12. Validate fn ──
{
  try {
    retry("not a function");
    ok(false, "should throw on non-function fn");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for non-function fn");
  }
}

// ── 13. Validate retries non-negative integer ──
{
  try {
    retry(() => {}, { retries: -1 });
    ok(false, "should throw on negative retries");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for negative retries");
  }
  try {
    retry(() => {}, { retries: 1.5 });
    ok(false, "should throw on non-integer retries");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for fractional retries");
  }
  try {
    retry(() => {}, { retries: Infinity });
    ok(false, "should throw on infinite retries");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for infinite retries");
  }
}

// ── 14. Validate baseDelayMs ──
{
  try {
    retry(() => {}, { baseDelayMs: NaN });
    ok(false, "should throw on NaN baseDelayMs");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for NaN baseDelayMs");
  }
  try {
    retry(() => {}, { baseDelayMs: -1 });
    ok(false, "should throw on negative baseDelayMs");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for negative baseDelayMs");
  }
}

// ── 15. Validate maxDelayMs ──
{
  try {
    retry(() => {}, { maxDelayMs: Infinity });
    ok(false, "should throw on infinite maxDelayMs");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for infinity maxDelayMs");
  }
  try {
    retry(() => {}, { maxDelayMs: -100 });
    ok(false, "should throw on negative maxDelayMs");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for negative maxDelayMs");
  }
}

// ── 16. Attempt index starts at 0, increments properly ──
{
  const indices = [];
  const r = retry(() => {
    indices.push(indices.length);
    throw new Error("fail");
  }, { retries: 2 });
  await r.catch(() => {});
  ok(indices.length === 3, "three attempts");
  ok(indices[0] === 0, "first index 0");
  ok(indices[1] === 1, "second index 1");
  ok(indices[2] === 2, "third index 2");
}

// ── 17. Max delay cap works ──
{
  const delays = [];
  const customSleep = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  const r = retry(() => { throw new Error("fail"); }, {
    retries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 1500,
    sleep: customSleep,
  });
  await r.catch(() => {});
  ok(delays.length === 5, "five backoff waits");
  ok(delays[0] === 1000, "delay 0 = 1000");
  ok(delays[1] === 1500, "delay 1 = min(2000,1500)=1500");
  ok(delays[2] === 1500, "delay 2 = min(4000,1500)=1500");
  ok(delays[3] === 1500, "delay 3 = min(8000,1500)=1500");
  ok(delays[4] === 1500, "delay 4 = min(16000,1500)=1500");
}

// ── 18. Abort during long backoff – immediate rejection ──
{
  const ac = new AbortController();
  const r = retry(() => { throw new Error("err"); }, {
    retries: 3,
    baseDelayMs: 1_000_000,
    maxDelayMs: 1_000_000,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort("aborted"), 10);
  const start = Date.now();
  const rejected = await r.catch(e => e);
  const elapsed = Date.now() - start;
  ok(elapsed < 1000, "rejected quickly (<1s)");
  ok(String(rejected).includes("aborted"), "rejected with abort reason");
}

// ── 19. No retries + abort after first failure (no backoff) ──
{
  const ac = new AbortController();
  const r = retry(() => { throw new Error("first"); }, { retries: 0, signal: ac.signal });
  setTimeout(() => ac.abort("late abort"), 5);
  const rejected = await r.catch(e => e);
  ok(rejected instanceof AggregateError, "aggregate (since we already have error)");
  ok(rejected.errors.length === 1, "only the attempt error");
  ok(rejected.errors[0].message === "first", "error preserved");
}

// ── 20. Options = null should not throw (use default) ──
{
  const r = retry(() => "ok", null);
  const v = await r;
  ok(v === "ok", "null options treated as no options");
}

// ── 21. retries = 0 exactly one attempt, success ──
{
  const r = retry(() => "works", { retries: 0 });
  const v = await r;
  ok(v === "works", "retries=0 succeeds on first attempt");
}

// ── 22. Check that error message includes attempt count ──
{
  const r = retry(() => { throw new Error("fail"); }, { retries: 0 });
  const rejected = await r.catch(e => e);
  ok(rejected.message.includes("1 attempt"), `message includes "1 attempt": "${rejected.message}"`);
}

// ── 23. Validate retryOn must be a function ──
{
  try {
    retry(() => {}, { retryOn: "not a function" });
    ok(false, "should throw on non-function retryOn");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for non-function retryOn");
  }
}

// ── 24. Validate sleep must be a function ──
{
  try {
    retry(() => {}, { sleep: 42 });
    ok(false, "should throw on non-function sleep");
  } catch (e) {
    ok(e instanceof TypeError, "TypeError for non-function sleep");
  }
}

// ── 25. Custom sleep that rejects with non-abort error should propagate ──
{
  const customSleep = (ms, signal) => {
    return Promise.reject(new Error("sleep exploded"));
  };
  const r = retry(() => { throw new Error("attempt fail"); }, {
    retries: 2,
    sleep: customSleep,
    // no signal – so any sleep rejection is not an abort
  });
  const rejected = await r.catch(e => e);
  ok(rejected instanceof AggregateError, "AggregateError for unexpected sleep error");
  // should contain attempt error and sleep error
  ok(rejected.errors.length === 2, "two errors: attempt + sleep");
  ok(rejected.errors[0].message === "attempt fail", "first error is attempt error");
  ok(rejected.errors[1].message === "sleep exploded", "second error is sleep error");
  ok(rejected.message.includes("unexpected sleep error"), "message mentions sleep error");
}

// ── 26. Custom sleep that rejects with abort when signal NOT aborted – NOT treated as abort ──
{
  const ac = new AbortController();
  // sleep rejects with an abort-like error but signal is NOT aborted
  const customSleep = (ms, signal) => {
    return Promise.reject(new Error("not an abort but looks like one"));
  };
  const r = retry(() => { throw new Error("attempt fail"); }, {
    retries: 2,
    sleep: customSleep,
    signal: ac.signal, // signal never aborted
  });
  const rejected = await r.catch(e => e);
  ok(rejected instanceof AggregateError, "AggregateError for non-abort sleep rejection");
  ok(rejected.errors.length === 2, "attempt error + sleep error");
  ok(rejected.errors[1].message === "not an abort but looks like one", "sleep error preserved");
}

// ── 27. Signal abort during sleep – check that we use signal.reason and not sleep rejection value ──
{
  const ac = new AbortController();
  const customSleep = (ms, signal) => {
    // this sleep rejects with a different value than signal.reason
    signal.addEventListener('abort', () => {
      // reject with something else, but the real abort reason is "stop"
    });
    // actually, let's force abort rejection inside sleep but also abort externally
    // We'll just use defaultSleep but with an extra delay
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("sleep's own rejection")); // this should be overridden by signal.reason check
      };
      signal.addEventListener("abort", onAbort);
    });
  };
  const r = retry(() => { throw new Error("first"); }, {
    retries: 3,
    baseDelayMs: 100000,
    sleep: customSleep,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort("stop"), 5);
  const rejected = await r.catch(e => e);
  ok(rejected instanceof AggregateError, "aggregate on abort during backoff");
  // errors should include "first" and then the signal reason "stop", not sleep's rejection
  ok(rejected.errors.length === 2, "two errors");
  ok(rejected.errors[0].message === "first", "original error preserved");
  // The second error should be the signal.reason ("stop") because we check signal?.aborted after sleep rejection
  ok(rejected.errors[1] === "stop", "abort reason is signal.reason, not sleep rejection value");
}

// ── Summary ──
console.log(`\nAll ${pass}/${total} tests passed.`);
```

## Approach, edge cases, and limitations

The solution is a self‑contained ESM module exporting `retry`.  
It validates all inputs **synchronously** (as required) and throws `TypeError` for:
- non‑function `fn`
- non‑number, infinite, negative, or (for `retries`) non‑integer values for `retries`, `baseDelayMs`, `maxDelayMs`
- non‑function `retryOn` or `sleep` (if provided)

A null/undefined `options` object is normalised to an empty object, avoiding crashes.

The core retry loop runs inside a `Promise` constructor, allowing synchronous validation before the promise is created.  
Each attempt calls `fn(attemptIndex)` with an incrementing index starting at 0.  
On success, the promise resolves; on failure:
- The error is collected in an `errors` array.
- If the attempt count exceeds `retries` (number of retries after the first attempt) or `retryOn` returns false, the promise rejects with an `AggregateError` containing all errors.
- Otherwise, a backoff delay is computed: `min(baseDelay * 2^(k-1), maxDelay)` where `k` is the 1‑based retry count.
- The backoff wait uses the injectable `sleep`. If the sleep rejects, the code checks whether the `AbortSignal` was actually aborted at that moment:
  - If yes, it treats the rejection as an abort and rejects with an `AggregateError` containing the attempt errors and the signal’s reason (or a DOMException if no reason set).
  - If no, it rejects with a new `AggregateError` containing the attempt errors and the unexpected sleep error.

Abort is checked before each attempt and before each retry wait. On abort, no further attempts are made. If no error has been collected yet, the promise rejects with the abort reason directly; otherwise, it rejects with an `AggregateError` that includes the abort reason.

## Edge cases covered
- **null/undefined options**
- **Fractional `retries`** – rejected.
- **Negative/infinite/NaN numeric options** – rejected.
- **`retryOn` false on first attempt** – rejects with a single‑error AggregateError.
- **`retryOn` or `sleep` not a function** – TypeError thrown.
- **Custom sleep that rejects for non‑abort reasons** – error is propagated, not swallowed as an abort.
- **Signal abort before any attempt** – reject with signal reason / DOMException.
- **Signal abort during backoff** – reject with AggregateError containing previous errors + abort reason.
- **Signal abort with no reason** – DOMException('Aborted', 'AbortError').
- **Abort during sleep when signal reason differs from sleep rejection value** – the signal’s reason is used (checked via `signal?.aborted` after catching sleep).
- **Maximum delay cap** – verified with custom sleep.
- **`retries=0`** – exactly one attempt.
- **Process‑level unhandled rejection / uncaught exception handlers** – installed to fail the test suite if any leak exists.

## Limitations
- The function cannot abort an ongoing `fn` call; only backoff waits are interruptible. This is consistent with the specification (“interrupt an in‑progress backoff wait”).
- The `defaultSleep` creates a new `AbortController` listener per sleep call; it cleans up on resolution or abort, but if a very large number of retries are combined with a never‑aborted signal, there is a theoretical micro‑delay in listener removal. In practice this is negligible.
- No jitter is applied (explicitly stated as “no jitter”).

## Critique rebuttals
All critique points were valid and have been addressed:
- Added synchronous validation for `retryOn` and `sleep` being functions.
- The sleep catch block now checks `signal?.aborted` before assuming abort; if not aborted, the sleep error is wrapped in an AggregateError and propagated, preserving the attempt errors.