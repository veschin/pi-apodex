## 1. Requirements & Constraints (Restated)

| Requirement | Implication |
|---|---|
| ~2M events/day, 50k customer endpoints | Throughput ~23 events/s average, but peak may be 10x. Must sustain high fan-out – each event may need delivery to multiple endpoints. |
| Unreliable endpoints (slow, flapping, down for days) | Need per‑endpoint retry isolation: a stuck endpoint must not consume shared resources. At‑least‑once delivery and eventual discard after exhaustion. |
| At‑le‑ast‑once delivery | Payload must be idempotent or carry a unique idempotency key so customers can safely process duplicates. |
| Security & recovery | Payloads signed with per‑endpoint secret (HMAC). Customers can fetch missed events via API / re‑trigger delivery. |
| No noisy neighbour | One misbehaving endpoint must not degrade other deliveries. |

## 2. Architecture Overview

```
[Event Producers]  →  [Internal Event Bus (Kafka)]  →  [Fan‑out Service]  
                                                        ↓  
                                           [Per‑endpoint Delivery Queues (PostgreSQL)]  
                                                        ↓  
                                           [Worker Pool (distributed consumers)]  
                                                        ↓  
                                           [Customer HTTPS Endpoints]
                                                        ↓
                                           [Event Store (Kafka, retained 7 days)]
```

- **Event Bus**: Kafka topic (partitioned by event type) for permanent event log (7‑day retention). Used both for fan‑out and for customer replay.
- **Fan‑out Service**: subscribes to event bus, looks up matching endpoints from subscription DB, writes a delivery task (with event payload + HMAC) into each endpoint’s queue.
- **Delivery Queue**: a relational table (`delivery_attempts`) that acts as a per‑endpoint logical queue. Workers pick tasks using row‑level locking to ensure isolation.
- **Worker Pool**: horizontal pods that poll the queue, perform HTTP delivery, then update status. Single delivery at a time per endpoint (via lock).
- **Security**: HMAC signature computed per delivery attempt; customers verify using their secret.
- **Recovery**: customers call a REST API to list/retrieve events from the event store, or to replay dead letter items.

---

## 3. Detailed Design

### 3.1 Event Ingestion & Fan‑Out

- **Event Bus** (Kafka): one topic `events`, partitioned by logical event type (e.g., `order.created`). Retention = 7 days (for replay).
- **Subscription Manager**: stores `(event_type, endpoint_id, endpoint_secret, is_active)` per customer. Cached in‑memory (with 30‑second TTL) to avoid DB load.
- **Fan‑out Flow**:  
  a) Consumer reads event from Kafka.  
  b) Queries subscription cache for endpoints matching event type.  
  c) For each matching endpoint, calls `INSERT` into `delivery_attempts` with status `pending`.  
  d) The insert is batched (100 rows) for efficiency.  
- **Delivery Queue Table**:

```sql
CREATE TABLE delivery_attempts (
    id            BIGSERIAL PRIMARY KEY,
    endpoint_id   INTEGER NOT NULL,          -- FK to customer endpoints
    event_id      UUID NOT NULL,              -- references event store
    payload       JSONB NOT NULL,             -- the event body
    hmac_sig      VARCHAR(64) NOT NULL,       -- signature for this endpoint
    status        VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending, in_progress, delivered, dead
    retry_count   SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_delivery_pending ON delivery_attempts (endpoint_id, next_attempt_at) WHERE status = 'pending';
```

- **Why PostgreSQL**: provides per‑row locking (SKIP LOCKED), ACID semantics, and easy operational tooling. 2M events/day × average 10 endpoints/event = 20M delivery attempts/day. With proper indexing and partitioning (by endpoint_id hash), this is manageable (peak ~300–500 tps). For 50k endpoints, row distribution is even.

### 3.2 Delivery Workers & Isolation

- **Worker Pool**: N stateless Kubernetes pods (scaled by queue depth). Each worker runs a polling loop:

```
WHILE (true) {
   // pick one endpoint at a time (greedy, but time‑limited)
   tasks = SELECT * FROM delivery_attempts
           WHERE status = 'pending'
             AND next_attempt_at <= NOW()
             AND (locked_until IS NULL OR locked_until <= NOW())
           ORDER BY next_attempt_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED;

   if (no rows) sleep(100ms);

   // we now own a single task (implicitly locks its endpoint)
   // but to truly isolate we must hold only one row per endpoint at a time
   // however, SKIP LOCKED may let multiple workers pick different rows of same endpoint.
   // Solution: before picking, we can use a per‑endpoint lock table or a constraint
   // that only one 'pending' row per endpoint is picked concurrently.
   // Simpler: use advisory lock on endpoint_id
   BEGIN;
     SELECT pg_advisory_xact_lock(endpoint_id);   // per‑endpoint mutex
     // Now re‑check there is no concurrent delivery for this endpoint
     pending_count = SELECT COUNT(*) FROM delivery_attempts
                     WHERE endpoint_id = ?
                     AND status = 'in_progress';
     IF pending_count > 0 THEN skip;  // already being delivered – but advisory lock prevents other workers for same endpoint
   COMMIT;

   // Actually, using SKIP LOCKED + ordering by next_attempt_at ensures 
   // that each endpoint's oldest pending task is picked first. 
   // If we also add a WHERE clause that no other row from same endpoint 
   // is 'in_progress', we can enforce one‑at‑a‑time:
   // Sub‑query: "AND NOT EXISTS (SELECT 1 FROM delivery_attempts d2 WHERE d2.endpoint_id = d.endpoint_id AND d2.status = 'in_progress')"
   // Combine with SKIP LOCKED.

   UPDATE delivery_attempts SET status = 'in_progress', locked_until = NOW() + '5 minutes'::interval WHERE id = ? ;
   // perform HTTP POST with payload + HMAC header
   // set timeout = 10 seconds
   // on success: UPDATE status = 'delivered'
   // on failure:
      retry_count = retry_count + 1;
      IF retry_count < 10 THEN
         next_attempt_at = NOW() + exp_backoff(retry_count) + jitter;
         status = 'pending';
      ELSE
         status = 'dead';
      END IF;
}
```

**Isolation guarantee**:  
- Using `SKIP LOCKED` + per‑endpoint exclusive lock (advisory or the `NOT EXISTS` clause) ensures at most **one delivery at a time** per endpoint.  
- If one endpoint is down, its row will be retried later, but other endpoints’ rows are picked by the same workers concurrently.  
- Worker crashes leave a row in `in_progress` with `locked_until` in the future; after expiry, another worker can pick it.

### 3.3 Retry Model (Exponential Backoff)

| Retry # | Backoff (base 10 min) | Jitter | Range |
|---|---|---|---|
| 1 | 10 min | ±0–2 min | ~8–12 min |
| 2 | 20 min | ±0–5 min | ~15–25 min |
| 3 | 40 min | ±0–10 min | ~30–50 min |
| 4 | 80 min | ±0–20 min | ~60–100 min |
| 5 | 160 min | ±0–40 min | ~2–3.5 h |
| 6 | 320 min | ±0–80 min | ~4–7 h |
| 7 | 640 min | ±0–160 min | ~8–13 h |
| 8 | 1280 min | ±0–320 min | ~16–26 h |
| 9 | 2560 min | ±0–640 min | ~32–53 h |

After 10 attempts (≈ 4.5 days), message moves to `dead` status. Customers can later replay dead items.

### 3.4 Security

- **HMAC Signing**: For each delivery attempt, the fan‑out service computes `HMAC-SHA256(payload, endpoint_secret)` and stores it in `hmac_sig`. The worker includes header `Webhook-Signature: sha256=<hex>`.
- **HTTPS Only**: Workers reject non‑TLS endpoints (enforced at subscription time).
- **Customer Verification**: Customers are given the secret; they compute the same HMAC on the raw request body and compare.
- **Secret Rotation**: API endpoint `POST /endpoints/{id}/rotate` updates secret; old deliveries retain their signature (still valid, as they used old secret).

### 3.5 Recovery (Customer‑Facing)

- **Event Store**: Kafka topic `events` retained 7 days. Exposes a REST API with pagination:
  - `GET /events?endpoint_id=XYZ&from=2025-03-01T00:00:00Z&to=...`  
  - Returns events that were delivered or dead. Works because fan‑out inserts a delivery record that references `event_id`.
- **Replay Dead Items**:  
  - `POST /endpoints/{id}/replay`  
  - Workers re‑enqueue all rows with `status='dead'` for that endpoint: update `status='pending'`, `retry_count=0`, `next_attempt_at=NOW()`.  
- **Re‑deliver Missed Events**: Customers can also manually request redelivery for a specific time range by re‑enqueueing events from the event store (admin API).

### 3.6 Operations

- **Monitoring**:
  - Per‑endpoint metrics: delivery success rate (sliding 5‑min window), latency P95, distribution of HTTP status codes.
  - Alert on: success rate < 90% for 10 min, or endpoint downstream for > 1 hour.
- **Autoscaling Workers**:
  - Metric: `delivery_attempts` where `status = 'pending'` and `next_attempt_at <= NOW()` (total across all endpoints).
  - Target average 10 pending per worker. Scale up/down within limits.
- **Database Health**:
  - `delivery_attempts` table must be indexed and optionally partitioned by `endpoint_id % 100` for massive scale.
  - Monitor `SKIP LOCKED` contention; if high, increase active worker count or reduce locking granularity.

---

## 4. Tradeoffs & Rejected Alternatives

| Alternative | Reasoning for Rejection |
|---|---|
| **Redis Streams (one stream per endpoint)** | 50k streams are fine, but Redis memory cost grows with backlog. If an endpoint is down for days, its stream accumulates millions of messages, potentially causing out‑of‑memory. PostgreSQL’s disk‑backed storage is cheaper for long backlogs. Also, Redis lacks built‑in row‑level locking for per‑endpoint concurrency control – would need application‑level locking, adding complexity. |
| **Amazon SQS FIFO per endpoint** | 50k FIFO queues incur significant cost (~$1.40 per million requests + $0.50 per queue‑month). At 20M deliveries/day it would be economically prohibitive. Also SQS FIFO limited throughput (300 TPS per queue) may throttle high‑volume endpoints. |
| **Kafka partitions per endpoint** | 50k partitions is possible but creates high overhead for brokers and consumers. Kafka topology is not designed for per‑endpoint ordering – it’s meant for partition‑level ordering. Rebalancing 50k consumer groups would be slow. |
| **Single consumer group with threads per endpoint** | Noisy behaviour: a slow endpoint blocks a thread that could serve another endpoint. Would require complex thread‑pool per endpoint, doesn’t scale evenly. |
| **Polling‑based workers without per‑endpoint locks** | Two workers could deliver two events to the same endpoint concurrently. Customers receiving out‑of‑order events may violate at‑least‑once semantics if they dedupe incorrectly, or overwhelm the endpoint. |

**Why chosen design is better**:  
- **Database‑backed queue** gives cheap, durable backlog storage with built‑in locking primitives.  
- **Row‑level locking with SKIP LOCKED** provides fair scheduling without idle polling.  
- **Exponential backoff** reduces load on flapping endpoints.  
- **Separation of event store** enables replay without re‑processing from delivery logs.  

**Remaining Limitations**:  
- Single table `delivery_attempts` may become a write bottleneck at 50k TPS (peaks could be 500–1000 TPS – safe). For future growth, partition by `endpoint_id` hash across 100 tables.  
- Advisory locks are PostgreSQL‑specific; porting to MySQL would require `GET_LOCK()` (similar).  
- Workers must handle graceful shutdown to avoid abandoning in‑progress deliveries (use shutdown hooks to roll back status to `pending` after timeout).

---

## 5. Verification & Honesty

The design has not been executed in production, but each component is based on well‑known patterns (Kafka, PostgreSQL SKIP LOCKED, HMAC, exponential backoff). The **at‑most‑one delivery per endpoint at a time** guarantee relies on the `NOT EXISTS` clause and `SKIP LOCKED` – this combination must be tested under concurrent load. Production should run integration tests that simulate a stuck endpoint and verify that other endpoints are unaffected.

**What remains unverified**:  
- Actual latency of `SKIP LOCKED` with 50k endpoints and 20M rows. PostgreSQL’s row‑level locking works well under moderate load, but we recommend a load test targeting 1000 simultaneous delivery attempts to confirm peak performance.  
- Adherence to at‑least‑once when worker crashes after HTTP POST but before status update: the message will be retried (since locked_until expires). This is acceptable (duplicate is handled by customer idempotency key).  
- Customer replay API may produce duplicate deliveries if invoked while retries are still in progress – we must either pause retries for the endpoint during replay or allow duplicates (design goal accepts at‑least‑once).

All other functionality (HMAC signing, event store, retry backoff) is standard and can be implemented with high confidence.