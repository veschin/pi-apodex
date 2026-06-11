```js solution
/**
 * Normalizes an array of intervals by sorting by start and merging
 * overlapping/touching intervals (including when end >= next start).
 * Empty intervals (start === end) are removed.
 */
function normalize(intervals) {
  const filtered = intervals.filter(([s, e]) => s !== e);
  if (filtered.length === 0) return [];
  filtered.sort((a, b) => a[0] - b[0]);
  const merged = [];
  let cur = filtered[0];
  for (let i = 1; i < filtered.length; i++) {
    const next = filtered[i];
    if (cur[1] >= next[0]) {
      // overlap or touch
      cur[1] = Math.max(cur[1], next[1]);
    } else {
      merged.push(cur);
      cur = next;
    }
  }
  merged.push(cur);
  return merged;
}

/**
 * Throws TypeError if the interval is not a valid 2-tuple of finite integers
 * with start <= end.
 */
function validateInterval(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) {
    throw new TypeError("Each interval must be a 2-element array");
  }
  const [s, e] = pair;
  if (!Number.isInteger(s) || !Number.isInteger(e)) {
    throw new TypeError("Start and end must be finite integers");
  }
  if (s > e) {
    throw new TypeError("Start cannot be greater than end");
  }
}

/**
 * Subtracts the set of points covered by array b from the set covered by array a.
 * Inputs are arrays of half-open intervals [start, end).
 * Returns a minimal, sorted, disjoint list of intervals representing a minus b.
 *
 * @param {Array<[number,number]>} a - intervals in the first set
 * @param {Array<[number,number]>} b - intervals to subtract
 * @returns {Array<[number,number]>} a \ b
 * @throws {TypeError} on invalid input
 */
export function subtractIntervals(a, b) {
  // --- input validation ---
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new TypeError("Both arguments must be arrays");
  }
  a.forEach(validateInterval);
  b.forEach(validateInterval);

  // --- normalisation ---
  const normA = normalize(a);
  const normB = normalize(b);

  // trivial cases
  if (normA.length === 0) return [];
  if (normB.length === 0) return normA;

  // --- subtraction using two-pointer technique ---
  const result = [];
  let bIdx = 0;
  const bLen = normB.length;

  for (const [aStart, aEnd] of normA) {
    let curStart = aStart;
    const curEnd = aEnd;

    // skip b intervals that end before the current a interval starts
    while (bIdx < bLen && normB[bIdx][1] <= curStart) {
      bIdx++;
    }

    let j = bIdx;
    while (j < bLen && normB[j][0] < curEnd) {
      const [bStart, bEnd] = normB[j];

      // add uncovered part before this b interval
      if (bStart > curStart) {
        result.push([curStart, Math.min(curEnd, bStart)]);
      }

      // advance the current start past the b interval
      curStart = Math.max(curStart, bEnd);
      if (curStart >= curEnd) break;  // no more points left in this a interval
      j++;
    }

    // add any remaining tail of the a interval
    if (curStart < curEnd) {
      result.push([curStart, curEnd]);
    }
  }

  // --- final merge of touching / overlapping result intervals ---
  // (they are already sorted, but adjacent intervals may need merging)
  if (result.length === 0) return [];
  const final = [result[0]];
  for (let i = 1; i < result.length; i++) {
    const prev = final[final.length - 1];
    const curr = result[i];
    if (prev[1] >= curr[0]) {
      // overlap or touch – merge
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      final.push(curr);
    }
  }
  return final;
}
```

```js selftest
import { subtractIntervals } from "./solution.mjs";

let failures = 0;

function check(description, actual, expected) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    console.error(`FAIL: ${description}`);
    console.error(`  expected: ${expectedStr}`);
    console.error(`  got:      ${actualStr}`);
    failures++;
  } else {
    console.log(`PASS: ${description}`);
  }
}

function expectThrows(description, fn, expectedMessage) {
  try {
    fn();
    console.error(`FAIL: ${description} – no error thrown`);
    failures++;
  } catch (e) {
    if (e instanceof TypeError && e.message === expectedMessage) {
      console.log(`PASS: ${description}`);
    } else {
      console.error(`FAIL: ${description} – unexpected error: ${e.message}`);
      failures++;
    }
  }
}

// ── Type Error checks ──────────────────────────────────────────────
expectThrows(
  "non-array a",
  () => subtractIntervals("not array", []),
  "Both arguments must be arrays"
);
expectThrows(
  "non-array b",
  () => subtractIntervals([], "not array"),
  "Both arguments must be arrays"
);
expectThrows(
  "interval not an array",
  () => subtractIntervals([[1, 2], 3], []),
  "Each interval must be a 2-element array"
);
expectThrows(
  "interval with wrong length",
  () => subtractIntervals([[1, 2, 3]], []),
  "Each interval must be a 2-element array"
);
expectThrows(
  "non-integer start",
  () => subtractIntervals([[1.5, 3]], []),
  "Start and end must be finite integers"
);
expectThrows(
  "non-integer end",
  () => subtractIntervals([[1, 3.5]], []),
  "Start and end must be finite integers"
);
expectThrows(
  "start > end",
  () => subtractIntervals([[5, 3]], []),
  "Start cannot be greater than end"
);
// start === end is valid (empty interval) – no throw
// (tested later)

// ── Edge cases: empty inputs ───────────────────────────────────────
check(
  "both empty",
  subtractIntervals([], []),
  []
);
check(
  "a empty, b nonempty",
  subtractIntervals([], [[1, 5]]),
  []
);
check(
  "a nonempty, b empty",
  subtractIntervals([[0, 10]], []),
  [[0, 10]]
);

// ── Basic subtraction ──────────────────────────────────────────────
check(
  "simple: [0,5) minus [2,3)",
  subtractIntervals([[0, 5]], [[2, 3]]),
  [[0, 2], [3, 5]]
);

check(
  "touching boundaries: [1,3) minus [3,5) => [1,3)",
  subtractIntervals([[1, 3]], [[3, 5]]),
  [[1, 3]]
);

check(
  "b fully covers a",
  subtractIntervals([[1, 4]], [[0, 10]]),
  []
);

check(
  "a split into several pieces",
  subtractIntervals([[0, 10]], [[2, 3], [5, 7]]),
  [[0, 2], [3, 5], [7, 10]]
);

check(
  "multiple a intervals with partial overlaps",
  subtractIntervals([[0, 5], [10, 15]], [[2, 3], [12, 13]]),
  [[0, 2], [3, 5], [10, 12], [13, 15]]
);

// ── Overlapping / unsorted inputs (normalization) ──────────────────
check(
  "overlapping a intervals are merged before subtraction",
  subtractIntervals([[0, 2], [1, 3]], [[0, 1], [1, 2]]),
  [[2, 3]]
);

check(
  "unsorted a intervals",
  subtractIntervals([[10, 15], [0, 5]], [[2, 3]]),
  [[0, 2], [3, 5], [10, 15]]
);

check(
  "unsorted b intervals",
  subtractIntervals([[0, 10]], [[7, 9], [2, 4]]),
  [[0, 2], [4, 7], [9, 10]]
);

// ── Empty intervals (start === end) are ignored ────────────────────
check(
  "empty intervals in a are ignored",
  subtractIntervals([[0, 0], [1, 3]], [[2, 2]]),
  [[1, 3]]
);

check(
  "empty intervals in b are ignored",
  subtractIntervals([[0, 10]], [[5, 5]]),
  [[0, 10]]
);

// ── Result merging – touching intervals combined ───────────────────
check(
  "result intervals are merged when adjacent",
  subtractIntervals([[0, 2], [2, 4]], []),  // a has touching intervals
  [[0, 4]]
);

check(
  "subtraction producing adjacent pieces",
  subtractIntervals([[0, 10]], [[2, 4], [6, 8]]),
  [[0, 2], [4, 6], [8, 10]]
);

// ── Large / boundary (no special handling, just a quick sanity) ──
check(
  "handles negative numbers",
  subtractIntervals([[-5, 5]], [[-2, 0]]),
  [[-5, -2], [0, 5]]
);

// ── Process‑level error trapping (fail on unhandled rejections / exceptions)
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

// ── Summary ────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll tests passed.");
}
```