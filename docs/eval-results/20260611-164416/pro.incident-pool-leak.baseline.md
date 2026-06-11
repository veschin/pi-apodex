## Root Cause

**Connection leak in `getUserPrefs`** — the newly added early‑return path (when no rows exist) omits `client.release()`, causing each such request to permanently hold a pool connection. Once the pool maximum (10) is exhausted, subsequent `pool.connect()` calls block until the `connectionTimeoutMillis` (5 s) and then throw `"timeout exceeded when trying to connect"`. The leak grows proportionally with `/prefs` traffic and is reset only by a service restart.

**Confidence: High** — the evidence is self‑consistent and alternative explanations are far less plausible.

---

## Evidence Chain

1. **Code change** – The deploy diff shows the `res.rows.length === 0` branch returning without releasing the client:
   ```js
   if (res.rows.length === 0) {
       return DEFAULT_PREFS;   // client never released
   }
   ```
   (A `parsePrefs` exception on the other branch would also leak, but the early‑return path is the acute new source.)

2. **Database‑side observation** – During the incident, `pg_stat_activity` shows exactly **10 connections** (the pool maximum), all `state='idle'`, several with `state_change` older than 20 min. These connections are held but not performing any work — precisely what a leaked client would look like.

3. **Pool metrics** – The pool’s `acquired` counter rises while `released` plateaus. The gap grows with `/prefs` traffic, matching the expected behaviour of a leak on that endpoint.

4. **Logs** – The pool logs `waiting for available connection (queue depth 37)` and the API returns HTTP 500 with a connection‑timeout error after ~5 s = `connectionTimeoutMillis`. This is the hallmark of pool exhaustion.

5. **Time‑to‑failure** – The incident repeats ~40 min after every restart. With flat traffic, that is the duration needed for the `/prefs` traffic (hitting the early‑return path) to leak 10 connections.

6. **Restart clears it** – A restart closes all connections (leaked and healthy), resetting the pool to zero until leaks accumulate again.

---

## Competing Hypotheses & Why They Are Unlikely

| Hypothesis | Evidence against it | Discriminating action |
|------------|---------------------|------------------------|
| **pg‑pool version regression (3.6.1 → 3.7.0)** | The leaked connections are idle, not stuck in a query. The code bug is obvious and sufficient. A version‑only regression would not correlate exclusively with `/prefs` traffic. | Rollback of pg‑pool while keeping the code – the leak would persist. Fixing the release eliminates it regardless of version. |
| **Slow queries or query storms** | No slow‑query alerts, DB CPU < 20 %, and `pg_stat_activity` shows idle, not active, connections. | Profiling all queries – would not explain idle, long‑held connections. |
| **Network/connectivity problems** | Idle connections with old `state_change`; no TCP errors or connection drops. | Tracing TCP connection lifecycles – would not show the observed idle pattern. |
| **`parsePrefs` throw causing leak** | Contributes, but does not explain the onset tied strictly to the new deploy: adding the early‑return path created the primary surge. If parse exceptions were common enough to exhaust the pool, we would have seen similar incidents before the code change. | Instrumenting the exception rate – high parse errors could be a secondary leak, but the early‑return path is the dominant cause. |

---

## Minimal Safe Verification Step Before Any Fix

**Observe the pool’s internal state on a live (or canary) instance** without altering application code or restarting:

- Expose a temporary internal endpoint or use existing instrumentation to query the PG pool’s exact counts (e.g., `pool.totalCount`, `pool.idleCount`, `pool.waitingCount`) via the same runtime.
- During a known‑quiet minute, fire a single `/prefs` request for a user known to have no row (empty response). Then immediately re‑read the counts.  
  **Expected:** `totalCount` has increased by 1, `idleCount` has **not** increased, and no corresponding `released` counter increment appears. The connection remains “checked out” forever.  
- Correlate with the database view (`pg_stat_activity`) to confirm the new connection appeared but never returned to idle in the pool.

That reproducible, one‑request proof eliminates all competing hypotheses and requires zero code changes. Once confirmed, the fix (adding `client.release()` before the early return, preferably inside a `try`‑`finally`) can be deployed with confidence.