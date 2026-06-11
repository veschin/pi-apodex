## Most Likely Root Cause

**Cache stampede (thundering herd) caused by simultaneous TTL expiration of the "catalog:landing:v2" key.**

The 600‑second TTL forces an expiration every 10 minutes. When the key disappears from Redis, every concurrent request on all 12 instances sees a cache miss and independently executes the expensive 1.2‑second DB query. The resulting 300–700 simultaneous queries saturate the DB (CPU 100%) and produce the observed latency spike. Once the first successful query finishes and sets the key, subsequent queries still in flight also SET the same key (explaining the hundreds of SETs), but the damage is already done.

### Confidence Level: ~95%

The evidence chain is strong, periodic, and excludes other common causes.

---

## Evidence Chain

| Observed fact | Implication |
|--------------|--------------|
| Spikes occur **exactly every 10 minutes** (600 s) | Matches the TTL of the key. |
| Redis `GET catalog:landing:v2` returns **nil at the start** of each spike | The key has expired (or was evicted). |
| DB logs show the **same aggregate query** running 300–700 times concurrently from **all 12 instances** | Every instance (and many requests) received a cache miss simultaneously. |
| Multiple `SET` of the same key arrive ~1–2 s after the first SET | The DB query completes in ~1.2 s; each successful query writes back, but no earlier request acquired a lock or won the race. |
| No correlation with GC pauses, cleanup cron, or other jobs | The pattern is driven solely by cache expiry, not background processes. |

---

## Competing Hypotheses (and why they are less likely)

1. **External cache invalidation** (e.g., a manual `DEL` or an admin script)  
   *Evidence to discriminate*: Check Redis slow log / monitor for `DEL` commands around the spike times. If none are present, this hypothesis is eliminated.  
   *Why less likely*: The regularity (every 600 s) and the fact that `GET` returns `nil` (not `DEL`) point to TTL expiration.

2. **Redis memory pressure leading to eviction** (LRU/volatile-lru)  
   *Evidence to discriminate*: Check Redis `INFO memory` for evicted keys count and `maxmemory`. If evictions occur sporadically, they would not produce the strict 10‑minute cadence. Also, the key would be evicted, not expired; Redis `TTL` would still show a value until eviction, but you would see `(nil)` on `GET`. However, the periodic timing makes TTL far more probable.

3. **Application bug:** a deliberate `EXPIRE` or `DEL` in the code path unrelated to normal caching.  
   *Evidence to discriminate*: Audit application code for any `DEL` or `EXPIRE` call on that key. The cadence and the “nil at start” pattern still match TTL, not an explicit delete (which would not be tied to 600 s unless the code also counts TTL).

4. **Cron job** (the described one or another)  
   *Evidence to discriminate*: The cleanup cron uses a different DB user (`cron_ro`) and does not interact with the catalog cache. No other cron with matching timing was found. This hypothesis is essentially ruled out.

---

## Minimal Safe Verification Step (before any fix)

**Monitor the key’s TTL in real time and confirm it reaches 0 exactly at the spike start, with no intervening `DEL` operations.**

Implementation (safe, read‑only, no production risk):

1. Run a small script (e.g., `redis-cli` with `--intrinsic-latency` or a quick `while` loop) that every **100 ms** executes:  
   ```
   TTL catalog:landing:v2
   ```
   and logs the result with a timestamp.

2. Also subscribe to Redis **key‑expiry events** (if already enabled) or run a monit that watches for `DEL` commands via `MONITOR` for a short window.

3. Overlay the TTL trace with the DB CPU and p99 latency graphs.

**Expected outcome:**  
- TTL counts down linearly from 600 s to 0 s.  
- At the moment TTL reaches 0 (or the key disappears), the `GET` returns `nil`, and the DB query concurrency spikes.  
- No `DEL` or other invalidation commands are seen.

If this pattern holds, the root cause is confirmed. If the key disappears *before* TTL reaches 0 (e.g., still shows 10 s remaining), then eviction or an explicit delete is the cause and should be investigated further.

**Why this is minimal:**  
- It is read‑only and imposes negligible overhead.  
- It immediately confirms or refutes the primary hypothesis.  
- It requires no code changes, no configuration modifications, and no service restart.

---

### Next Steps after Verification

Once the cache stampede is confirmed, the fix should prevent concurrent cache rebuilds. Common approaches:

- **Lock/mutex around the cache rebuild** (e.g., Redis `SET NX` with an expiry shorter than the DB query timeout, so only one instance builds the cache).  
- **Stagger the TTL** by adding a small random jitter (e.g., 600 ± 60 seconds) to avoid simultaneous expiration across instances.  
- **Proactive refresh** (background job re‑populates the cache just before the TTL expires, keeping the key alive).  
- **Use a read‑through cache** (e.g., Redis client that serializes rebuilds).

The verification step above should be safe to execute immediately without risking further degradation.