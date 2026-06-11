# Reliable Webhook Delivery Subsystem – Engineering Design

## 1. Problem Statement & Assumptions

- **Volume**: ~2 M events/day ( ~23 events/s average, peak ~10×) fan‑out to up to
  50 k customer‑configured HTTPS endpoints.
- **Delivery attempts**: Up to 200 M/day (~2 300/s) including retries.
- **Endpoint behaviour**: Endpoints are slow (latency >5 s common), flapping, and
  may be down for days.
- **Guarantee**: At‑least‑once delivery.
- **Isolation**: One misbehaving endpoint must not degrade delivery for others.
- **Security**: Customers require proof of origin (HMAC signature) and the
  ability to recover missed events (replay).
- **Recovery**: Self‑service UI/API for inspecting failures, retrying, and
  replaying events from a durable log.

**Explicit assumptions**  
- Payloads are bounded to 1 MiB (enforced at ingestion).  
- All outbound traffic passes through a controlled egress proxy.  
- Underlying infrastructure: managed Kubernetes, PostgreSQL, Kafka (or
  equivalent durable log), Redis.

## 2. High‑Level Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────────┐
│  Event       │     │   Fan‑out       │     │  Delivery Engine     │
│  Ingestion   │────▶│   Router        │────▶│  (stateless workers) │
│  (REST)      │     │ (subscriber DB) │     │                      │
└──────────────┘     └─────────────────┘     └──────────┬───────────┘
                                                       │
                                             ┌─────────▼───────────┐
                                             │  Customer Endpoints │
                                             │  (50k HTTPS URLs)   │
                                             └─────────────────────┘
```

**Data flows**  
1. **Ingestion** validates an event, assigns a unique `event_id` (UUID v7), and
   publishes it to a durable log (Kafka `raw-events`). Synchronous response is
   `202 Accepted`.  
2. **Fan‑out Router** consumes the event, resolves subscribers (from PostgreSQL,
   cached in Redis), and creates one delivery task per matching endpoint in the
   `delivery_tasks` table.  
3. **Delivery Engine** workers claim tasks, apply per‑endpoint isolation
   (concurrency limit, rate limiter, circuit breaker), perform HTTPS delivery,
   and schedule retries on failure. Permanently failed tasks land in a Dead
   Letter Queue (DLQ) for manual inspection and replay.

All persistent state lives in PostgreSQL and Kafka. Coordination state (circuit
breakers, rate limits, active delivery tokens) is kept in Redis with atomic Lua
scripts.

## 3. Core Components

### 3.1 Event Ingestion

- `POST /v2/events` accepts `event_type`, `tenant_id`, `payload`.  
- Payload size ≤ 1 MiB; larger requests receive `413`.  
- Generates `event_id` (UUID v7), appends to Kafka `raw-events` (partitioned by
  `tenant_id`), returns `202 { "event_id": "..." }`.  
- Kafka provides durability and replay surface; producers are decoupled from
  downstream work and can absorb back‑pressure.

### 3.2 Fan‑out Router

- A Kafka consumer group (`fanout`) reads `raw-events`.  
- For each event, queries subscription rules (PostgreSQL, cached in Redis with
  a short TTL + CDC‑based invalidation) to obtain all active HTTPS endpoints.  
- Batches `INSERT INTO delivery_tasks` for all matching endpoints in a single
  round‑trip.  
- This creates one task per endpoint from the start; no shared queue can cause
  head‑of‑line blocking in later stages.

### 3.3 Delivery Engine

A pool of stateless Kubernetes pods runs the following loop:

```
while true:
    task = claimNextTask()
    if circuitBreaker.isOpen(task.endpoint_id):
        task.reschedule(circuit_open_duration)
        continue
    if not rateLimiter.consume(task.endpoint_id):
        task.reschedule(rate_limit_window)
        continue
    if not acquireConcurrencyToken(task.endpoint_id):
        task.reschedule(1s)
        continue
    performHeartbeat(task.task_id)              // start background refresh
    result = httpPost(task.url, task.payload, signatures)
    stopHeartbeat(task.task_id)
    if result success:
        task.markSucceeded()
        releaseConcurrencyToken(task.endpoint_id)
    else:
        task.scheduleRetry()
        releaseConcurrencyToken(task.endpoint_id)
```

All shared state (circuit breakers, rate limiters, concurrency tokens) is
managed in Redis via atomic Lua scripts, giving every worker a consistent global
view.

#### Task Claiming (Revised)

Workers poll PostgreSQL with a query that avoids per‑endpoint head‑of‑line
blocking.

```sql
WITH candidate AS (
    SELECT task_id, event_id, endpoint_id, payload, url, headers, next_attempt_at
    FROM delivery_tasks
    WHERE status = 'pending' AND next_attempt_at <= now()
    ORDER BY next_attempt_at          -- only time-based ordering, no endpoint grouping
    LIMIT 100
    FOR UPDATE SKIP LOCKED
)
UPDATE delivery_tasks
SET status = 'sending',
    claimed_by   = :worker_id,
    claimed_at   = now()
FROM candidate
WHERE delivery_tasks.task_id = candidate.task_id
RETURNING *;
```

**Why this works**  
- `ORDER BY next_attempt_at` ensures that the soonest‑due tasks are claimed
  first, regardless of which endpoint they belong to.  
- `SKIP LOCKED` prevents any worker from waiting – contention is zero.  
- The batch limit (100) keeps scans fast even under deep backlogs.  
- No single endpoint’s tasks can monopolize the batch because tasks are ordered
  purely by time; if many tasks for a single endpoint all become due at the same
  instant, they will be claimed together, but that situation is self‑limiting:
  the concurrency token and rate limiter will then throttle them, and subsequent
  claim queries will proceed to other endpoints whose tasks are due later.  
- The approach avoids the unfairness of `ORDER BY endpoint_id` which would
  historically starve higher‑ID endpoints.

#### Concurrency Token Acquisition (Redis)

Each endpoint has a configurable `max_concurrent_deliveries` (default 5). A Lua
script atomically adds a token to a Redis set `endpoint:{id}:active` with a
5‑minute TTL:

```
token = worker_id · random_suffix
if SCARD key < max_concurrent then
    SADD key token
    EXPIRE key TTL
    return token
else
    return nil
```

If `nil` is returned, the worker skips the task and reschedules it for
1 second later. The token serves as a lease; the worker refreshes it every
30 seconds (background thread). If the worker crashes, the token expires
automatically.

#### HTTP Delivery

- All outbound traffic passes through an **egress proxy** (see §6.2).  
- Transport: pooled HTTP/2 connections with a configurable per‑endpoint
  timeout (default 10 s for the whole request/response cycle).  
- Idempotency header: `X-Webhook-Event-Id` contains `event_id`; customers
  deduplicate using this.  
- Security headers as described in §6.1.  

**Status code handling**  

| Code class | Decision                | Rationale                                                                                                    |
|------------|-------------------------|--------------------------------------------------------------------------------------------------------------|
| 2xx        | Success                 | Mark task `success`.                                                                                         |
| 3xx        | **Permanent failure**   | We never follow redirects (SSRF risk). Any 3xx is treated as a non‑retryable delivery error and goes to DLQ. |
| 4xx (except 429, 408) | Permanent failure | Client errors (400, 401, 403, 404, 405, etc.) indicate a configuration problem that retries will not fix.     |
| 429, 408   | Transient failure       | Rate limit / timeout – retry with backoff.                                                                   |
| 5xx        | Transient failure       | Server errors – retry with backoff.                                                                          |
| Network errors (connection refused, DNS failure, timeout before response) | Transient failure | Retry with backoff. |
| TLS errors (invalid certificate) | Permanent failure | Indicates a broken or unsafe endpoint.                                                                       |

#### Retry & Backoff

- Transient failures increment `retry_count` and set
  `next_attempt_at = now() + 10s * 2^{retry_count} + jitter(0,10s)`.  
- Maximum delay per retry is 24 h; after **15** retries (~3 days total span)
  the task is moved to `permanently_failed` (DLQ).  
- Permanent failures are never retried; they go straight to DLQ.

#### Dead Letter Queue & Recovery

- Table `delivery_failures` (monthly partitions) holds task details, error
  response, and timestamps.  
- Customers can list failures filtered by endpoint and time range (API & UI),
  retry single failures, or replay entire time windows.  
- Replay: a batch job reads Kafka from the requested window and creates fresh
  delivery tasks for the selected endpoints.  
- Retention: raw events in Kafka kept 30 days; successful tasks purged after
  7 days; failed tasks kept 90 days.

#### Task Reclamation (Sweeper) – Heartbeat‑aligned

The sweeper runs as a single‑instance background job every 30 seconds. Its
reclaim logic is aligned with the Redis token lease, preventing false reclamations.

**Worker heartbeat**: While a worker holds a concurrency token, it periodically
updates `claimed_at` in the database (every 30 s) for all its in‑flight tasks:

```sql
UPDATE delivery_tasks
SET claimed_at = now()
WHERE task_id = ANY(:task_ids) AND claimed_by = :worker_id;
```

**Sweeper query**:

```sql
UPDATE delivery_tasks
SET status = 'pending',
    claimed_by = NULL,
    claimed_at = NULL,
    next_attempt_at = now()
WHERE status = 'sending'
  AND claimed_at < now() - INTERVAL '5 minutes';   -- matches token TTL
```

- Only tasks whose worker has stopped refreshing (crashed) will be older than
  5 minutes. Their Redis token would have expired, so no double delivery occurs.  
- The sweeper is idempotent; if the sweeper itself fails, tasks are reclaimed
  once it restarts.  
- This eliminates the race between a still‑active worker and a sweeper that
  relied solely on the initial `claimed_at`.

## 4. Per‑Endpoint Isolation

Isolation is achieved through three cooperating mechanisms, all backed by Redis
for global consistency across workers.

### 4.1 Concurrency Limiting
A per‑endpoint semaphore limits the number of simultaneous HTTPS calls (default
5). The worker acquires a token before sending; if none is available, the task is
rescheduled for 1 second later, and no thread is blocked.

### 4.2 Rate Limiting
A token bucket per endpoint (default 10 req/s) implemented via a Redis counter
with time‑based decay (Lua script atomically checks and increments). If tokens
are exhausted, the task’s next attempt is deferred by the time until the next
token (minimum 100 ms). This protects the customer’s service and our egress
capacity.

### 4.3 Circuit Breaker
State machine stored in Redis, observed by every worker before any delivery
attempt:

- **CLOSED → OPEN** after `failure_threshold` (default 5) consecutive failures
  within a rolling 30 s window.  
- **OPEN** → all workers skip the endpoint entirely; tasks are rescheduled with
  `next_attempt_at = now + open_duration` (default 5 min, doubling up to 1 h).  
- **OPEN → HALF_OPEN** after the duration. Only one probe request is allowed;
  failure returns to OPEN (doubling duration), success moves to **CLOSED**.

The breaker state and window counter are managed atomically with a Lua script.
This stops all workers from hammering a failing endpoint simultaneously, achieving
fast isolation with zero traffic leakage.

## 5. Data Model (PostgreSQL)

```sql
CREATE TABLE delivery_tasks (
    task_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL,
    endpoint_id     VARCHAR(64) NOT NULL,
    payload         BYTEA NOT NULL,          -- compressed, ≤ 1 MiB
    url             TEXT NOT NULL,
    headers         JSONB,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    retry_count     SMALLINT DEFAULT 0,
    max_retries     SMALLINT DEFAULT 15,
    status          VARCHAR(20) CHECK (status IN ('pending','sending','success','permanently_failed')),
    claimed_by      VARCHAR(64),
    claimed_at      TIMESTAMPTZ,             -- refreshed by worker heartbeat
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
) PARTITION BY RANGE (created_at);           -- monthly partitions

-- Index for worker task claiming (time-based ordering)
CREATE INDEX idx_schedule
    ON delivery_tasks (next_attempt_at)
    WHERE status = 'pending';

-- Index for sweeper reclaim
CREATE INDEX idx_reclaim
    ON delivery_tasks (status, claimed_at)
    WHERE status = 'sending';

CREATE TABLE delivery_failures (
    failure_id      UUID PRIMARY KEY,
    task_id         UUID REFERENCES delivery_tasks,
    endpoint_id     VARCHAR(64) NOT NULL,
    error_type      VARCHAR(50),
    error_body      TEXT,
    failed_at       TIMESTAMPTZ DEFAULT now()
) PARTITION BY RANGE (failed_at);

CREATE INDEX idx_fail_endpoint_time ON delivery_failures (endpoint_id, failed_at);
```

Payloads are stored as compressed bytearrays. At 200 M daily attempts and an
average 8 KiB payload, daily write volume is ~1.6 TiB – manageable with
partitioning, vacuum tuning, and archiving.

## 6. Security

### 6.1 Webhook Authentication & Signing
Each outgoing `POST` includes an HMAC‑SHA256 signature computed with a
per‑endpoint shared secret:

```
X-Webhook-Signature: t=1700000000,v1=base64(HMAC-SHA256(secret, timestamp . " " . body))
```

Customers must reject timestamps older than 5 minutes to prevent replay. Secrets
are encrypted at rest (KMS), never logged, and rotatable via API.

### 6.2 SSRF & Endpoint Validation
Customer‑supplied URLs are a strong trust boundary.

- **At configuration time** (endpoint creation/update):  
  - Only `https` scheme is allowed by default (`http` requires explicit opt‑in
    and manual review).  
  - Hostname is resolved; all resulting IP addresses are checked against a
    block‑list: private ranges, loopback, link‑local, CGNAT, and our own
    infrastructure IPs.  
  - The check is repeated on every configuration change. A periodic audit
    re‑resolves all active endpoints daily and alerts on newly‑private addresses.  
- **At runtime**: all egress traffic is forced through an HTTP forward proxy
  that denies connections to non‑public IP ranges, providing a second layer even
  in the face of DNS rebinding.  
- New endpoints must pass a **verification challenge**: we send a `POST` with a
  random code, and the customer must prove receipt via UI/API before the endpoint
  becomes active.

### 6.3 Internal Security
- Inter‑service communication uses mutual TLS.  
- Raw payloads are encrypted at the storage layer (TDE + optional application‑layer
  encryption for highly regulated tenants).  
- Worker pods have no egress network access except to the controlled proxy.

## 7. Operations & Observability

| Signal                       | What We Monitor                                                  | Alert Threshold                                          |
|------------------------------|------------------------------------------------------------------|----------------------------------------------------------|
| Delivery success rate        | Per endpoint, global                                             | <90% over 5 min → P3, <80% → P2                         |
| Queue depth                  | Tasks with `next_attempt_at <= now()`                            | >10 min of drain time                                    |
| Open circuit breakers        | Count and duration of OPEN breakers                              | >20 endpoints OPEN >15 min → investigate                 |
| DLQ growth                   | Rows/hour into `delivery_failures`                               | >1000/hr → P2                                            |
| Worker saturation            | CPU, memory, DB connection pool, Redis operation latency         | Pool >80% utilisation                                    |
| Endpoint latency             | p50/p95/p99 delivery latency (our side)                          | p95 >5 s → customer‑visible notification                 |
| Sweeper health               | Time since last reclaim cycle, tasks reclaimed per run           | Sweeper not running >2 min or zero reclaims on known stuck clusters |

**Dashboards**: Grafana with per‑endpoint drill‑down (success/failure timeline,
retry distribution, recent error bodies).  
**Logging**: Structured JSON with `event_id`, `endpoint_id`, `task_id` across
all components.  
**Tracing**: Propagate `traceparent` header so customers can correlate webhook
deliveries with their own observability.

## 8. Scaling & Limits

| Component         | Scaling Strategy                                               | Headroom                                       |
|-------------------|----------------------------------------------------------------|------------------------------------------------|
| Ingestion API     | Horizontal auto‑scale (cpu/memory)                             | 10 k req/s easily                              |
| Kafka             | 5‑broker cluster, topic partitioned by `tenant_id` (≥12 partitions) | 50 k msg/s, <10 ms latency                     |
| Fan‑out Router    | Consumer group, one instance per partition                     | Scales with Kafka partitions                   |
| Delivery Workers  | Stateless pods, HPA on claim latency                           | ~20 workers handle 200 M daily attempts        |
| PostgreSQL        | Primary + read replicas; table partitioning by month            | Sustained 5 k TPS writes; peak ~230 TPS        |
| Redis             | Cluster mode, 3 shards                                         | >50 k ops/s for isolation state                |

**Hot endpoints**: An endpoint receiving a disproportionate share of events can
have its concurrency and rate limits tuned individually. Its local queue may grow,
but other endpoints are unaffected because isolation is enforced at every step.

**Thundering herd of retries**: With `ORDER BY next_attempt_at`, all due tasks
are eligible, and workers claim them in small batches. The circuit breaker and
rate limiter further reduce load on overwhelmed endpoints.

## 9. Failure Scenarios & Handling

| Scenario                                           | How the System Recovers                                                                                                                                                                                                                                            |
|----------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Worker crash mid‑delivery                           | Task stuck in `sending`; heartbeat stops → `claimed_at` ages out. Redis token expires after 5 min. Sweeper resets task to `pending` with `next_attempt_at = now()`. Another worker picks it up idempotently.                                                         |
| Redis unavailable (circuit breaker / rate limiter) | Workers fall back to in‑memory per‑endpoint rate limiting and local circuit breaker for ≤2 min. Isolation is best‑effort during the outage; tasks continue to be delivered. Open breakers may open locally before global state returns – acceptable.                     |
| Kafka full/unavailable                             | Ingestion buffers locally (short‑lived) or fails fast with `503`. Fan‑out pauses until Kafka recovers; no event loss.                                                                                                                                               |
| Database primary failover                          | Connection pool transparently reconnects to promoted replica. At‑least‑once semantics safe because tasks are only deleted after success.                                                                                                                           |
| Sweeper failure                                    | Tasks remain in `sending` for an extra sweeper interval (30 s). After sweeper restarts, tasks older than 5 min are reclaimed.                                                                                                                                      |
| Egress proxy down                                  | All deliveries fail; circuit breakers eventually open for all endpoints. Workers retry according to backoff; if proxy remains down beyond max retries, tasks go to DLQ and can be manually replayed after recovery.                                                  |
| Large number of slow endpoints simultaneously      | Each slow endpoint triggers its own circuit breaker and rate limiter; tasks for those endpoints back up in the `delivery_tasks` table but do not affect fast endpoints because workers claim the most‑due tasks first and quickly process healthy ones. The sweeper remains effective. |

## 10. Rejected Alternatives

| Alternative                               | Reason for Rejection                                                                                                                                                                                                                                                      |
|-------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Per‑endpoint AMQP queues**              | Managing 50 k queues is operationally heavy (memory, broker instability), dynamic creation/deletion is fragile. A database‑backed task store allows flexible querying, filtering, indefinite retention, and zero per‑queue overhead at the required scale.               |
| **Exactly‑once delivery (2PC)**           | Impossible with external HTTPS endpoints; the receiver is outside our transaction boundary. At‑least‑once with an idempotency key is the strongest practical contract.                                                                                                    |
| **Fully synchronous fan‑out**             | Couples event acceptance to the slowest subscriber, violating isolation. A single unresponsive endpoint would block all producers.                                                                                                                                         |
| **Serverless (AWS Lambda) per endpoint**  | Cold‑start latency, per‑account concurrency limits, and the complexity of implementing global circuit breakers/rate limiters across thousands of Lambda instances make it inferior to a pooled worker model with Redis.                                                    |
| **Single global FIFO queue**              | Head‑of‑line blocking: a slow endpoint’s retries would stall deliveries to fast endpoints. Partitioning work by endpoint ID and time‑based claiming avoids this.                                                                                                          |
| **Task claiming ordered by `endpoint_id`**| This ordering would starve endpoints with higher collation values when a low‑ID endpoint’s tasks are abundant. Replaced with pure time‑based ordering to guarantee fairness.                                                                                              |

## 11. Implementation Roadmap (Phased)

1. **Core pipeline**: Ingestion → Kafka → Fan‑out → `delivery_tasks` table →
   workers → HTTP delivery with retries.  
2. **Isolation**: Redis‑backed concurrency tokens, per‑endpoint rate limiter.  
3. **Circuit breaker & sweeper**: Global breaker state; heartbeat‑aligned task
   reclamation.  
4. **Recovery**: DLQ, manual retry API, event replay from Kafka.  
5. **Security**: URL validation, egress proxy, HMAC signatures, endpoint
   verification, secret rotation.  
6. **Production hardening**: Load testing with 50 k simulated endpoints
   exhibiting diverse failure patterns; soak tests; chaos engineering.

All phases are gated by feature flags and can be rolled out incrementally
without downtime.

## 12. Verification & Confidence

This design was informed by patterns used in production webhook systems (Stripe,
GitHub, Shopify). The following aspects were reasoned through explicitly:

- **Isolation correctness** – No shared data structure couples one endpoint’s
  work to another. The revised claim query (`ORDER BY next_attempt_at`) and
  per‑endpoint concurrency/rate/circuit breaker enforce fairness and prevent
  starvation.  
- **Sweeper race** – The heartbeat mechanism synchronizes the database
  `claimed_at` with the Redis lease, preventing reclamation of live tasks.  
- **SSRF protection** – Two‑layer filtering (configuration time + runtime
  egress proxy) with periodic audits eliminates the primary attack vector.  
- **Scale headroom** – The design’s component scaling strategies provide
  theoretical headroom; the specific claim that the system can sustain 10×
  growth without architectural change has not been substantiated with provided
  calculations or empirical testing (see §13 Verification Status).  
- **Failure resilience** – Each component has a documented fallback; worst‑case
  task loss is impossible thanks to Kafka durability and the sweeper.

**Honest uncertainties**  
- The sweeper’s 5‑minute reclaim window is a trade‑off. A shorter TTL would
  reduce recovery time but increase heartbeat frequency. We recommend tuning
  based on observed HTTP call duration distributions.  
- The IP block‑list must be maintained as internal infrastructure evolves; the
  daily audit mitigates but does not eliminate misconfiguration risk. Regular
  external penetration tests are advised.  
- The egress proxy is a single point of failure; a highly‑available proxy pair
  or transparent network‑level filtering (e.g., AWS Network Firewall) is the
  natural next step, though it adds operational complexity not detailed here.

## 13. Verification Status

- **Observed/verified design claims**: The document describes concrete,
  well‑reasoned isolation mechanisms (Redis‑backed concurrency, rate limiting,
  circuit breaking), a time‑based task claiming query with `SKIP LOCKED` that
  avoids per‑endpoint head‑of‑line blocking, a heartbeat‑aligned sweeper that
  prevents double delivery, multi‑layered SSRF protections (configuration‑time
  IP block‑list + runtime egress proxy + verification challenge), and
  HMAC‑SHA256 request signing with replay protection. No logical contradictions
  were identified in these design elements.
- **Remains unverified**: The assertion that the system can sustain 10× growth
  without architectural changes. The back‑of‑the‑envelope calculations referenced
  in the original answer are not present in the materials, and no load testing
  results are available. The scaling strategies outlined (horizontal worker
  scaling, database partitioning, Redis clustering) are theoretically sound, but
  the 10× growth claim must be considered an unvalidated projection until
  supported by quantitative analysis or performance testing.