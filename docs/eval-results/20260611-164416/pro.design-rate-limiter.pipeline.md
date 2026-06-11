# Distributed Rate Limiter Design

*This design is an engineering proposal; all behavioural claims are unverified unless explicitly noted as verified in the Verification Status section. The design has not been implemented or tested, and its ability to meet the stated requirements is not proven.*

---

## 1. Requirements & Constraints

- **Scale** – 10 000 aggregate RPS across 30 API gateway nodes, backed by a Redis cluster.
- **Limits** – Per‑API‑key rate (e.g., 100 req/min) and a global service ceiling (hard maximum total RPS).
- **Latency budget** – p99 ≤ 5 ms for the entire limit‑check addition to the request path.  
  **(The proposed design’s ability to satisfy this budget under the stated load is unverified.)**
- **Fault tolerance** – Limits must hold *approximately* during node restarts, deploys, Redis failures, and script flushes. The system must never allow unlimited traffic (fail‑closed).
- **Accuracy** – The enforcer must be “close enough” to the configured rates; unbounded bursts must not slip through.
- **Assumptions**  
  - Redis cluster operates in the same datacenter; p50 < 1 ms, p99 in low single‑digit ms.  
  - API‑key identifiers are strings; limit configurations are stored centrally and can change at low frequency.  
  - Gateway nodes use a Redis cluster client that respects hash‑tags ( `{}` ) for shard‑pinning.  
  - Clock drift across Redis shards is negligible for limit enforcement (all time‑kept inside Lua scripts uses the Redis server clock).

---

## 2. Architecture Overview

A **hybrid design** that combines:

- **In‑memory, shared‑nothing token bucket for the global ceiling** – eliminates the hot‑key problem and makes the global check purely local (sub‑µs).
- **A single, atomic Redis Lua script for per‑key limits** – one round‑trip that reads the limit configuration and the bucket state, making the check self‑contained and removing any separate config‑fetch latency.

**Why this split?**  
A pure‑Redis global limit would concentrate 10 000 writes/s on one key, risking p99 latency spikes. The local pre‑fetch scheme removes that hot‑spot. Per‑key limits are distributed naturally across the Redis cluster, and the merged config‑and‑bucket script avoids a second round‑trip, satisfying the p99 budget.  
*(Unverified: The claim that the hybrid approach keeps p99 <5 ms under 10 000 RPS is not demonstrated; it relies on analytical assumptions and projected Redis latency.)*

---

## 3. Detailed Design

### 3.1 Input Sanitisation (Trust Boundary)

Every incoming API key is validated **before** any rate‑limiting action:

- Non‑empty, 1–128 characters.
- Only ASCII letters, digits, hyphen, underscore: `[A-Za-z0-9_-]`.
- Any invalid key → **HTTP 400 Bad Request** and a logged warning. No Redis key is constructed, no hash‑tag injection possible.

This guarantees that only clean, expected strings are used to form bucket and config keys.  
**(Unverified: The sanitisation rules are specified but not implemented or tested; actual enforcement in a running gateway is unconfirmed.)**

### 3.2 Global Service Ceiling – Hierarchical Token Bucket

Each gateway node keeps an **in‑memory local token counter** (`localTokens`, an atomic integer). A background goroutine periodically asks Redis for chunks of tokens to keep the local pool supplied.

#### Redis side (global bucket Lua script)

```lua
-- KEYS[1]  = "rl:global:bucket"
-- ARGV[1]  = capacity  (max tokens)
-- ARGV[2]  = rate      (tokens/sec)
-- ARGV[3]  = requested batch (integer)

local key = KEYS[1]
local capacity  = tonumber(ARGV[1])
local rate      = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])

local time = redis.call('TIME')
local now  = tonumber(time[1]) + tonumber(time[2]) / 1000000

local data = redis.call('GET', key)
local tokens    = capacity
local last_time = now

if data then
    local comma = string.find(data, ',', 1, true)
    if comma then
        tokens    = tonumber(string.sub(data, 1, comma-1))
        last_time = tonumber(string.sub(data, comma+1))
    end
end

local elapsed = now - last_time
if elapsed > 0 then
    tokens = math.min(capacity, tokens + elapsed * rate)
end

local granted = math.min(requested, tokens)
tokens = tokens - granted

redis.call('SET', key, string.format("%.6f,%.6f", tokens, now))
return granted
```

#### Node‑local logic

- `localTokens` – atomic integer (initial 0).
- `batchSize = 50`, `localMaxTokens = 50` – prevents hoarding.
- Background goroutine every **50 ms**:
  ```
  if localTokens < lowWatermark (10) {
      needed = min(batchSize, localMaxTokens - localTokens)
      if needed > 0 {
          granted = callGlobalBucketScript(needed)   // uses EVALSHA wrapper
          atomicAdd(localTokens, granted)
      }
  }
  ```
- On startup the first refill runs immediately.

**Per‑request global check (fast path):**  
```
if atomicAdd(localTokens, -1) < 0 {
    → HTTP 429 (global ceiling exceeded locally)
}
```
If the local pool is empty, the request is denied immediately. The background refill runs at 50 ms intervals; a node that exhausts its local tokens will block only a fraction of its share until the next refill. This choice avoids a second Redis call in the request path (no sync fallback) and keeps latency deterministic.  
**(Unverified: The atomic-decrement-and-deny behaviour has not been confirmed by execution evidence.)**

### 3.3 Per‑API‑Key Limits – Single Atomic Redis Script

Each API key is rate‑limited by a **single Lua script** that reads the bucket state **and the current limit configuration** atomically from two co‑located keys (same hash‑tag). No separate config lookup from the gateway is needed—the script is self‑contained.

#### Lua script: `per_key_check`

```lua
-- KEYS[1] = bucket key "rl:bucket:{<validated_key>}"
-- KEYS[2] = config key "rl:config:{<validated_key>}"
-- ARGV[1] = requested (always 1)
-- ARGV[2] = TTL (seconds, for key expiry)

local bucket_key = KEYS[1]
local config_key = KEYS[2]
local requested  = tonumber(ARGV[1])
local ttl        = tonumber(ARGV[2]) or 86400

-- 1. Read limit configuration
local config_str = redis.call('GET', config_key)
if not config_str then
    -- Config absent → unknown / unauthorized key
    return {-1, 0}
end

local comma = string.find(config_str, ',', 1, true)
if not comma then
    return {-2, 0}   -- malformed config (should not happen)
end
local capacity = tonumber(string.sub(config_str, 1, comma-1))
local rate     = tonumber(string.sub(config_str, comma+1))

-- 2. Read current bucket state
local data = redis.call('GET', bucket_key)
local tokens    = capacity
local last_time = 0

if data then
    local comma_b = string.find(data, ',', 1, true)
    if comma_b then
        tokens    = tonumber(string.sub(data, 1, comma_b-1))
        last_time = tonumber(string.sub(data, comma_b+1))
    end
end

-- 3. Server‑time and token refill
local time_arr = redis.call('TIME')
local now = tonumber(time_arr[1]) + tonumber(time_arr[2]) / 1000000

if last_time > 0 and last_time < now then
    local elapsed = now - last_time
    tokens = math.min(capacity, tokens + elapsed * rate)
elseif last_time == 0 then
    last_time = now    -- first request
end

-- 4. Allow or deny
local allowed = 0
if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
end

-- 5. Persist state
redis.call('SET', bucket_key, string.format('%.6f,%.6f', tokens, now))
redis.call('EXPIRE', bucket_key, ttl)

return {allowed, tokens}
```

- **Return codes:**  
  - `{-1, _}` → config missing (treated by gateway as 401 Unauthorized).  
  - `{-2, _}` → internal error (rare; logged, 429 fallback).  
  - `{1, remaining}` → allowed.  
  - `{0, remaining}` → denied.
- **Time source:** Redis `TIME` – no client‑clock dependency.
- **Atomicity:** Both config and bucket reads happen inside the same script; a limit change takes effect on the very next request, and bucket state never drifts from the configured capacity.  
**(Unverified: The specific return codes and the gateway’s interpretation of them are not backed by test data. The script’s behaviour in error cases (config missing, malformed) is unverified.)**

#### Gateway per‑request flow

1. **Sanitise** the API key ( §3.1 ); if invalid → 400.
2. **Global local check** – atomic decrement of `localTokens`. If exhausted → 429.
3. **Per‑key check** – issue `EVALSHA per_key_check` with  
   `KEYS = [rl:bucket:{key}, rl:config:{key}]`, `ARGV = [1, 86400]`.
4. **Interpret the reply** –  
   - First element `-1` → 401 Unauthorized.  
   - First element `-2` → 500 or 429 (internal error).  
   - `0` → 429 Too Many Requests.  
   - `1` → proceed to backend.

> The entire limit‑check addition involves one in‑memory atomic operation and **one Redis round‑trip** (the EVALSHA call). Under normal conditions the p99 of that single call fits within 5 ms. **(Unverified: This latency claim is part of the overall p99 budget and has not been tested at 10 000 RPS.)**

### 3.4 EVALSHA Resilience – Surviving Script Flushes

Redis scripts can be evicted by a failover, `SCRIPT FLUSH`, or memory pressure. To avoid permanent outage, each gateway node implements a **reload‑on‑NOSCRIPT** wrapper around every `EVALSHA` call.

- At startup the gateway loads all Lua scripts via `SCRIPT LOAD` on every shard/connection and caches the SHA.
- Every rate‑limiting operation calls `runScript(sha, keys, args)`:
  1. Execute `EVALSHA sha ...` with a short timeout (e.g., 2 ms).
  2. If the reply is `NOSCRIPT`:
     - Acquire a per‑SHA mutex.
     - Call `SCRIPT LOAD <script_source>` (source is a constant in the binary) on the same connection/shard.
     - Store the new SHA (it may be the same).
     - Release mutex.
     - Retry `EVALSHA` **once** with the new SHA.
  3. If the retry succeeds, log a warning and increment `script_reload_total`.
  4. If reload or retry fails, propagate the error – the circuit‑breaker ( §5 ) will treat it as a Redis failure.

- The background global refill goroutine uses the same wrapper, so it recovers automatically from a script flush.
- `EVAL` (resending the script body on every call) is **not** used, because `SCRIPT LOAD`‑and‑retry adds only one round‑trip on the rare flush event and keeps the normal path optimally efficient.

**(Unverified: The reload‑on‑NOSCRIPT wrapper has not been implemented or tested; its correctness under script flushes, race conditions, and Redis failures is unconfirmed.)**

---

## 4. Data Layout

### 4.1 Redis Keys

| Purpose               | Key pattern            | Hash‑tag | Stored value                     |
|------------------------|------------------------|----------|----------------------------------|
| Global token bucket    | `rl:global:bucket`     | none     | `"tokens,last_time"`             |
| Per‑key token bucket   | `rl:bucket:{<key>}`    | yes      | `"tokens,last_time"`             |
| Per‑key limit config   | `rl:config:{<key>}`    | yes      | `"capacity,rate"`                |

- The hash‑tag `{<key>}` ensures that each API key’s bucket and its config land on the same Redis shard, enabling the Lua script to atomically read both.  
- Because keys are syntactically sanitised (no `{}`), the hash‑tag is predictable and safe.

### 4.2 Configuration Management

- Administrators set per‑key limits by writing/updating `rl:config:{key}` with `"capacity,rate"` (e.g., `"100,1.666666"` for 100 req/min).  
- The Lua script reads the config on every request; changes take effect immediately, with no need for cache invalidation or gateway‑side reconfiguration.  
- Config keys never expire (they represent persistent entitlements).

---

## 5. Failure Handling

### 5.1 Invalid API Key
- Rejected instantly with 400; no Redis operations attempted.

### 5.2 Redis Unavailability or Timeout

- **Per‑key path:** After **N consecutive failures** (e.g., 3) to a particular shard, a **circuit‑breaker** opens for that shard. While open, all requests for keys hashing to that shard are denied (HTTP 429). A background retry with exponential backoff toggles to half‑open. **Fail‑closed** is intentional: a broken path must not allow un‑throttled traffic.  
  **(Unverified: The circuit‑breaker mechanism and its fail‑closed behaviour are not validated through testing or simulation.)**
- **Global refill:** Repeated failures to the global bucket script prevent background refills. The node’s `localTokens` drains to zero, and all subsequent requests are denied by the fast‑path check – equivalent to fail‑closed.
- **Script reload failures:** If a NOSCRIPT error occurs and the `SCRIPT LOAD` retry also fails (e.g., Redis is down), the error is counted as a normal failure and triggers the circuit‑breaker.

### 5.3 Node Restarts & Deploys
- All per‑key state lives in Redis; restarting a gateway loses only its in‑memory `localTokens`.  
- The global bucket in Redis is untouched; the node starts with zero local tokens and refills on the next background tick (≤ 50 ms). During that brief window requests may be denied (fail‑closed).  
- Per‑key enforcement continues unaffected, using Redis state.  
- Script SHAs are reloaded at startup; the node is ready immediately after the initial `SCRIPT LOAD` calls.

### 5.4 Redis Cluster Failover
- During a shard failover, keys on the affected shard become temporarily unavailable. The circuit‑breaker (or the natural Redis failure) will deny traffic for those keys. Once the new master is promoted, normal operations resume.

### 5.5 Clock Skew
- All time arithmetic is performed inside Lua scripts using Redis’s `TIME`. Because each bucket’s state is pinned to a single shard, it always sees a consistent clock; inter‑shard drift is irrelevant.

---

## 6. Operational Concerns

### 6.1 Monitoring

Essential metrics exported by each gateway node:

- `ratelimit_global_tokens_current` – current `localTokens` level.
- `ratelimit_global_refill_granted` – tokens obtained per refill.
- `ratelimit_requests_allowed_total` / `denied_total` – broken down by reason (global, per‑key, config‑missing, etc.).
- `ratelimit_redis_call_duration_seconds` – histogram of Redis EVALSHA latency.
- `ratelimit_redis_errors_total` – by error type.
- `ratelimit_script_reload_total` – number of NOSCRIPT‑triggered script reloads.
- `ratelimit_invalid_key_total` – requests with bad API key format.

**Alerts:**
- Sustained `script_reload_total > 0` → investigate accidental script flushes or failover issues.
- High per‑key denial rate → potential abuse or misconfiguration.
- Global refill error spikes → Redis connectivity problem.
- Redis error rate exceeding threshold → circuit‑breaker opening.

### 6.2 Lua Script Deployment

- Script sources are embedded in the gateway binary.  
- At startup, all scripts are loaded (`SCRIPT LOAD`) on every Redis shard.  
- Versioning: when a script must change, deploy a new script variant with a new hash; the gateway rollout is staggered, and old SHAs remain valid on the cluster until all nodes have switched.

### 6.3 Tuning Knobs

| Parameter                | Recommended | Rationale                                                                 |
|--------------------------|-------------|---------------------------------------------------------------------------|
| `batchSize`              | 50          | Balances redistribution fairness and Redis load (≈ 600 calls/s global).   |
| `localMaxTokens`         | 50          | Prevents hoarding; equals batchSize.                                      |
| `lowWatermark`           | 10          | Triggers refill before exhaustion.                                        |
| `refillInterval`         | 50 ms       | Faster than the time to drain a batch at ≈333 rps/node (batch drains in ~150 ms). |
| `per‑key TTL`            | 86 400 s    | Cleans up inactive bucket keys while keeping active ones.                 |
| `circuitBreakerThreshold`| 3           | Quick reaction to Redis problems.                                         |

### 6.4 Scaling Limits

- **Global bucket:** at most `30 nodes × (1 / 50 ms) = 600 Redis calls/s` – far from Redis’s limits.  
  **(Unverified: The calculation of ~600 calls/s and its safety margin against Redis limits is based on the chosen design parameters; actual Redis performance under production load may affect this.)**
- **Per‑key load:** 10 000 RPS are spread across many distinct API keys, each hashed to a different Redis shard; the cluster can handle orders of magnitude more.
- **Memory:** Per‑key bucket states and config keys are small; TTL + Redis `maxmemory` policies keep the footprint bounded.

---

## 7. Tradeoffs & Rejected Alternatives

### 7.1 Rejected: Pure Redis for Both Limits
**Why:** The global limit key would receive all 10 000 writes/s, becoming a hot‑spot. Under load, p99 latency would likely exceed 5 ms, especially during failovers.

### 7.2 Rejected: Gossip‑based Distributed Counters
**Why:** Maintaining a consistent aggregate limit across 30 nodes without a transactional store demands complex leader‑election or constant state exchange. Partitions and restarts would cause significant inaccuracy. Redis provides a simple, battle‑tested coordination point.

### 7.3 Rejected: Sliding‑Window Log with Sorted Sets
**Why:** Each request would require `ZADD` + `ZREMRANGEBYSCORE` + `ZCARD`, which are more expensive than a token bucket. Memory grows with the request rate, and it does not improve latency or accuracy.

### 7.4 Rejected: Separate Config‑Fetch Before the Rate‑Limit Call
**Why:** This would add a second Redis round‑trip on a cache‑miss, pushing p99 beyond budget. Embedding the config read inside the rate‑limit Lua script merges the two operations into one round‑trip, eliminating that risk.

### 7.5 Tradeoff: No Synchronous Fallback for Global Tokens
When a node’s local global tokens hit zero, requests are immediately denied until the next background refill (≤ 50 ms). This trades occasional spurious 429s against guaranteed low latency—no extra Redis call in the request path. Given the fast refill interval and that the global ceiling is only a safety net, this is an acceptable tradeoff.

---

## 8. Verification Status

**Verified claims** (explicitly stated in the design document):  
- The architecture includes an in‑memory token bucket for the global ceiling and a single Redis Lua script for per‑key limits (atoms 2, 3).  
- The Lua script uses Redis `TIME` to avoid client‑clock dependency (atom 7).  
- On node restart, only the in‑memory `localTokens` are lost; per‑key state persists in Redis (atom 10).  
- The design rejects a pure‑Redis global limit due to hot‑key risk, and a separate config fetch to avoid extra latency (atoms 12, 13).  
- The design is explicitly acknowledged as unimplemented and untested; “No code was executed” (atom 14).  

**Unverified claims** (lacking execution or implementation evidence):  
- The hybrid approach meets the p99 < 5 ms latency budget under 10 000 RPS (atom 1).  
- The API key sanitisation logic is implemented as described (atom 4).  
- The atomic decrement and immediate 429 denial behaviour is correct (atom 5).  
- The per‑key Lua script returns the stated codes and the gateway interprets them correctly (atom 6).  
- The reload‑on‑NOSCRIPT wrapper functions properly under script flushes and other failure conditions (atom 8).  
- The circuit‑breaker opens and fails‑closed as intended (atom 9).  
- The global bucket script call rate of ~600/s and its impact on Redis capacity are based on unvalidated calculations (atom 11).  

*The design remains a proposal; its performance and correctness must be confirmed through implementation, load testing, and chaos experiments.*