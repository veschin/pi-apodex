## Root Cause Diagnosis

**Most Likely Root Cause:** Cache stampede (dogpile) triggered by the disappearance of the Redis key `catalog:landing:v2` every ~10 minutes. Natural TTL expiry is the most plausible mechanism (TLT 600 s = 10 min), though external deletion or eviction cannot be entirely ruled out without the verification step below.

**Confidence:** High (95 %)

The payload is cached with a 600‑second TTL. Every 10 minutes the key disappears; all service instances then hit an empty cache almost simultaneously and launch the same expensive aggregate query independently. The resulting flood of 300–700 parallel queries saturates the database CPU, raising p99 latency from 40 ms to 3–8 s for ~15 seconds and causing the 10‑minute spike pattern.

---

## Evidence Chain

1. **Periodicity matches TTL** – 600 s = 10 min; spikes recur exactly every ~10 minutes, consistent with the TTL timing.
2. **Redis GET returns nil** at the start of every spike – confirms the cache is empty at those moments.
3. **First SET appears ~1–2 s later** – aligns with the normal 1.2 s query time; the first instance to finish populates the cache.
4. **Hundreds more SETs follow immediately** – all other instances that also experienced a miss complete and redundantly write the same key.
5. **DB logs show 300–700 concurrent executions of the same aggregate query** – consistent with 12 instances each receiving many concurrent requests during the cache‑miss window.
6. **Primary DB CPU hits 100 %** during the spike – the flood of concurrent aggregate queries overwhelms the CPU, which likely extends individual query execution times from 1.2 s to multi‑second waits, producing the observed latency spike.
7. **p99 latency jumps from 40 ms to 3–8 s** – the normal cache‑hit path is fast (~40 ms); the miss path includes the DB query, and under heavy load queries become very slow.
8. **GC pauses are low (≤45 ms) and uncorrelated** – rules out GC as the cause.
9. **Cron job shows no DB activity** and reportedly only deletes temp files – no evidence it touches Redis or the DB during spikes.

All observations fit a self‑inflicted stampede driven by the key’s disappearance in sync with its TTL.

---

## Competing Hypotheses & Discrimination

| Hypothesis | Supporting evidence (if true) | Evidence against | How to discriminate |
|------------|-------------------------------|------------------|----------------------|
| **1. Cron job explicitly deletes the cache key** | The 10‑minute interval matches a cron schedule. | – Cron job is documented to delete only temp files.<br>– DB user `cron_ro` shows zero queries during the spike.<br>– No Redis `DEL` observed; the `GET` returns nil at moments that align with the key’s TTL, consistent with expiry rather than a forced mid‑life deletion. | Monitor Redis `DEL` for the target key using keyspace notifications (e.g., `Psubscribe` to `__keyevent@0__:del`) or TTL monitoring (see verification step). If the key vanishes while TTL > 0, an external delete occurred. |
| **2. Redis eviction under memory pressure** | If memory is tight and an `allkeys-*` eviction policy is active, the key could be evicted before TTL. | – Spikes are perfectly periodic; eviction would be bursty and time‑varying, not tightly following a 10‑minute cadence.<br>– No mention of elevated `evicted_keys`. | Check `maxmemory-policy` and the `evicted_keys` metric (`INFO stats`). Evictions near zero and a non‑evicting policy rule this out. |
| **3. Application‑level scheduled cache purge** | Code that explicitly calls `DEL` on the key every 10 min would produce the same symptoms. | The design is cache‑aside, on‑demand, with a 600 s TTL. No mention of a purge timer. | Static code inspection for any `DEL` of that key name. |

The TTL‑expiry stampede explains every observation without invoking unseen actors. The competing hypotheses are easy to eliminate with lightweight checks.

---

## Minimal Safe Verification Step

Before applying any fix, conclusively determine whether the spike is triggered by natural expiry or by an external deletion/eviction.

### Verification that avoids performance risk

**1. Real‑time TTL monitoring**
```bash
while true; do
  redis-cli TTL catalog:landing:v2
  sleep 1
done
```
Run this on a monitoring host (not on every service instance). The TTL should count down to **exactly 0** at the onset of each spike. If the key disappears while the TTL is still **> 0**, the cause is an explicit delete or an eviction – not natural expiry. A 1‑second sleep gives sufficient granularity to capture the moment of expiry.

**2. Check Redis eviction metrics**
```bash
redis-cli INFO stats | grep evicted_keys   # should be 0 or low/constant
redis-cli CONFIG GET maxmemory-policy      # should be noeviction or volatile-*
```

If `evicted_keys` is zero (or flat) and the policy does not allow eviction of non‑volatile keys, eviction is eliminated as a cause.

**3. (Optional) Lightweight expiry notification**  
If you need hard proof that an expiry event occurs, you can temporarily enable keyspace notifications for expired events (impact is minimal on a reasonably sized Redis instance, but test in staging first):
```
redis-cli CONFIG SET notify-keyspace-events Ex
```
Then subscribe:
```bash
redis-cli --csv PSUBSCRIBE '__keyevent@0__:expired'
```
You will see `catalog:landing:v2` appear exactly at the moment its TTL expires. Remove the subscription after verification.

All steps above are low‑risk: TTL polling is a single `TTL` command per second, negligible for Redis. Enabling key‑event notifications adds a tiny CPU overhead but does not stream all commands like `MONITOR`, which can severely degrade a high‑throughput instance. Choose the method that best balances safety and evidence needs.

**Interpretation:**  
- If the TTL hits 0 in phase with spikes, **and** evictions are absent, natural expiry is confirmed.  
- If the key vanishes while TTL > 0, an external delete/eviction is happening – in that case investigate the cron, application code, or Redis eviction policy further.

This verification is non‑intrusive, does not alter application traffic, and definitively discriminates the root cause.

---

## Recommended Fix (post‑verification)

Once natural expiry is confirmed, mitigate the stampede with standard patterns:

- **Early recomputation with jitter:** Start refreshing the key a few seconds before expiry, using a random delay so only one instance rebuilds.
- **Locking on rebuild:** Use `SET NX` with a short TTL as a lock; other instances serve stale data or wait briefly.
- **Stale‑while‑revalidate:** Extend the logical life of the cached value (e.g., keep a “soft” TTL) so that a single background refresh can occur without breaking the serving path.

These fixes eliminate the stampede while keeping the cache fresh. The verification step ensures the fix targets the right cause.

---

## Verification Status

**Observed/verified:**  
- The cache key `catalog:landing:v2` has a 600‑second TTL (task fact).  
- Every ~10 minutes, p99 latency spikes from 40 ms to 3–8 s for ~15 seconds, and the primary DB CPU hits 100 % (task fact).  
- Redis `GET` returns nil at the start of each spike, followed by many `SET` commands (task fact).  
- DB logs show 300–700 concurrent executions of the same aggregate query during spikes (task fact).  
- GC pauses are ≤45 ms and uncorrelated with spikes (task fact).  
- The cleanup cron shows no DB activity and only handles temp files (task fact).  

**Remains unverified:**  
- Whether the key disappearance is definitively due to natural TTL expiry or an external deletion/eviction.  
- The exact causal chain from concurrent queries to multi‑second individual query latencies, though the correlation is strong.  
- The proposed verification step has not yet been executed; it is a plan to resolve the above unverified items.