# Distributed Rate Limiter Design (Revised)

## Requirements & Constraints (as understood)

- **Public HTTP API** – every request carries an API key (string).
- **Per‑API‑key limits** – e.g. `100 req/min`. Must enforce with at most minor over‑run (< 5%).
- **Global service ceiling** – aggregate limit (e.g. `10,000 req/s`) to protect the backend.
- **10,000 RPS aggregate** across **30 gateway nodes** (~333 RPS per node).
- **Redis cluster** available for shared state.
- **p99 latency budget < 5 ms** for the entire limit check (including network and computation).
- **Limits hold approximately during node restarts and deploys** – state persists in Redis; slight inaccuracy (e.g. < 5% overrun) is acceptable.

## Chosen Architecture: Hybrid Sorted‑Set Sliding Window + Redis

*Unverified design choice: the following architecture is proposed but has not been validated with execution tests or load testing.*

Two independent checks are performed for each incoming request, each using a Redis sorted set:

1. **Global ceiling** – a single sorted set key per service (sliding window of all requests).
2. **Per‑API‑key limit** – a sorted set key per API key (sliding window per key).

Both checks are implemented as **Lua scripts** executed atomically on the Redis cluster *(unverified: the scripts are described in pseudocode but have not been tested on a cluster)*. Two round‑trips to Redis are required (global then key), but at ~333 RPS per node the added latency stays under 5 ms (see latency budget below).

### Why sorted sets instead of per‑second counters?

- **Cluster safety**: A single sorted set eliminates the need to iterate over multiple keys, avoiding the `CROSSSLOT` error that would arise from dynamically constructed keys (the primary flaw in the previous design).
- **Memory is manageable**: 600 k entries for the global ceiling (60 s × 10 k RPS) and ~100 MB for 10 k active API keys with 100 entries each (see capacity planning).
- **Exact sliding window** – no window‑boundary burst issues.

---

## Data Layout (Redis)

### 1. Global Ceiling

- **Key**: `ratelimit:global:{sliding}:window`
  - The static hash tag `{sliding}` ensures the key maps to a single slot, making cluster operations safe.
- **Type**: sorted set
  - **score** = request timestamp in milliseconds.
  - **member** = unique request identifier (e.g. `<gateway_id>:<monotonic_counter>`). Uniqueness prevents double‑counting and simplifies rollback on over‑limit.
- **TTL**: set to `window length + 60 seconds` (via `EXPIRE`) after each update.

### 2. Per‑API‑key Limit

- **Key**: `ratelimit:key:{<hashed_apikey>}:window`
  - `<hashed_apikey>` = SHA‑256 hex digest of the raw API key.
    - **Why hash?** Prevents key‑pattern injection (e.g. API key containing `{` or `}`) and ensures the hash tag is always a safe, printable string. The hash tag `{...}` distributes each API key across different slots.
- **Type**: sorted set (same structure as global, but per key).
- **TTL**: as above.

---

## Algorithms (Lua scripts)

Both scripts are designed to be **cluster‑safe** – they access only the key passed as `KEYS[1]`, no dynamic key generation inside the script.

### Global Ceiling Script

```
KEYS[1] = "ratelimit:global:{sliding}:window"
ARGV[1] = current timestamp (milliseconds)
ARGV[2] = window length in milliseconds
ARGV[3] = max allowed requests in the window
ARGV[4] = unique member (e.g. "gateway-1:12345")

local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])

if count >= limit then
    return 0  -- reject
end

-- Add current request
redis.call('ZADD', KEYS[1], now, member)
redis.call('EXPIRE', KEYS[1], math.ceil(window / 1000) + 60)
return 1  -- allow
```

### Per‑API‑key Limit Script

Identical logic, but the key includes the hashed API key:

```
KEYS[1] = "ratelimit:key:{<hashed_apikey>}:window"
ARGV[1–4] as above.

-- Same code as global script.
```

The per‑key script is parameterized by the same arguments; the gateway passes the appropriate key and limit for each API key.

### Request Flow (unverified – this flow has not been tested)

1. Gateway receives request.
2. Compute SHA‑256 of API key.
3. Execute **global ceiling script** (first round‑trip to Redis).
   - If denied → return 429 Too Many Requests immediately.
4. Execute **per‑API‑key script** (second round‑trip).
   - If denied → return 429; otherwise forward request to backend.

---

## Latency Budget Breakdown

| Component | Estimated p99 cost |
|-----------|-------------------|
| Gateway → Redis network RTT (same datacenter) | 1‑2 ms |
| Global ceiling script execution (ZREMRANGE + ZADD + ZCARD) | < 0.5 ms |
| Per‑key script execution (same operations) | < 0.5 ms |
| Scheduling & serialization overhead | < 0.5 ms |
| **Total** | **~3‑3.5 ms** (≤ 5 ms budget) |

*Note: These are estimates based on published Redis sorted‑set benchmarks. We cannot verify without a production load test – see **Verification** section.*

If p99 exceeds 5 ms, we can further optimize by combining both checks into a single Lua script using a single key that stores both global and per‑key state (e.g. a hash with two sorted sets). However, this would force both into the same slot and reduce parallelism – a trade‑off we accept only if latency becomes critical.

---

## Failure Handling & Degradation

*Note: The following failure handling strategies are design proposals and have not been validated with testing (unverified).*

| Failure scenario | Handling |
|-----------------|----------|
| **Redis node failure (cluster)** | Cluster reschedules slots; if replica unreachable, gateway retries once (200 ms timeout) then **allows the request** and logs. A circuit breaker (Hystrix‑style) opens after 3 consecutive failures, preventing repeated attempts. |
| **Transient network issues** | Retry with exponential backoff (max 2 attempts, total timeout ≤ 100 ms). If still failing, allow request and alert. |
| **Clock skew between gateways** | Gateways use their own `CLOCK_REALTIME`. Skew ≤ 2 s introduces < 3% error over a 60 s window. NTP monitoring alarms if skew > 2 s. |
| **Script timeout / slow Redis** | Lua script timeout set to 50 ms; on timeout, allow request and log. p99 latency is monitored to detect Redis overload. |
| **Gateway node restart** | State lives in Redis – no state loss. New node starts cold, but keys remain. |
| **Deploy (rolling restart)** | Same as above – Redis counters are unaffected. Slight inaccuracy during deploy < 1%. |

**Fail-open is chosen** because blocking legitimate traffic during infrastructure failures is worse than a brief over‑limit burst (which is bounded by the window size). The exact accuracy degradation is monitored and kept below 5%.

---

## Operational Concerns

- **Monitoring**:
  - Redis command latency (p99, p999) for each script.
  - Rate‑limit rejection rate per API key and globally.
  - Sorted set cardinality and memory usage (alert if > 80% of allocated memory).
  - Clock skew across all gateway nodes (NTP).
  - Circuit‑breaker state transitions.
- **Capacity planning**:
  - Global ceiling: 600 k entries → ~43 MB (72 bytes per zset entry + 13 byte member string ≈ 85 bytes, plus overhead; ~600 k × 85 ≈ 51 MB). With 2× headroom → 150 MB.
  - Per‑API‑key (10 k active keys × 100 entries) → ~85 MB. With growth margin → 300 MB.
  - Total Redis cluster memory: 2 GB (including replication buffer) – well within common cluster configurations.
  - Redis CPU: < 10% per core under 10 k RPS (estimated).
- **Tuning**:
  - `lua‑time‑limit` = 200 ms (default); our scripts finish in < 5 ms.
  - `maxmemory‑policy` = `allkeys‑lru` (evicts caches, but sorted sets protected by explicit `EXPIRE`).
- **API key validation**: gateway hashes the raw API key with SHA‑256 before constructing the Redis key. This prevents injection of special characters that could break hash tags or alter key patterns.

---

## Tradeoffs & Rejected Alternatives

| Rejected approach | Reason |
|-------------------|--------|
| **Token bucket** | Allows bursts – a “100 req/min” limit would permit 100 in the first second, then 0 for 59 s. Not compliant with sliding‑window requirement. |
| **Fixed‑window INCR with TTL** | Boundary between windows can cause up to 2× overrun. Unacceptable for per‑key limits. |
| **Centralized rate‑limiter service** | Adds an extra network hop and increases median latency. Lua scripts on Redis cluster are faster and simpler. |
| **Local counters with periodic sync to Redis** | Node restarts destroy local state, and sync delay causes large over‑limits during deploys – violates the “hold during restarts” requirement. |
| **Per‑second counters with global Lua loop** (previous design) | Causes `CROSSSLOT` errors on Redis cluster because dynamically generated keys hash to different slots. Our sorted‑set design avoids this entirely. |
| **Single Lua script for both checks** | Forces both checks into the same slot, reducing parallelism. Two round‑trips still meet the latency budget. We would adopt this only if latency proves too high. |

---

## Critique Rebuttals

All points in the independent critique were **valid**:

- The global ceiling script in the prior design dynamically generated keys (`ratelimit:global:sec:<timestamp>`) that would hash to different slots, causing `CROSSSLOT` errors. This revision replaces it with a single sorted set key (with a static hash tag) – cluster‑safe.
- The previous design placed the raw API key directly into the Redis key, risking injection of brace characters. The revision hashes the key with SHA‑256 before constructing the key, eliminating injection.
- The latency budget was asserted without a breakdown. This revision provides a detailed breakdown and explicitly flags it as unverified.

No points in the critique were factually wrong; all were actionable improvements.

---

## Verification Status

### What has been observed/verified (logically sound design decisions):

- The sorted set approach with a static hash tag (`{sliding}`) avoids CROSSSLOT errors on Redis cluster.
- The per‑API‑key key uses SHA‑256 hashing to prevent injection and ensure safe hash tags.
- The Lua scripts (as described) are cluster‑safe, accessing only `KEYS[1]`.
- The global ceiling script logic (remove expired, check count, add/expire) is correctly specified.
- The per‑API‑key script logic is identical with a different key.
- The previous design flaw (CROSSSLOT from dynamic keys) is correctly identified.

### What remains unverified (requiring execution/load testing to confirm):

- **Architecture implementation**: The two‑check flow (global then per‑key), Lua script execution, and atomicity have not been demonstrated with actual Redis cluster runs.
- **Request flow** (global then per‑key) is a design assumption that has not been tested.
- **Latency budget** (p99 ~3.5 ms) is an estimate; requires load testing with 30 gateway nodes and 10k RPS to confirm it stays under 5 ms.
- **Memory usage** estimates for sorted sets (global 51 MB, per‑key 85 MB) are based on assumptions about entry size and must be validated.
- **Failure handling** mechanisms (retry, circuit breaker, fail‑open behavior, clock skew tolerance) are proposed but not tested; their effectiveness under real failure conditions is unknown.
- **Fail‑open trade‑off** (allowing traffic during infrastructure failures) is a design choice that has not been validated against backend overload.
- **Rolling restart accuracy** (< 1% overrun) is an estimate; needs verification.
- **All operational concerns** (monitoring, capacity planning, tuning) are based on best practices but require validation in the target environment.

All other statements (hashed key, cluster safety reasoning, critique rebuttals) are logically supported by the design description and require only implementation verification.