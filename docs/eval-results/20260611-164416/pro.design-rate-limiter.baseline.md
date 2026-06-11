## Distributed Rate Limiter Design (Public HTTP API)

### 1. Requirements & Constraints (as understood)

- **Traffic**:~10,000 RPS aggregate across 30 API gateway nodes.  
- **Storage**: A Redis cluster is available as shared state store.  
- **Limits**:  
  - Per API-key limit, e.g. 100 requests per minute.  
  - Global service ceiling (upper bound on total traffic).  
- **Latency budget**: p99 < 5 ms added by the rate‑limiting check.  
- **Restart/Deploy**: Limits must hold *approximately* even during node restarts and rolling deploys. State must survive gateway restarts.  
- **Consistency**: Exact transactional guarantees are not required; small deviations are acceptable, but burst‑exploitation beyond 2× should be avoided.

### 2. Chosen Architecture

```
  Request → Gateway (middleware) → ┬ per‑key check (Redis) ┐
                                   ├ global check   (Redis) ┤ → 429 or proceed
                                   └────────────────────────┘
```

- Rate‑limiting logic is embedded as a middleware in each gateway.  
- **No separate limiter service** – avoids extra hop and single point of contention.  
- Both checks are executed as **concurrent Redis calls** (one per key, one global) to keep latency close to max(call1, call2).  
- The atomicity of each check is guaranteed by **Lua scripts** running inside Redis, so no client‑side locking is needed.

### 3. Algorithm & Data Layout

We use a **token bucket** for both per‑key and global limits. Token buckets admit smooth, predictable traffic, allow a configurable burst, and avoid the boundary‑burst problems of fixed‑window counters.

#### 3.1 Token Bucket State (per‑key and global)

Each bucket is stored as a **Redis Hash**:

| Field    | Type   | Meaning                         |
|----------|--------|---------------------------------|
| `tokens` | string | Current token count (float)     |
| `last`   | string | Last update timestamp (seconds) |

- Per‑key bucket key: `rl:key:{api_key}`  
- Global bucket key: `rl:global`  

**TTL**: Per‑key hashes get an expiry of 120 s (clean‑up of idle keys). The global hash has a long TTL (e.g., 3600 s) and is renewed on every check – it never expires in practice.

#### 3.2 Lua Script (the core of both checks)

The same script is used for any bucket; parameters are passed as arguments.

```lua
-- KEYS[1] = bucket key
-- ARGV[1] = rate (tokens/second, float)
-- ARGV[2] = capacity (maximum tokens)
-- ARGV[3] = requested tokens (1)
-- Return: 1 => allowed, 0 => rejected

local key       = KEYS[1]
local rate      = tonumber(ARGV[1])
local capacity  = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])

-- Fetch existing bucket; default to full capacity at "now".
local now = redis.call("TIME")[1]   -- seconds
local bucket = redis.call("HMGET", key, "tokens", "last")
local tokens = tonumber(bucket[1]) or capacity
local last   = tonumber(bucket[2]) or now

-- Refill
local delta = math.max(0, now - last)
local new_tokens = math.min(capacity, tokens + delta * rate)

if new_tokens >= requested then
    new_tokens = new_tokens - requested
    redis.call("HMSET", key, "tokens", new_tokens, "last", now)
    -- Keep idle per‑key buckets from persisting forever;
    -- the global bucket gets a longer TTL.
    if key:sub(1,7) ~= "rl:global" then
        redis.call("EXPIRE", key, 120)
    end
    return 1
else
    return 0
end
```

**Why use `TIME` inside the script?**  
Using Redis’ own clock avoids clock‑skew issues between gateways. The script is single‑threaded, so `now` is consistent.

#### 3.3 Configuration

- Per‑key limits: hardcoded or fetched from a config store (can be the same Redis cluster, e.g. a `rl:config:{api_key}` hash).  
- Global limit: either hardcoded or stored under `rl:config:global`.  
Changes are reloaded periodically (e.g. every 60 s) in the gateway without restart.

### 4. Achieving the p99 < 5 ms Latency Budget

Two Redis calls per request; they are **issued concurrently** to the responsible cluster nodes. The total added latency is the **maximum** of the two, not the sum.

- **Assumed network**: Gateways placed in the same region/VPC as the Redis cluster, with a typical RTT p99 < 1 ms.  
- **Script execution**: O(1), around 100 µs per evaluation.  
- **Overheads**: I/O multiplexing, response parsing – negligible.

Thus p99 latency ≈ max(p99(per‑key), p99(global)) < 2 ms in normal operation, well inside the 5 ms budget.

### 5. Failure Handling & Approximate Correctness

#### 5.1 Redis temporarily unreachable (timeout/circuit‑breaker)

- **Fail‑open** after a short timeout (e.g. 3 ms): the request is allowed.  
- *Rationale*: a public API should prefer availability; a brief Redis outage should not break the service. Bucket state is lost only for the outage duration; after recovery the system converges.  
- **Alerting** on elevated allowed‑during‑failure counters.

#### 5.2 Redis node restarts / failover

- With a clustered setup (or Sentinel), a replica takes over.  
- If replication is asynchronous, the latest token counts might roll back slightly → temporary capacity burst **up to the full bucket capacity**.  
  - Per‑key burst: 100 req (acceptable).  
  - Global burst: 10 k req (acceptable for short times).  
- If absolute durability is required, one could use `WAIT` with >1 replica before returning from the script, but that adds latency; we reject it for the p99 budget.

#### 5.3 Script errors / corner cases

- Any unexpected error (bug, `redis.call` failure) is caught in the client; we **fail open** and log.  
- `TIME` returns integer seconds; the bucket’s `last` can be a float for sub‑second precision if needed, but 1‑s granularity is sufficient for rates like 100 req/min (1.66 tok/s). We accept that the bucket may overshoot by at most `rate` during the first second of a burst.

#### 5.4 Gateway node restarts or rolling deploys

- Rate‑limit state lives purely in Redis; gateway restarts have zero impact on limits.  
- Local caches (e.g. limit configs) are warm‑loaded on startup, with a short fallback while loading: if config not available, the node can use a safe default.

### 6. Operational Concerns

- **Monitoring**:  
  - Per‑key and global `allowed`/`denied` counters, exported to metrics.  
  - Redis call latency histogram.  
  - Redis errors/failures counter → alert if > 0.1% of requests.  
- **Boundary testing**: Validate that the token bucket does not admit > capacity even under high concurrency (the Lua script is atomic).  
- **Cost of Redis ops**: 10 k aggregate RPS → ~20 k Lua script calls/s. A modest Redis Cluster (3 nodes) can handle many times that.  
- **Token bucket parameters**:  
  - Per‑key: rate = 100/60 ≈ 1.667 tok/s, capacity = 100 (allows an instantaneous burst of 100, then one request every ~0.6 s).  
  - Global: rate = 10 000 tok/s, capacity = 10 000 (burst of 10 k).  
- **Global hot‑key**: `rl:global` receives ~10 k ops/s on a single shard. This is well within Redis’ capability (~100 k ops/s). If scaling ever demands it, one can shard the global bucket by hashing the request ID (e.g., request fingerprint) across a fixed number of partitions and use a smaller capacity per partition; the token bucket approach still works. However, today’s load doesn’t justify that complexity.

### 7. Rejected Alternatives

| Alternative | Reason for rejection |
|-------------|----------------------|
| **Fixed‑window counter** (key = `rl:{api_key}:{window_id}`) | Allows up to 2× the limit at window boundaries. For a per‑key limit as low as 100/min, a 200‑request spike is undesirable. |
| **Sliding window log** (sorted set per key, trimming old entries) | Higher Redis memory and CPU per request; not needed for an “approximately” correct limit. Token bucket is simpler and O(1). |
| **Dedicated rate‑limiter service** | Adds an extra network hop and a new service to scale; it would push the p99 latency beyond 5 ms. Embedding in gateways with shared Redis avoids this. |
| **Allowing burst with `SET NX` + `INCR`** (simple counter with TTL equal window) | Resets on first request after expiry, leading to unpredictable burst windows; also suffers from boundary bursts when TTL expires. Token bucket provides cleaner semantics. |
| **Using client‑side local token authorities** (e.g., each gateway syncs with Redis periodically) | Drastically reduces Redis load but makes the global ceiling approximate within a sync interval; can be hard to tune and still requires a sync mechanism. For 10 k RPS, direct Redis access is simpler and more precise. |

### 8. Summary

The design uses atomic token‑bucket scripts in a Redis cluster, with concurrent per‑key and global checks, meeting the 5 ms p99 budget. State persistence in Redis ensures that limits are approximately maintained across gateway restarts and deploys. Failure modes are handled by a carefully reasoned “fail‑open” policy, and monitoring provides visibility into the limiter’s health. The token‑bucket algorithm avoids boundary‑burst artefacts and gives a smooth, predictable rate‑limiting behaviour.