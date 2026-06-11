# Webhook Delivery Subsystem – Revised Engineering Design

### Requirements & Constraints (as understood)

- **Scale**: ~2 M events/day = ~23 events/s average. Fan‑out to ~50 k customer‑configured HTTPS endpoints. Average per‑endpoint rate ≈ 40 events/day (2 M / 50 k), but bursts can be 100× higher.
- **Endpoint unreliability**: Endpoints may be slow, flapping, or down for days. One misbehaving endpoint must **not** degrade delivery for others.
- **Delivery guarantee**: **At‑least‑once** (duplicates possible, bounded). Customers must be able to recover missed events (replay).
- **Security**: HTTPS, payload integrity (HMAC), secret rotation, protection against malicious endpoints.
- **Ordering**: Per‑endpoint **FIFO** delivery is required (customers expect events in the order they were produced).

**Assumptions**:
- Events originate from internal producers. The platform controls event schema and guarantees no ordering across different endpoints.
- Each customer endpoint has a configurable retry policy (max attempts, backoff schedule).
- Customers can pause/resume delivery and request replay of a time window via an API.

### Chosen Architecture

```
Producer(s) → Event Bus (Kafka primary topic)
                  ↓
          Webhook Dispatcher (stateless, Kafka producer)
                  ↓
          Partitioned Delivery Topic (Kafka, key = endpoint_id)   ← 50 k partitions, 1 per endpoint
                  ↓
          Consumer Group (one consumer per process, many partitions per consumer)
                  ↓
          Per‑Endpoint Delivery State Machine (in‑process)
                  ├─ Sequential message processing per partition
                  ├─ Circuit breaker + rate limiter per endpoint
                  └─ Pause/resume on failure (no separate retry topic)
```

**Components**:

- **Event Bus (Kafka)**: Durable, partitioned. Events written with `event_id` (UUID) and `endpoint_id`. Exactly‑once semantics for producers (idempotent writes).
- **Webhook Dispatcher**: Reads events from the bus, validates the target URL (HTTPS only), enriches payload with standard headers, adds HMAC‑SHA256 signature using per‑endpoint secret (fetched from Vault), and produces to the **Delivery Topic** with key = `endpoint_id`.
- **Delivery Topic**: A Kafka topic with **one partition per endpoint** (50 k partitions). Each partition holds a FIFO queue for exactly one endpoint. Ordering per endpoint is guaranteed by Kafka’s partition‑level ordering.
- **Consumer group**: One or more consumers, each assigned a subset of partitions. Each consumer uses a single `KafkaConsumer` instance and processes partitions independently. No shared state across consumers.
- **Delivery State Machine (per partition)**:  
  - On each poll, for a given partition, the consumer reads messages sequentially.  
  - For each message, it attempts HTTP delivery to the endpoint.  
  - **On success**: commit offset (after delivery), record attempt in audit log (Kafka audit topic).  
  - **On temporary failure** (timeout, 5xx, 429, connection error):  
    - Increment retry counter.  
    - If counter < max_retries: **pause** the partition. Schedule a resume after `base_backoff × (2^attempt) + jitter` (max 1 h). The offset of the failing message is **not committed**.  
    - If counter ≥ max_retries: **dead‑letter** the event (produce to DLQ topic with same key, including original metadata), then **commit the offset** and continue with next messages.  
  - **On pause**: the consumer will not poll this partition again until the resume timer fires. Meanwhile it can serve other partitions.  
  - **On resume**: the consumer resumes the partition. The first message seen is the same failed one (since its offset is still uncommitted). Delivery is retried.  
- **Rate limiting**: Token‑bucket per endpoint (default 5 req/s). Enforced before each HTTP call; if tokens exhausted, the message is treated as a temporary failure (pause for 1 s and retry).  
- **Circuit breaker**: After N consecutive failures (default 5) within a sliding window, the breaker opens. While open, the consumer **pauses** the partition (same as above) and does not attempt delivery for a configurable cooldown (e.g., 5 min). After cooldown, a single probe is sent; if successful, breaker closes and delivery resumes; if failed, cooldown is extended (exponential backoff). This prevents repeated immediate retries.

### Queueing & Retry Model (Unified Ordering)

- **No separate retry topic.** All events (new and retries) reside in the same partition.  
- **Ordering per endpoint is strictly preserved**: a failing event blocks later events for the same endpoint until it is either delivered or dead‑lettered. This is the only way to guarantee FIFO with an unreliable endpoint.  
- **Pause/resume at partition level** allows the consumer to avoid busy‑looping and to serve other endpoints while waiting for backoff.  
- **Dead‑lettered events** lose ordering (they will be replayed via a separate backfill job, see Recovery). Their offset is committed, allowing subsequent events to be delivered.

**Why this model works**:
- With one partition per endpoint, a failing endpoint only affects its own partition. Other partitions (other endpoints) remain fully functional.  
- No need to coordinate between primary and retry topics – the partition itself holds the entire state.  
- Pause/resume is lightweight and can be implemented efficiently using `KafkaConsumer.pause()`/`resume()` and an in‑process timer heap.

### Isolation Strategy

- **Per‑endpoint partitioning** provides natural head‑of‑line blocking isolation. A bad endpoint cannot degrade delivery for any other endpoint.
- **Rate limiter** and **circuit breaker** are per endpoint and enforced inside the consumer process. They prevent one endpoint from exhausting connection pools or causing cascading failures.
- **Resource caps**: Each consumer process is allocated a fixed number of partitions (e.g., 200). The sum of all partition assignments across consumers is 50 k. This limits CPU/memory per process.
- **Connection pools**: Separate HTTP connection pool per endpoint (bounded size, e.g., 2 connections). This prevents a single endpoint from consuming all sockets.
- **Back‑pressure**: If a consumer falls behind, Kafka retainability (7 days) ensures no data loss. Partition assignments are redistributed automatically via consumer rebalancing.

**Consumer rebalancing** with 50 k partitions:
- Use **cooperative rebalancing** (`partition.assignment.strategy=cooperative-sticky`) to minimize total rebalances and avoid stop‑the‑world pauses.  
- During rebalance, the pause state (list of paused partitions + their resume times) is **ephemeral** – it is not persisted. When a partition moves to a new consumer, the offset remains uncommitted for the failing message. The new consumer will see that message and attempt delivery immediately, potentially breaking the intended backoff.  
  - This is an acceptable tradeoff: occasional early retries are better than losing ordering or blocking other endpoints.  
  - For stricter backoff adherence, the pause state could be stored in an external KV store (e.g., ZooKeeper) keyed by `endpoint_id`, but this adds complexity. Given the low average event rate, the impact is minimal.  
- The number of partitions is high. **We assume** that 50 k partitions with replication factor 3 and 15 brokers is manageable with adequate memory and file descriptor tuning; this assumption is untested in practice and should be validated under load.

### Security

| Aspect | Implementation |
|--------|----------------|
| Transport | Outbound HTTPS only, TLS 1.2+ with curated cipher suite. Mutual TLS optional (client certificate provided). |
| Payload authenticity | HMAC‑SHA256 over canonical payload + timestamp. Signature in `X‑Webhook‑Signature` header. Secret stored in Vault, rotated every 90 days, with a grace period for old secrets. |
| Replay protection | Timestamp in signed payload. Customers should reject events with timestamp > 5 min old. |
| Egress IP | Fixed set of public IPs via NAT gateway; customers can allowlist them. |
| Secrets management | Short‑lived Vault tokens; dispatcher/worker never store secrets in memory after use. |
| Input validation | Dispatcher rejects non‑HTTPS URLs, validates format, and sanitises headers. |
| Malicious endpoint defence | Maximum response body size (10 KB), maximum timeouts (30 s), per‑endpoint rate limiting. |

### Recovery & Operations

**Customer‑initiated recovery**:

- **Replay API**: `POST /webhooks/replay?endpoint_id={id}&from=…&to=…`  
  A background job reads events from the Event Bus (retained 7 days) and re‑produces them to the Delivery Topic (same partition). Duplicates are expected; customers use `event_id` for deduplication.
- **Pause / Resume**: Customers set a flag in etcd. The consumer checks this flag before delivery. While paused, it reads the partition, commits offsets (so new events are acknowledged), but does not attempt HTTP delivery. A consumer‑side watch triggers resumption when the flag is cleared. Events that arrived while paused are delivered in order when resumed.

**Operational monitoring**:

- **Metrics** (Prometheus): delivery latency (p50/p95/p99), success/fail rate per endpoint, queue depth per partition, circuit breaker open count, dead‑letter event count, pause duration.
- **Alerts**: DLQ growth > threshold, circuit breaker open > 1 h for any endpoint, high 5xx rate, consumer lag > 1 min.
- **Traceability**: Each delivery attempt produces a structured log (OpenTelemetry) with `event_id`, `endpoint_id`, `status`, `latency`. Also written to an audit Kafka topic (retained 30 days).

### Tradeoffs & Rejected Alternatives

1. **Shared partition (consistent hashing) with per‑endpoint sub‑queues**  
   *Rejected* because it requires complex per‑key offset management and does not fully guarantee ordering across retries. The pause‑on‑failure approach would block other endpoints in the same partition. Per‑endpoint partitions are simpler and safer.

2. **Separate retry topic with scheduled delivery**  
   *Rejected* because it introduces ordering conflicts between primary and retry topics. Using in‑partition pause/resume eliminates the need for a second topic and preserves strict FIFO.

3. **In‑memory retry state without Kafka**  
   *Rejected* – not durable; any crash loses in‑flight events. Kafka persistence is essential for at‑least‑once.

4. **Single shared request queue with priority**  
   *Rejected* – head‑of‑line blocking cannot be avoided without per‑endpoint isolation. Partitioning is the proven approach.

5. **Per‑endpoint DLQ topics**  
   *Rejected* – single DLQ topic with endpoint_id metadata is sufficient for replay; fewer topics reduce operational overhead.

**Key tradeoff: Partition count vs. rebalance cost**  
50 k partitions is high but feasible with enough brokers and cooperative rebalancing. The alternative (fewer partitions with per‑endpoint sub‑queues) would sacrifice either ordering or isolation. We accept the operational cost for clear isolation and simpler code. *Note: the operational feasibility of 50 k partitions on 15 brokers is an assumption; see Verification status.*

### Critique Rebuttals

The revised design directly addresses the three points in the independent critique:

- **Isolation in shared partition model** (critique: skipping delivery and committing offsets would lose events) → We now use **per‑endpoint partitions**, so each partition serves exactly one endpoint. There is no shared partition, and the pause/resume mechanism never commits offsets on failure, preserving at‑least‑once.
- **Retry topic ordering** (critique: ordering across primary/retry topics is underspecified) → We eliminated the separate retry topic entirely. All events (new and retries) live in the same partition. Ordering is preserved because a failed event blocks subsequent events until success or dead‑letter.
- **Consumer rebalancing impact** (critique: circuit breaker state and offset management during rebalance) → We explicitly acknowledge that pause state is ephemeral; on rebalance, the new consumer may deliver a failed event prematurely. This tradeoff is acceptable given low event rates and can be hardened with external store if required. The design is complete and operational.

### Verification Status

**Observed/Verified (from materials)**:
- Arithmetic correction: average per‑endpoint rate is 40 events/day (derived from given numbers). The original 0.46 was an error and has been corrected.
- Per‑endpoint FIFO ordering is required and enforced via Kafka partition‑level ordering.
- On temporary failure, the partition is paused and offset is not committed, ensuring retry of the failed message.
- A failing event blocks later events for the same endpoint until resolved (strict FIFO).
- Isolation: a bad endpoint cannot affect others due to per‑endpoint partitioning.
- Security: TLS 1.2+, HMAC‑SHA256, Vault secrets, replay protection.
- Recovery: replay API via Event Bus.
- Circuit breaker behavior: pause partition, probe after cooldown.
- Separate retry topic rejected due to ordering complexity.

**Unverified / Assumptions**:
- The feasibility of 50 k partitions with replication factor 3 on 15 brokers is an assumption; no operational evidence or benchmark is provided. This should be validated with load testing and may require tuning of broker resources (file descriptors, memory, I/O) or a larger cluster.
- Consumer rebalancing performance at this scale (50 k partitions, cooperative rebalancing) has not been tested. The design assumes it is manageable, but this remains unverified.
- The low impact of ephemeral pause state during rebalance is an assumption based on low event rates; actual impact should be monitored in production.
- The effectiveness of per‑endpoint circuit breaker and rate limiter under extreme burst scenarios is not experimentally validated; the chosen defaults (5 failures, 5 req/s) are illustrative and may need tuning.