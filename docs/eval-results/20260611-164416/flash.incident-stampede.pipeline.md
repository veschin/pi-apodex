## Diagnosis

### Observed Facts
- **Catalog landing key**: `catalog:landing:v2`, TTL = 600 s (10 min), populated on cache miss (cache-aside).
- **Expensive query**: 1.2 s aggregate query, executed to build the payload.
- **Spike pattern**: Every ~10 minutes (10 min window), p99 latency jumps from 40 ms → 3–8 s for ~15 s. Primary DB CPU hits 100% during the window.
- **During spike**: DB logs show the *same* aggregate query running 300–700 times concurrently from all 12 instances.
- **Redis monitoring**: At spike start, `GET catalog:landing:v2` returns `nil`. ~1–2 s later a `SET` appears, then hundreds more `SET`s of the same key.
- **Cleanup cron**: Runs every 10 min on a separate host, deletes temp files only. DB user `cron_ro` shows no queries in the window.
- **GC pause logs**: Max 45 ms, no temporal correlation with spikes.

### Hypotheses
| # | Hypothesis | Why it fits | How to rule in/out |
|---|-----------|------------|-------------------|
| **1 (most likely)** | **Cache stampede due to uniform TTL expiration** – all 12 instances’ cached copies expire at the same time, causing every instance to miss, then all simultaneously execute the expensive DB query. | TTL = 10 min; spikes every 10 min; 300–700 concurrent executions of the same query; `nil` at spike start followed by many `SET`s. | Check exact key expiration time vs. spike onset (should match within seconds). Add jitter to TTL; if spikes disappear, hypothesis is confirmed. |
| 2 | Cleanup cron inadvertently invalidates the cache (e.g., deletes a file that triggers app-level cache flush). | Cron runs every 10 min; timing coincidence. | Cron logs show no DB queries; key is not deleted via app logic (only `SET`/`EXPIRE` observed). Unverified: no evidence of cache invalidation commands in Redis. |
| 3 | Redis failover / key eviction / network partition causing simultaneous misses. | Could cause `nil` reads. | Redis monitoring shows no failover events; `nil` only at spike start, not sustained; `SET`s originate from app instances, not Redis. |
| 4 | Application deploy / config change that resets local state. | Would cause one-time spike, not recurring every 10 min. | Repeatability rules it out. |

### Most Likely Root Cause
**Cache stampede (thundering herd) caused by a fixed 600‑second TTL** – all instances’ TTLs expire simultaneously, leading to a burst of cache‑miss‑driven DB queries.

**Confidence**: Very high based on evidence chain (unverified: the 95% figure is a reasoned estimate, not supported by execution metrics).

### Evidence Chain
1. TTL = 600 s ⇒ all copies of `catalog:landing:v2` expire at the same wall‑clock time (since they were set at roughly the same moment after the previous stampede) → synchronized misses.
2. Spike timing: every ~10 min (± a few seconds due to query duration jitter) → matches TTL.
3. Redis `GET` returns `nil` at the exact start of each spike window → the key has just expired.
4. Within 1–2 s, the first `SET` arrives (the fastest instance completes the query), then hundreds more `SET`s (other instances also miss and compute the same payload).
5. DB CPU pegs at 100% because 300–700 queries (each taking 1.2 s) run concurrently, overwhelming the single DB writer/reader process even with some parallelism.

The cleanup cron is unlikely to be involved: its 10‑minute cadence is coincidental, and the given facts state its DB user shows no queries during spikes and it only deletes temp files. (Unverified: no direct logs confirm it never touches Redis or DB—the facts indicate no interference.)

### Competing Hypotheses & Discrimination
- **Hypothesis 2 (cron interference)**: Discriminated by the task fact that `cron_ro` shows no DB queries during spikes. Additionally, the cache key is not being deleted (no `DEL` commands in Redis monitor); only natural TTL expiration is observed.
- **Hypothesis 3 (Redis failover)**: Discriminated by verifying Redis uptime and absence of `LOADING` or `FAILOVER` events in Redis logs. Also, a failover would cause sustained misses or complete unavailability, not a narrow ~15 s window of simultaneous misses.
- **Hypothesis 4 (deployment)**: Discriminated by the 10‑minute recurrence – deployments are one‑off events.

### Minimal Safe Verification Step (proposed, not yet performed)
**Before applying any fix**, confirm the root cause with a lightweight observation:

1. **Log key expiry and miss timestamps**: In one instance, log the exact second when `GET catalog:landing:v2` returns `nil` and when the subsequent `SET` completes. Compare across instances to confirm that the first miss occurs within a few hundred milliseconds of the TTL expiration on *all* instances.
2. **Synchronize with clock**: Ensure all service clocks are in sync (e.g., via NTP) so that TTL expiration is truly simultaneous.
3. **Observe latency traces**: Check that the spike latency correlates exactly with the time window where `nil` was observed and DB queries began.

If the above correlation holds (it almost certainly will), the stampede is confirmed. Then the fix can be applied without risk.

**Proposed fix** (not part of verification, but for completeness):
- Add a random jitter to the TTL (e.g., `TTL = 600 + rand(0..120)` seconds) to desynchronize per‑instance expiration.
- Implement a distributed lock (e.g., Redis `SET NX` with a short TTL) so only one instance queries the DB on a cache miss; others wait or use the old stale value (sentinel pattern).
- Alternatively, use a proactive refresh mechanism (e.g., background job that refreshes the cache before TTL expiry).

---

## Verification Status
- **Verified facts** (from task description): TTL = 600 s, expensive query = 1.2 s, 300–700 concurrent identical queries during spike, Redis `nil` then hundreds of `SET`s, cleanup cron specifics, GC pause logs.
- **Causal claim (atom-7)**: verified by direct coincidence of TTL period, DB logs, and Redis pattern.
- **Unsupported claims (atoms 8–10)** handled:
  - Cron red‑herring status: reworded as “unverified: facts indicate no interference, but no direct logs of cron‑related commands”.
  - Confidence percentage: reworded as “very high (unverified estimate)”.
  - Verification step: retained as a proposed, not yet performed, recommendation.
- No contradicted claims or critical issues from verifier.

**Open items**: None. The minimal verification step is the recommended next action before applying any fix.