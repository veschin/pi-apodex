```js solution
/**
 * @typedef {Object} RetryOptions
 * @property {number} [retries=3] - Number of retries after the first attempt.
 * @property {number} [baseDelayMs=100] - Base backoff delay in ms.
 * @property {number} [maxDelayMs=30000] - Maximum backoff delay in ms.
 * @property {(error: unknown) => boolean} [retryOn] - Predicate to decide if an error should be retried.
 * @property {AbortSignal} [signal] - AbortSignal to cancel the operation.
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep] - Injectable sleep function.
 */

/**
 * Default sleep implementation that respects an AbortSignal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(signal.reason ?? new DOMException("AbortError", "AbortError"));
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    let onAbort;
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("AbortError", "AbortError"));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Validates that a numeric option is a non-negative finite number.
 * @param {string} name
 * @param {unknown} value
 * @throws {TypeError}
 */
function validateNonNegativeFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number, got ${value}`);
  }
}

/**
 * Production-grade async retry helper.
 * @param {(...args: any[]) => Promise<any>} fn - The function to retry.
 * @param {RetryOptions} [options]
 * @returns {Promise<any>}
 */
export function retry(fn, options = {}) {
  // Input validation (synchronous)
  if (typeof fn !== 'function') {
    throw new TypeError(`fn must be a function, got ${typeof fn}`);
  }

  const {
    retries: retriesOption = 3,
    baseDelayMs: baseDelayMsOption = 100,
    maxDelayMs: maxDelayMsOption = 30000,
    retryOn: retryOnOption,
    signal,
    sleep: sleepOption,
  } = options;

  validateNonNegativeFiniteNumber('retries', retriesOption);
  validateNonNegativeFiniteNumber('baseDelayMs', baseDelayMsOption);
  validateNonNegativeFiniteNumber('maxDelayMs', maxDelayMsOption);

  const maxAttempts = retriesOption + 1;
  const retryOn = typeof retryOnOption === 'function' ? retryOnOption : () => true;
  const sleep = typeof sleepOption === 'function' ? sleepOption : defaultSleep;

  // If signal is already aborted, reject immediately
  if (signal && signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("AbortError", "AbortError")
    );
  }

  const errors = [];
  let attemptIndex = 0;

  const attempt = () => {
    return Promise.resolve().then(() => {
      // Abort check before attempt
      if (signal && signal.aborted) {
        return Promise.reject(
          signal.reason ?? new DOMException("AbortError", "AbortError")
        );
      }
      return fn(attemptIndex);
    }).then(
      (value) => {
        // Success: resolve with value
        return value;
      },
      async (error) => {
        errors.push(error); // store every attempt error
        const isLastAttempt = attemptIndex >= maxAttempts - 1;
        const shouldRetry = !isLastAttempt && retryOn(error);

        if (!shouldRetry) {
          // Reject with AggregateError
          const aggregate = new AggregateError(
            [...errors], // copy for safety
            `All attempts (${attemptsSoFar()}) failed`
          );
          return Promise.reject(aggregate);
        }

        // Compute backoff delay
        const retryNumber = attemptIndex + 1; // k = 1-based
        const delay = Math.min(
          baseDelayMsOption * Math.pow(2, retryNumber - 1),
          maxDelayMsOption
        );

        attemptIndex++;

        // Abort check before sleep
        if (signal && signal.aborted) {
          return Promise.reject(
            signal.reason ?? new DOMException("AbortError", "AbortError")
          );
        }

        // Sleep and then retry
        await sleep(delay, signal);

        // Abort check after sleep (signal might have aborted during sleep)
        if (signal && signal.aborted) {
          return Promise.reject(
            signal.reason ?? new DOMException("AbortError", "AbortError")
          );
        }

        return attempt(); // recursively attempt again
      }
    );
  };

  function attemptsSoFar() {
    return errors.length;
  }

  return attempt();
}
```

```js selftest
import { retry } from "./solution.mjs";

// ---------- helpers ----------
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
    console.trace();
  }
}

function assertRejects(promise, label, check) {
  return promise.then(
    () => {
      failed++;
      console.error(`FAIL: ${label} - expected rejection`);
      console.trace();
    },
    (error) => {
      try {
        if (check(error)) {
          passed++;
          console.log(`PASS: ${label}`);
        } else {
          failed++;
          console.error(`FAIL: ${label} - rejection check failed`);
          console.trace();
        }
      } catch (e) {
        failed++;
        console.error(`FAIL: ${label} - exception in check: ${e}`);
        console.trace();
      }
    }
  );
}

// catch unhandled rejections and exceptions
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error);
  process.exit(1);
});

// ---------- tests ----------

// 1. synchronous validation: fn must be function
try {
  retry(null);
  failed++;
  console.error("FAIL: should throw TypeError for null fn");
} catch (e) {
  if (e instanceof TypeError) {
    passed++;
    console.log("PASS: validation throws TypeError for null fn");
  } else {
    failed++;
    console.error("FAIL: validation threw wrong type");
  }
}

// 2. validation: negative retries
try {
  retry(async () => {}, { retries: -1 });
  failed++;
  console.error("FAIL: should throw for negative retries");
} catch (e) {
  if (e instanceof TypeError && e.message.includes('retries')) {
    passed++;
    console.log("PASS: validation throws for negative retries");
  } else {
    failed++;
    console.error("FAIL: validation for negative retries wrong");
  }
}

// 3. validation: NaN baseDelayMs
try {
  retry(async () => {}, { baseDelayMs: NaN });
  failed++;
  console.error("FAIL: should throw for NaN baseDelayMs");
} catch (e) {
  if (e instanceof TypeError) {
    passed++;
    console.log("PASS: validation throws for NaN baseDelayMs");
  } else {
    failed++;
    console.error("FAIL: validation for NaN baseDelayMs wrong");
  }
}

// 4. validation: Infinity maxDelayMs
try {
  retry(async () => {}, { maxDelayMs: Infinity });
  failed++;
  console.error("FAIL: should throw for Infinity maxDelayMs");
} catch (e) {
  if (e instanceof TypeError) {
    passed++;
    console.log("PASS: validation throws for Infinity maxDelayMs");
  } else {
    failed++;
    console.error("FAIL: validation for Infinity maxDelayMs wrong");
  }
}

// 5. success on first attempt
const successValue = "ok";
let attemptCounter = 0;
const fnSuccess = async (idx) => {
  assert(idx === 0, "attempt index starts at 0");
  attemptCounter++;
  return successValue;
};
await retry(fnSuccess).then((val) => {
  assert(val === successValue, "retry resolves with fn value");
  assert(attemptCounter === 1, "only one attempt on success");
});

// 6. retry on failure then success
let failThenSucceed = 0;
const fnRetryThenSuccess = async (idx) => {
  if (idx === 0) throw new Error("fail first");
  return "success on second";
};
await retry(fnRetryThenSuccess, { retries: 1, baseDelayMs: 10 }).then((val) => {
  assert(val === "success on second", "retry succeeds after failure");
});

// 7. exhausted retries -> AggregateError
let attempts = [];
const fnAlwaysFail = async (idx) => {
  attempts.push(idx);
  throw new Error(`fail ${idx}`);
};
await assertRejects(
  retry(fnAlwaysFail, { retries: 2, baseDelayMs: 10 }),
  "exhausted retries rejects with AggregateError",
  (err) => {
    return (
      err instanceof AggregateError &&
      err.errors.length === 3 &&
      err.errors[0].message === "fail 0" &&
      err.errors[1].message === "fail 1" &&
      err.errors[2].message === "fail 2" &&
      err.message.includes("3") // attempt count mentioned
    );
  }
);

// 8. retryOn filter: only retry on specific error
let filterAttempts = 0;
const fnFilter = async (idx) => {
  filterAttempts++;
  if (idx === 0) throw new TypeError("type error");
  else throw new RangeError("range error");
};
await assertRejects(
  retry(fnFilter, { retries: 1, baseDelayMs: 10, retryOn: (e) => e instanceof TypeError }),
  "retryOn filter stops retry on non-matching error",
  (err) => {
    return (
      err instanceof AggregateError &&
      err.errors.length === 1 && // only first error, second not attempted
      err.errors[0] instanceof TypeError
    );
  }
);
assert(filterAttempts === 1, "only one attempt because retryOn prevented retry");

// 9. signal abort before first attempt
const aborter1 = new AbortController();
aborter1.abort();
const reason1 = new Error("custom abort reason");
// create an AbortSignal with reason (modern API)
const customSignal1 = new AbortController();
Object.defineProperty(customSignal1.signal, 'reason', { value: reason1, writable: false });
customSignal1.abort();
await assertRejects(
  retry(async () => "never", { signal: customSignal1.signal }),
  "signal aborted before start rejects with signal's reason",
  (err) => {
    return err === reason1;
  }
);

// 10. signal abort during backoff
const aborter2 = new AbortController();
let fnCalled = 0;
const fnDuringBackoff = async (idx) => {
  fnCalled++;
  throw new Error("fail");
};
const retryPromise = retry(fnDuringBackoff, { retries: 5, baseDelayMs: 1e6, signal: aborter2.signal });
setTimeout(() => {
  aborter2.abort();
}, 50);
await assertRejects(
  retryPromise,
  "signal abort during backoff rejects with AbortError",
  (err) => {
    return err instanceof DOMException && err.name === "AbortError";
  }
);
assert(fnCalled === 1, "only first attempt before abort");

// 11. maxDelayMs cap
let delays = [];
const customSleep = (ms) => {
  delays.push(ms);
  return Promise.resolve();
};
await retry(
  async (idx) => { throw new Error("fail"); },
  { retries: 3, baseDelayMs: 1000, maxDelayMs: 1500, sleep: customSleep }
).catch(() => {}); // ignore rejection
assert(delays.length === 3, "three backoff delays");
assert(delays[0] === 1000, "first backoff 1000");
assert(delays[1] === 1500, "second backoff capped at 1500 (2000>1500)");
assert(delays[2] === 1500, "third backoff also capped at 1500 (4000>1500)");

// 12. retries=0 => exactly one attempt
let oneAttemptCount = 0;
await assertRejects(
  retry(
    async (idx) => { oneAttemptCount++; throw new Error("fail"); },
    { retries: 0 }
  ),
  "retries=0 rejects with one error in AggregateError",
  (err) => {
    return (
      err instanceof AggregateError &&
      err.errors.length === 1 &&
      err.message.includes("1")
    );
  }
);
assert(oneAttemptCount === 1, "only one attempt when retries=0");

// 13. injectable sleep
const sleepMock = async (ms, signal) => {
  // just resolve immediately, ignore signal for test
};
const mockFn = async (idx) => { if (idx === 0) throw new Error("fail"); return "ok"; };
const result = await retry(mockFn, { retries: 1, baseDelayMs: 100, sleep: sleepMock });
assert(result === "ok", "injectable sleep works");

// 14. attempts index increment correctly
let indices = [];
await retry(
  async (idx) => { indices.push(idx); throw new Error("fail"); },
  { retries: 2, baseDelayMs: 10, sleep: () => Promise.resolve() }
).catch(() => {});
assert(JSON.stringify(indices) === JSON.stringify([0,1,2]), "attempt indices 0,1,2");

// 15. no signal supplied should work
const noSignalVal = await retry(async (idx) => "no signal");
assert(noSignalVal === "no signal", "works without signal");

// 16. default sleep respects signal (quick test)
const abortController = new AbortController();
const sleepPromise = new Promise((resolve) => {
  const defaultSleep = (ms, signal) => {
    return new Promise((res, rej) => {
      if (signal.aborted) return rej(new DOMException("AbortError", "AbortError"));
      const timer = setTimeout(res, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        rej(signal.reason ?? new DOMException("AbortError", "AbortError"));
      });
    });
  };
  const p = defaultSleep(10000, abortController.signal);
  setTimeout(() => abortController.abort(), 10);
  p.then(() => resolve("resolved"), () => resolve("rejected"));
});
const sleepResult = await sleepPromise;
assert(sleepResult === "rejected", "default sleep rejects on abort");

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```