```js solution
// solution.mjs

/**
 * Validate that the input is an array of valid half-open intervals.
 * Each interval must be an array of exactly two finite integers with start <= end.
 */
function validateInput(input) {
  if (!Array.isArray(input)) {
    throw new TypeError('Expected an array of intervals');
  }
  for (const el of input) {
    if (!Array.isArray(el) || el.length !== 2) {
      throw new TypeError('Each interval must be an array of exactly two integers');
    }
    const [a, b] = el;
    if (typeof a !== 'number' || typeof b !== 'number' ||
        !Number.isInteger(a) || !Number.isInteger(b)) {
      throw new TypeError('Interval bounds must be finite integers');
    }
    if (a > b) {
      throw new TypeError('Interval start cannot be greater than end');
    }
  }
}

/**
 * Normalize a list of valid intervals:
 * - discard empty ones (start === end)
 * - sort by start
 * - merge intervals that overlap or touch (start <= previous end)
 */
function normalize(intervals) {
  // Filter out zero-length (empty) intervals
  const nonEmpty = intervals.filter(([s, e]) => s !== e);
  if (nonEmpty.length === 0) return [];

  // Sort by start ascending, break ties with end (optional but consistent)
  nonEmpty.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [];
  for (const [start, end] of nonEmpty) {
    if (merged.length === 0 || start > merged[merged.length - 1][1]) {
      // No overlap/touch -> push new interval
      merged.push([start, end]);
    } else {
      // Overlap or touch -> extend the last interval
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
    }
  }
  return merged;
}

/**
 * Subtract set of intervals b from set of intervals a (half-open [start, end)).
 * Returns minimal sorted list of disjoint half-open intervals.
 */
export function subtractIntervals(a, b) {
  // Validate inputs
  validateInput(a);
  validateInput(b);

  // Normalize both lists (merge overlapping/touching intervals)
  const A = normalize(a);
  const B = normalize(b);

  const result = [];
  let j = 0;

  for (let i = 0; i < A.length; i++) {
    let aStart = A[i][0];
    const aEnd = A[i][1];

    // Skip B intervals that end before or at aStart (no overlap)
    while (j < B.length && B[j][1] <= aStart) {
      j++;
    }

    // Subtract any overlapping B intervals
    while (j < B.length && B[j][0] < aEnd) {
      const [bStart, bEnd] = B[j];

      // If there's a gap between aStart and bStart, it survives
      if (bStart > aStart) {
        result.push([aStart, bStart]);
      }

      // Move aStart forward to the end of this subtracted block
      aStart = Math.max(aStart, bEnd);
      if (aStart >= aEnd) break;

      // Current B interval is fully consumed
      j++;
    }

    // Append whatever remains of the original A interval
    if (aStart < aEnd) {
      result.push([aStart, aEnd]);
    }
  }

  return result;
}
```

```js selftest
// selftest.mjs
import { subtractIntervals } from './solution.mjs';

// ---------- helpers ----------
function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

function intervalsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

function test(name, a, b, expected) {
  const actual = subtractIntervals(a, b);
  if (!intervalsEqual(actual, expected)) {
    console.error(
      `FAIL: ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`
    );
    process.exit(1);
  }
  console.log(`PASS: ${name}`);
}

function testError(name, a, b) {
  try {
    subtractIntervals(a, b);
    console.error(`FAIL: ${name} – expected TypeError but no error thrown`);
    process.exit(1);
  } catch (e) {
    if (e instanceof TypeError) {
      console.log(`PASS: ${name} (TypeError)`);
    } else {
      console.error(`FAIL: ${name} – expected TypeError, got ${e.constructor.name}: ${e.message}`);
      process.exit(1);
    }
  }
}

// Catch any unhandled promise rejections or exceptions
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// ---------- valid scenarios ----------
console.log('=== VALID SUBTRACTION ===');
test('empty a', [], [[1, 2]], []);
test('empty b', [[1, 2]], [], [[1, 2]]);
test('both empty', [], [], []);
test('simple subtract inside', [[1, 5]], [[2, 4]], [[1, 2], [4, 5]]);
test('b before a (adjacent)', [[3, 5]], [[1, 3]], [[3, 5]]);
test('b after a (adjacent)', [[1, 3]], [[3, 5]], [[1, 3]]);
test('b covers a completely', [[1, 10]], [[0, 20]], []);
test('a inside b (fully removed)', [[2, 3]], [[1, 5]], []);
test('split into three pieces', [[1, 10]], [[2, 3], [4, 5]], [[1, 2], [3, 4], [5, 10]]);
test('subtract left edge', [[1, 10]], [[1, 5]], [[5, 10]]);
test('subtract right edge', [[1, 10]], [[5, 10]], [[1, 5]]);
test('multiple a intervals (disjoint)', [[1, 3], [5, 7]], [[2, 6]], [[1, 2], [6, 7]]);
test('multiple a intervals (touching after merge)', [[1, 3], [3, 5]], [[4, 6]], [[1, 4]]); // a merges to [1,5], b=[4,6] => [1,4]
test('a with overlapping intervals', [[1, 5], [3, 8]], [[4, 6]], [[1, 4], [6, 8]]);
test('b with overlapping intervals', [[1, 10]], [[2, 4], [3, 7]], [[1, 2], [7, 10]]); // b merges to [2,7]
test('empty interval in a (ignored)', [[2, 5], [2, 2]], [[3, 4]], [[2, 3], [4, 5]]);
test('all empty intervals', [[1, 1], [2, 2]], [], []);
test('b single point interval (zero-length)', [[1, 5]], [[3, 3]], [[1, 5]]); // b empty ignored, no subtraction

// ---------- error paths ----------
console.log('\n=== TYPE ERRORS ===');
testError('a is not an array', 123, []);
testError('b is not an array', [], 'string');
testError('element in a is not a 2-tuple (too many)', [[1, 2, 3]], []);
testError('element in a is not a 2-tuple (too few)', [[1]], []);
testError('element in b is null', [[1, 2]], [null]);
testError('non-integer start', [[1.5, 3]], []);
testError('non-integer end', [[1, 2.7]], []);
testError('non-finite start (Infinity)', [[1, Infinity]], []);
testError('non-finite end (-Infinity)', [[-Infinity, 2]], []);
testError('non-finite start (NaN)', [[NaN, 2]], []);
testError('start > end', [[3, 2]], []);
testError('start > end (mixed with valid)', [[1, 4], [5, 2]], []);

console.log('\nAll tests passed.');
```

**Explanation**

The solution validates both inputs, normalizes each list by sorting and merging overlapping **and touching** intervals, then performs a subtraction that walks through both normalized lists once. The result is already minimal and sorted.

**Edge cases handled**
- Empty lists, fully covered intervals, adjacent boundaries (touch but no overlap), intervals split into multiple pieces.
- Zero‑length intervals (`start === end`) are filtered out during normalization, treating them as empty and harmless.
- Unsorted, overlapping, and even nested intervals within each input are correctly merged as required.
- Touching intervals (e.g., `[1,3)` and `[3,5)`) are merged into a single `[1,5)` to match the task’s normalisation rule.

**Validation boundaries**
- Throws `TypeError` for non‑array inputs, elements that are not exactly two‑element arrays, non‑finite integer bounds, and `start > end`.

**Assumptions and limitations**
- The input intervals represent integer numbers only; fractional points are not considered (any non‑integer bound raises an error).
- The algorithm runs in linear time relative to the total number of (non‑empty) intervals after merging.
- All tests run without external dependencies, verifying correctness and error handling as required.