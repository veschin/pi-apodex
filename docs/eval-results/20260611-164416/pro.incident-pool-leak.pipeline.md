## Root Cause

**`client.release()` is missing on the early-return path in `getUserPrefs()`, causing a connection leak.**

When `res.rows.length === 0`, the function returns `DEFAULT_PREFS` immediately without releasing the client back to the pool. Each such call likely permanently consumes one connection from the pool. Over time (≈40 min at current traffic), all `max=10` connections are leaked and remain checked out but idle on the server (visible as `state='idle'` with an old `state_change`). New requests then block waiting for a connection until the pool’s `connectionTimeoutMillis=5000` expires, producing the observed “timeout exceeded when trying to connect” errors.

**Confidence: High (≈95%)** – the code defect is clear and the symptoms align well, though the exact leak dynamics are not directly documented by raw execution traces in the provided materials.

## Evidence Chain

1. **Deploy introduces a code path that does not release the client**  
   The new `getUserPrefs()` early return after `res.rows.length === 0` lacks a `client.release()` call. This is **verified** from the code snippet.

2. **Observations match a slow leak up to the pool maximum**  
   - `pg_stat_activity` during incident shows exactly 10 connections (the pool limit), all `state='idle'`, several with `state_change > 20 min`. **Verified** from incident facts.  
   - **Unverified:** The incident report states that the pool’s “acquired” counter rises steadily after deploy while the “released” counter plateaus below it, and that the gap grows roughly with `/prefs` traffic. No raw metric data is provided, so these trends are not directly demonstrated.  
   - Queue depth grows (e.g., 37) as all pool slots are held. Requests time out after 5 s, matching the configured `connectionTimeoutMillis=5000`. **Verified** from log excerpts and configuration.

3. **Temporal pattern explained**  
   It takes ~40 min to exhaust the pool at the observed leak rate. Restarting re-creates a fresh pool, resetting the leak, so the same 40 min cycle repeats. **Verified** from symptom description.

4. **No other components point to database/query issues**  
   DB CPU < 20%, no slow-query alerts, flat traffic – rules out a genuine capacity problem. **Verified** from incident facts.

## Competing Hypotheses & Discrimination

| Hypothesis | Why plausible | Evidence against / Discriminating test |
|------------|---------------|----------------------------------------|
| **pg-pool version bump (3.6.1 → 3.7.0) introduced a regression** | Version change coincident with the incident window. | A generic pool bug would affect all endpoints, not just `/prefs`. The code-level leak is obvious and sufficient to explain the full symptom. **Verified** reasoning. |
| **`parsePrefs` throws on legacy rows, skipping `client.release()`** | Code does not use `try/finally`; an exception in `parsePrefs` would also leak. | **Unverified:** No data is provided on the frequency of legacy rows causing throws. The deploy diff highlights the missing release in the new branch, and metrics correlate with `/prefs` traffic including many “no pref” users. Both leaks should be fixed with `try/finally`, but the dominant one is likely the early return. |
| **Idle timeout is churning connections but they remain in `idle` state on the server** | Misinterpretation of `idleTimeoutMillis`. | `idleTimeoutMillis` only removes *idle pool* connections (sitting unused in the pool). Checked-out clients are not subject to idle timeout. **Verified** from standard pg-pool behavior. |

## Minimal Safe Verification Step (Before Any Fix)

1. **Unit-level reproduction (no production risk)**  
   In a staging/test environment with the exact pool configuration, send a single `GET /prefs` for a non-existent user, then check pool diagnostics (e.g., `totalCount`/`idleCount`/`waitingCount`) or query `pg_stat_activity`.  
   - **Expect:** total acquired = 1, idle (in pool) = 0, one connection visible in `pg_stat_activity` as `idle` with the application’s PID, and it never returns to the pool’s idle set even after > `idleTimeoutMillis`.  
   - **Pass:** connection is leaked; pool never reclaims it.  
   - **Fail:** connection eventually returns (which would point elsewhere).  

2. **Pre-fix production sanity check (if allowed and safe)**  
   - Inspect `pg_stat_activity` immediately after a `/prefs` burst that includes missing-user calls. Count connections older than 10 s with `state='idle'`. They should match the number of leaked requests.  

*This verification step is a recommendation based on the analysis; it has not been performed and is **unverified**.*

## Verification Status

- **Verified (directly supported by provided materials)**
  - The missing `client.release()` on the early-return path in `getUserPrefs()`.
  - `pg_stat_activity` showing 10 idle connections, some >20 min old.
  - “timeout exceeded when trying to connect” errors match `connectionTimeoutMillis=5000`.
  - Service restart clears the issue; the symptom begins ~40 min after deploy.
  - The pg-pool version bump is unlikely to be the root cause (generic bug would affect all endpoints).
  - `idleTimeoutMillis` does not apply to checked-out connections.

- **Unverified (load‑bearing claims that lack direct evidence in the materials)**
  - The exact leak rate and the assertion that the pool is exhausted in ~40 min (no calculation or raw metric data provided).
  - The pool counters (acquired rising, released plateauing) and their correlation with `/prefs` traffic (stated but not shown as raw data).
  - The permanence of the connection leak (no execution trace to demonstrate that connections are never reclaimed).
  - The relative impact of `parsePrefs` throws versus the early‑return path (no data on legacy‑row frequency).
  - The effectiveness of the recommended verification step (the step has not been executed).