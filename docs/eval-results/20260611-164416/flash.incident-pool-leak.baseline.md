## Root Cause

The `getUserPrefs` function acquires a client from the pool but fails to release it when the query returns zero rows (the new fast path). This leaks one connection per call with no matching prefs.

```js
async function getUserPrefs(userId) {
  const client = await pool.connect();
  const res = await client.query("SELECT prefs FROM user_prefs WHERE user_id = $1", [userId]);
  if (res.rows.length === 0) {
    return DEFAULT_PREFS;            // LEAK: client.release() never called
  }
  const prefs = parsePrefs(res.rows[0].prefs); // may also throw, causing leak
  client.release();
  return prefs;
}
```

**Confidence: 95%**

---

## Evidence Chain

1. **Leak indicators in metrics and logs**  
   - Pool `acquired` counter rises steadily; `released` plateaus below it – gap grows with `/prefs` traffic.  
   - During incident: `[pool] waiting for available connection (queue depth 37)` with max=10 connections.  
   - All 10 connections in `pg_stat_activity` are `idle` and several have not changed state for >20 minutes.  
   - After a service restart the problem resets, then reappears ~40 min later (time to exhaust the pool given traffic and leak rate).

2. **Code change pattern**  
   The new code added an early return that bypasses `client.release()`. This is a classic connection leak. Even without knowing the traffic mix, the monotonic growth of the acquire/release gap confirms a consistent release failure.

3. **Idle connections at DB side**  
   The leaked connections appear as `idle` in Postgres because they are not executing a query, but they are still checked out from the pg-pool perspective – the pool’s idle-timeout never fires because the client object is not released back.

4. **Timing**  
   With a pool of 10, each leaked connection reduces available resources. Under flat traffic the pool exhausts in a deterministic time (≈40 minutes based on request rate). Restart resets the pool and the cycle repeats.

---

## Competing Hypotheses

| Hypothesis | Why Less Likely | Discriminating Evidence |  
|------------|----------------|------------------------|  
| **`parsePrefs` throws on legacy rows, skipping `release`** | Could cause sporadic leaks, but the steady monotonic gap suggests a path taken *every* request (e.g., the no‑prefs path). Throwing would be inconsistent and harder to explain the linear gap. | If the gap correlates with total `/prefs` requests rather than only those with legacy rows, the early return is the main culprit. |  
| **pg-pool 3.7.0 introduced a bug that silently holds connections** | The leak pattern is fully explained by the missing `release` in the new code. No other pool changes (e.g., draining, event handling) are likely to produce a consistent gap that grows with one endpoint. | Rolling back the pg-pool version alone (without reverting the code change) would not fix the leak, confirming the code is the cause. |  
| **A transaction or savepoint left open** | No transaction code is shown; the query is a simple SELECT. DB connections show `idle` not `idle in transaction`. | `pg_stat_activity` state='idle' excludes open transactions. |  

---

## Minimal Safe Verification Step (before any fix)

Do **not** patch the code yet. Instead, add a **one‑wire observation** that confirms the early return path is the source of the unreleased connections.

**Option A – Counter (preferred)**  
Insert a temporary, side‑effect‑free counter in the early‑return branch:

```js
if (res.rows.length === 0) {
  if (typeof global.__leakCounter !== 'number') global.__leakCounter = 0;
  global.__leakCounter++;                // increment on early return
  return DEFAULT_PREFS;
}
```

Then expose this counter via a debug endpoint or log it periodically. Compare its value to the gap between pool `acquired` and `released` (obtainable via pg-pool’s `pool.totalCount - pool.idleCount` or metrics). If the counter equals the gap, the early return is the sole leak.

**Option B – Pool event logging**  
Attach listeners to the pool:

```js
pool.on('acquire', () => console.log('acquire', Date.now()));
// Use a wrapper around client.release() to log
```

Monitor for any client that is acquired but never released, and correlate with the early‑return path (e.g., by logging the request path / user ID). This adds more noise but confirms the exact code path.

**Why this is safe**  
Both options add no functional change – they only observe existing behavior. No risk of altering the leak or affecting production traffic.

**After verification**  
Once confirmed, the fix is obvious: ensure `client.release()` runs in all paths, typically using a `try/finally`:

```js
async function getUserPrefs(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT prefs FROM user_prefs WHERE user_id = $1", [userId]);
    if (res.rows.length === 0) return DEFAULT_PREFS;
    return parsePrefs(res.rows[0].prefs);
  } finally {
    client.release();
  }
}
```

(Also handle the throw from `parsePrefs` – the `finally` block guarantees release.)