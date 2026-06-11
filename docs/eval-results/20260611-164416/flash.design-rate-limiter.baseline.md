## Distributed Rate Limiter Design

### Requirements & Constraints (as understood)

- **10 000 RPS aggregate** across 30 HTTP API gateway nodes (≈333 RPS/node).
- **Redis cluster** available as shared state.
- **Per‑API‑key limit** (e.g., 100 requests/minute) plus a **global service ceiling** (e.g., 10 000 RPS).
- **Added latency budget**: p99 < 5 ms for the limit check.
- **Limits must hold approximately** during node restarts, deploys, and short Redis failures; a small overrun (≤5%) is acceptable during transient events.

### Chosen Algorithm: Token Bucket (Sliding Refill)

Both the per‑key and the global ceiling are implemented as **token buckets**.  
This gives a smooth, burst‑tolerant shape and maps naturally to a simple Redis storage.

#### Rationale for token bucket over alternative algorithms

| Alternative | Reason for rejection |
|-------------|----------------------|
| **Sliding window log** (sorted set of timestamps) | Memory per key grows linearly with the request volume (e.g., 100 entries for per‑key, but 10 000 per second for global). Unacceptable memory and command overhead for the global case. |
| **Fixed window counter** (INCR + TTL) | Allows bursts at window boundaries (e.g., all 100 requests in the first second). Token bucket provides smoother rate, which better approximates a “sliding” limit. |
| **Local‑only token bucket** | State lost on restart; no cross‑node coordination → aggregate limit would be exceeded by a factor of up to 30 nodes. |
| **Centralized rate‑limiter service** | Extra hop adds latency; Redis cluster already provides the needed coordination at lower cost. |

### Data Layout (Redis)

Two key patterns, both using **Hash** data type (small footprint, easy atomic update):

1. **Per‑API‑key bucket**  
   Key: `rate_limit:key:{API_key}`  
   Fields: `tokens` (float), `last_refill` (integer, epoch in milliseconds)

2. **Global bucket**  
   Key: `rate_limit:global`  
   Fields: same as above

**TTL policy**: On every successful update, we set a TTL of `(capacity / refill_rate) * 2` seconds (e.g., for 100 req/min: 120 s). Inactive keys auto‑expire, saving Redis memory.

### Algorithm Details (Lua Script)

All rate‑limit logic is performed in a single atomic Lua script to guarantee consistency and minimise network round trips.

**Script inputs**:
- `global_capacity`, `global_rate` (tokens/ms)  
- `per_key_capacity[i]`, `per_key_rate[i]` (tokens/ms) – *configuration can be stored in a separate Redis hash and read inside the script to avoid passing per‑key parameters for millions of keys.*  
- `now` – obtained from `redis.call('TIME')` inside the script.

**Pseudo‑code**:

```lua
-- 1. Global bucket check & update
local g_key = 'rate_limit:global'
local g_bucket = redis.call('HGETALL', g_key)
local g_tokens, g_last = parse_bucket(g_bucket, global_capacity, now)
if g_tokens < 1 then return 0 end  -- deny

-- 2. Per‑key bucket check & update
local k_key = 'rate_limit:key:' .. ARGV[1]   -- API key
local k_bucket = redis.call('HGETALL', k_key)
local k_tokens, k_last = parse_bucket(k_bucket, per_key_capacity, now)
if k_tokens < 1 then return 0 end  -- deny

-- 3. Both allowed – commit updates
g_tokens = g_tokens - 1
k_tokens = k_tokens - 1
redis.call('HMSET', g_key, 'tokens', g_tokens, 'last_refill', now)
redis.call('HMSET', k_key, 'tokens', k_tokens, 'last_refill', now)
-- set TTL so inactive keys expire (approximate)
redis.call('EXPIRE', g_key, 120)        -- tuned per capacity/rate
redis.call('EXPIRE', k_key, 120)
return 1
```

**`parse_bucket` helper** computes:
```
tokens = min(capacity, tokens_old + (now - last_refill) * rate)
```
If the bucket does not exist, initialise with `capacity` and `last_refill = now`.

**Why read‑modify‑write inside Lua?**  
Lua scripts are atomic; no races between the check and the commit. The script returns 0 or 1, and the gateway node can immediately allow or deny.

### Latency Calculation

- Network round‑trip between gateway and Redis cluster (same DC): median ≈0.5 ms, p99 ≈1 ms.
- Lua script execution: ~0.1 ms for the simple token‑bucket logic.
- **Total p99 < 2 ms** – well under the 5 ms budget. The remaining budget can absorb occasional Redis cluster reconfiguration or GC pauses.

### Failure Handling

| Failure Mode | Handling & Impact |
|---|---|
| **Redis node unreachable** (network partition/crash) | Gateway circuit‑breaker: after 3 consecutive timeouts, stop calling Redis and return **503 Service Unavailable**. Limits are not degraded because no requests pass. *Trade‑off: availability lowered, but system remains safe.* |
| **Redis cluster master failover** | During failover (seconds) requests to that slot fail; circuit‑breaker kicks in. Redis cluster clients (e.g., `ioredis`) recover automatically after election. |
| **Global hot key** | The global bucket key lives on a single node in the cluster. At 10 kRPS the node is comfortable (Redis can handle >100 k ops/s). If needed, **shard the global limit** across 4–8 keys (e.g., `rate_limit:global:{shard}`) and use a **straw‑man aggregation**: each gateway picks a shard based on node ID; total throttle is ≈ `shard_capacity * num_shards`. Over‑run at most `num_shards` tokens per refill, acceptable for “approximate” limits. This option is **rejected for initial design**; documented as operational tuning knob. |
| **Clock skew** | Lua script uses Redis `TIME` (server time), which is consistent across cluster. No client clock needed. |
| **Node restart / deploy** | Local state is irrelevant; Redis holds the authoritative counter. After restart the gateway starts fresh with an empty local cache (if used) but still queries Redis. No over‑count beyond the normal script atomicity. *If Redis also restarts* (less common), counters reset – global limit would allow a burst until the token bucket refills. Acceptable because limits are “approximate”. |
| **Redis OOM** | Eviction policy: prefer **allkeys‑lfu** or **volatile‑lfu** (we use EXPIRE). Token bucket keys are small; under extreme memory pressure, inactive keys are evicted first – they will be re‑initialised on next request, causing a temporary over‑allowance of one bucket capacity. Acceptable. |

### Operational Concerns

- **Configuration**: Per‑key capacity & refill rate stored in a separate config Redis hash (or external config service) and fetched by the Lua script on first use, then cached.
- **Monitoring**:
  - Metric: `rate_limit_decision{allow, deny, type="global"|"per_key"}` per gateway.
  - Redis latency percentiles.
  - Circuit‑breaker state (open/closed).
- **Load testing**: Validate with real production traffic at target rates. Verify p99 latency < 5 ms and that combined per‑node token buckets respect the global ceiling within 5% during rolling deploys.
- **Cost**: Token bucket keys for millions of API keys fit comfortably in a moderate‑sized Redis cluster (e.g., 6–12 GB memory). TTL ensures unused keys are evicted.

### Rejected Alternatives (Summary)

| Alternative | Reason |
|-------------|--------|
| **Sliding window log (sorted set)** | Memory and script complexity too high for global 10 kRPS. |
| **Fixed window counters** | Burst at window edges is undesirable; token bucket provides smoother shape. |
| **Local‑only rate limiter** | Cannot enforce the global ceiling across 30 nodes. |
| **Separate Lua scripts for global and per‑key** | Two round trips would exceed the 5 ms budget p50. Combined script avoids that. |
| **Pre‑computed sharding of global bucket** | Added complexity; not needed at 10 kRPS. Documented as future scalability option. |

### Unverified (but confident) Assertions

- The combined Lua script’s performance on a real Redis cluster under load was not measured in this design; numbers are based on public benchmarks and typical DC latencies.
- The EXPIRE times (120 s) are a starting point; they should be tuned after observing key churn.

This design satisfies all constraints: p99 < 5 ms, approximate limit holding during restarts, and clear failure handling.