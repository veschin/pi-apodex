## Diagnosis of Node.js API Postgres Connection Exhaustion Incident

### Observed Facts (separated from hypotheses)

- **Time pattern**: ~40 minutes after each deploy, requests hang ~5s then fail with `timeout exceeded when trying to connect` from pg-pool. Restart resets the clock.
- **Pool configuration**: `max=10`, `connectionTimeoutMillis=5000`, `idleTimeoutMillis=10000`.
- **pg_stat_activity during incident** (per incident report): exactly 10 connections from the service, all `state='idle'`, several with `state_change` > 20 minutes old. No connections are active or waiting. *(Unverified: this is a reported observation, no raw output provided in materials)*
- **Logs during incident** (verified from provided excerpts):
  - `[pool] waiting for available connection (queue depth 37)`
  - `[api] GET /prefs 500 timeout exceeded when trying to connect`
- **Metrics** (per incident report): `pool.acquired` counter rises steadily after deploy; `pool.released` counter plateaus below it. The gap grows in proportion to `/prefs` request rate. *(Unverified: this is a reported observation, no raw metric output provided)*
- **Deploy diff**:
  - `pg-pool` 3.6.1 → 3.7.0 bump.
  - New `getUserPrefs()` function (shown below).
- **Traffic**: flat; DB CPU < 20%; no slow-query alerts.

### New Code (from deploy)

```js
async function getUserPrefs(userId) {
  const client = await pool.connect();
  const res = await client.query("SELECT prefs FROM user_prefs WHERE user_id = $1", [userId]);
  if (res.rows.length === 0) {
    return DEFAULT_PREFS;            // <-- no client.release() here
  }
  const prefs = parsePrefs(res.rows[0].prefs); // may throw on legacy rows
  client.release();
  return prefs;
}
```

### Most Likely Root Cause (Confidence: 95%)

**Connection leak in `getUserPrefs`** – the function acquires a client from the pool but fails to release it on two code paths (verified by code review):

1. **Early return** when `res.rows.length === 0` — returns `DEFAULT_PREFS` without calling `client.release()`.
2. **Exception in `parsePrefs()`** — if the function throws, `client.release()` is never executed (it’s after the throw, and not inside a `try`/`finally`).

*Unverified inference:* Each such call consumes one of the 10 available connections permanently (no runtime confirmation available, but the code logic and incident pattern strongly suggest indefinite retention). With flat traffic to `/prefs`, the pool is exhausted in ~40 minutes. Once `max` connections are all held (idle from Postgres’ perspective, but still “in use” by the pool and not returned to the idle list), every subsequent request must wait for a timeout (5s) and then fail. Restart releases all connections, resetting the cycle.

### Evidence Chain

1. **Metric discrepancy (per incident report)** – `acquired` rises, `released` plateaus below it. The gap correlates with `/prefs` traffic, pointing to leaks originating from that endpoint.
2. **pg_stat_activity snapshot (per incident report)** – all 10 connections are idle, meaning they are not being used for queries but are still held by the application (pool does not consider them available for reuse). Several have `state_change` > 20 minutes, indicating they were acquired long ago and never returned.
3. **Log queue depth (verified from provided excerpts)** – 37 requests queued for a pool of 10, with all 10 already “allocated” (though idle). Only a connection leak can explain this steady accumulation.
4. **Code review (verified)** – two obvious missing `client.release()` calls present in the new function. The pattern matches the observed behavior exactly: every call that hits either of those paths leaks one connection.

### Competing Hypotheses and Discrimination

| Hypothesis | Evidence against / Discrimination |
|-----------|-----------------------------------|
| **pg-pool 3.7.0 bug** – e.g., `release()` no longer actually releases, or pool management changed. | The leak is verifiably caused by missing `release` calls in the new code. Even if 3.7.0 introduced a regression, the code paths without `release` would still leak. Furthermore, the `released` counter does increase (just not enough), meaning other endpoints release correctly. If release were completely broken, the counter would never increase at all. |
| **Unknown DB-level connection leak** – e.g., TCP keepalive or DB side dropping connections without notification. | `pg_stat_activity` (per incident report) shows all connections still present and idle (not dropped). DB CPU is low; no slow queries. The 40-minute pattern matches the leak rate calculated from traffic, not a DB timeout (which would be irregular). |
| **Increased traffic / concurrency** – more requests than before. | Traffic is explicitly stated as flat. The leak is not due to load but to connection accumulation from the new endpoint. |
| **Unhandled rejection in `parsePrefs()`** – promise rejection not caught, causing process to crash or connection left dangling. | Even if the async function throws, the client is still not released. The leak exists regardless of error handling style. Node.js would log an unhandled rejection, but no such log is mentioned – more likely the error is caught upstream or the API returns 500 via the pool timeout. |

### Minimal Safe Verification Step (Before Any Fix)

The goal is to confirm the leak without modifying production logic. Deploy a **monitoring-only change** that adds structured logging on the two questionable paths. This does not alter the runtime behavior, only observes it. *(This suggestion has not been tested for safety, but it is designed to avoid behavioral changes by adding only log output.)*

**Example implementation** (insert into the current broken `getUserPrefs`):

```js
async function getUserPrefs(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(/*...*/);
    if (res.rows.length === 0) {
      console.warn('LEAK: early return without release for userId', userId);
      return DEFAULT_PREFS;
    }
    const prefs = parsePrefs(res.rows[0].prefs);
    client.release();
    return prefs;
  } catch (err) {
    console.warn('LEAK: exception in getUserPrefs for userId', userId, err.message);
    // Note: client is *not* released here – we are observing the leak, not fixing it.
    throw err;  // propagate to caller (which may then fail with timeout)
  }
}
```

**Why this is safe in principle**: The code still leaks exactly as before. No behavior changes. The logs will show every occurrence of the two leak paths, with timestamps. If the hypothesis is correct, these logs will appear at the same rate as the `acquired`-vs-`released` gap growth. Once observed, the fix (adding `client.release()` in a `finally` block) can be deployed with high confidence.

**Alternative minimal verification** (less intrusive): Add a Prometheus/Grafana counter `prefs_connection_leak` incremented on each leak path. Same effect – no logic change. Choose whichever is easiest to wire up in your stack.

**Important**: Do not yet fix the code. The verification step must only observe, not alter, the leak behavior. This ensures the root cause is definitively pinned before any corrective change.

### Verification Status

- **Verified directly from provided materials**: Code review confirms missing `client.release()` on two paths; log excerpts confirm queue depth and timeout errors. The root cause (connection leak in `getUserPrefs`) is logically consistent with all evidence.
- **Unverified / reported only**: The specific metric counters (`acquired` vs `released`) and the `pg_stat_activity` snapshot are described in the incident report but not independently corroborated by raw output in the materials. The inference that each leak permanently consumes a connection is based on code logic and has not been demonstrated at runtime.
- **Recommendation status**: The verification step (adding logging) is a reasoned suggestion; its safety and effectiveness have not been tested.