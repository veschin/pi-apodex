## Root Cause Diagnosis

**Most Likely Root Cause:**  
**Cache stampede (thundering herd)** on the `catalog:landing:v2` cache key at TTL expiration, caused by the absence of a request-coalescing or lock mechanism in the cache-aside pattern.

**Confidence:** **High** (95%+)

The symptom timing, Redis behaviour, DB query logs, and scale of concurrency are an almost textbook match for a cache stampede.

---

## Evidence Chain

1. **Periodicity matches TTL**  
   TTL = 600 s (10 min). Spikes occur every ~10 min. No other system event runs on that exact cycle except the key’s expiry.

2. **Redis state at spike onset**  
   Monitoring shows `GET catalog:landing:v2` returns `nil` exactly at the start of each spike. This confirms the key has expired, triggering a miss path on all 12 instances.

3. **Uncontrolled concurrent repopulation**  
   During the spike, DB logs capture **300–700 identical aggregate queries** executing concurrently. Each query takes 1.2 s, and all 12 instances (plus multiple request threads per instance) independently see a cache miss and hit the database at the same time. The spike duration (~15 s) corresponds to the time needed for the first few queries to complete and eventually populate Redis, allowing the storm to subside.

4. **Multiple Redis SETs after the first repopulation**  
   After ~1–2 s (the query time + small overhead), a `SET` appears, followed by hundreds more `SET`s of the same key from the remaining in‑flight queries. This matches the behaviour where every concurrent miss eventually writes back, even though only the first write is useful. The volume of SETs is harmless beyond short-term network load, but the DB load is the actual pain point.

5. **No other plausible period‑10‑min trigger**  
   - A cleanup cron runs every 10 min, but its DB user (`cron_ro`) shows **zero queries** during the spike, and it only deletes temp files.  
   - GC pauses peak at 45 ms and show no correlation with the spikes, ruling out GC‑induced latency.  
   - No signs of Redis failures, evictions, or manual deletions – the `nil` is a natural expiry event.

6. **Load pattern consistent with cache-aside**  
   The service uses cache-aside with no locking. The landing payload is served on virtually every request, so after expiry the very next request (or wave of concurrent requests) triggers a set of parallel DB fetches across all instances.

---

## Competing Hypotheses & Discrimination

| Hypothesis | Evidence for | Evidence against |
|------------|--------------|------------------|
| **Cache stampede (primary)** | Exact 10 min period; nil key at spike start; 300–700 identical queries from all instances; no other 10 min DB event. | (None contradict) |
| **DB maintenance / backup** | Could cause 10 min periodic load. | DB logs show only the application’s aggregate query, not maintenance commands. `cron_ro` shows zero DB activity. |
| **External cache deletion** | Could cause a miss storm. | Monitoring shows nil just before spike, but no preceding DEL. The key expires naturally at exactly 10 min, no artificial deletion. |
| **Network/Redis partitioning** | Would also cause cache misses. | Would produce irregular spikes, not strict 10 min cadence. Redis monitoring confirms availability and no errors. |
| **Application GC pauses** | Could briefly halt request processing, causing backlog. | GC pause max 45 ms, far shorter than the spike window, and no correlation with spike timing. |

---

## Minimal Safe Verification Step

**Observe the TTL countdown and correlate it with spike start timestamps.**

1. Use Redis `TTL catalog:landing:v2` repeatedly (e.g., every second) to log the remaining seconds until expiry.
2. Compare the moment the TTL reaches 0 or the key disappears with the exact time the first DB aggregate query appears and the p99 latency rises.
3. Alternatively, enable Redis keyspace notifications for expired events (`notify-keyspace-events Ex`) and log `EXPIRE` on that key. Confirm the events align with spike onset.

If the hypothesis is correct, the spike will begin exactly when the key expires (or within a few hundred milliseconds due to response jitter). This verification is safe, read‑only, and requires no code changes.

---

## Recommended Fix (for completeness)

Once verified, the standard mitigation is to prevent the stampede by ensuring only one request per key performs the expensive regeneration. Common approaches:

- **Request coalescing** (e.g., singleflight in Go, a distributed lock like Redlock with a timeout slightly longer than the query time).  
- **Probabilistic early recomputation** – if possible, serve stale data while asynchronously refreshing before expiry (cache‑stampede prevention pattern).  
- **Extend the TTL** or make the landing page a precomputed, asynchronously refreshed value (e.g., a cron job that refreshes the cache a few seconds before expiry, thus the live traffic never sees a miss).