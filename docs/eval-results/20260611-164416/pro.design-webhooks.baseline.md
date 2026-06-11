# Webhook Delivery Subsystem Design

## 1. Requirements & Constraints

| Requirement | Detail |
|-------------|--------|
| Throughput | ~2 M events/day; fan‑out to ~50 K customer HTTPS endpoints → ~20 M delivery attempts/day (peak ~500 req/s). |
| Guarantee | At‑least‑once delivery with idempotency keys for deduplication. |
| Resilience | Endpoints are unreliable (slow, flaky, down for days). One misbehaving endpoint must **not** degrade others (strong isolation). |
| Retry model | Persistent retries with backoff; after multiple failures → dead letter queue. |
| Recovery | Ability to replay missed events on demand. |
| Security | HTTPS, per‑endpoint HMAC signature, secrets stored in vault. |
| Operations | Observability, per‑endpoint health, manual redrive, pause/resume. |

**Assumptions** (explicit):
- Average fan‑out: **10 endpoints per event** → steady ~230 deliveries/s, peak ~500 deliveries/s.
- Maximum payload size: 1 MB.
- Customers can configure per‑endpoint concurrency (default: **5** simultaneous requests).
- State is fully durable – nothing lost on restart.

---

## 2. High‑Level Architecture

```
[Internal Services]
        │
        ▼
┌──────────────────┐    ┌─────────────────┐    ┌──────────────────┐
│   Event Outbox   │───▶│  Fan‑out Service │───▶│ RabbitMQ Cluster │
│  (PostgreSQL)    │    │  (subscription   │    │  (per‑endpoint   │
└──────────────────┘    │   cache + router)│    │   queues)        │
                        └─────────────────┘    └────────┬─────────┘
                                                         │
                                                         ▼
                                              ┌────────────────────┐
                                              │ Delivery Workers   │
                                              │ (pool of instances │
                                              │  consuming from    │
                                              │  many queues)      │
                                              └────────┬───────────┘
                                                       │
                                                       ▼
                                          Customer HTTPS Endpoints
```

**Data flow:**
1. Producer writes event to an **outbox table** in PostgreSQL (transactional).
2. A relay (Debezium or custom outbox poller) publishes the event as a message to a RabbitMQ *fan‑out* exchange.
3. **Fan‑out Service** consumes the event, resolves the list of target endpoints (subscription DB, cached), and **publishes a delivery job** to the dedicated queue of each endpoint.
4. **Delivery Workers** run one consumer (prefetch=1) per queue, perform the HTTPS POST, and handle retry / dead‑letter.

---

## 3. Queueing & Routing Model

### 3.1 Per‑endpoint queues – true isolation

Each configured endpoint gets **one dedicated delivery queue**:
```
webhook.delivery.<endpoint_id>
```
The fan‑out service publishes directly to these queues using a RabbitMQ *direct* exchange (`webhook.delivery`) with routing key equal to `endpoint_id`.

**Why per‑endpoint queues?**  
- A slow or stuck endpoint blocks **only its own consumers**, never affecting others.  
- Concurrency limit is enforced by the number of consumers attached to that queue (prefetch=1 → exactly N concurrent in‑flight requests).  
- It is trivial to pause/resume a single endpoint by stopping/starting its consumers.  
- 50 K queues are well within RabbitMQ’s capabilities (quorum queues for safety).

### 3.2 Retry scheduling with the Delayed Message Plugin

RabbitMQ’s [`x-delayed-message`](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) plugin allows **per‑message delay** without head‑of‑line blocking.

- A single **delayed exchange** (`webhook.retry`) of type `x-delayed-message` is created (argument: `x-delay` header).
- On failure (non‑2xx, timeout, network error):
  1. Increase `x-retry-count` in the message header.
  2. If `retry-count < MAX_RETRIES` → publish a **copy** of the message to `webhook.retry` with header `x-delay = backoff_ms`.
  3. ACK the original delivery (removing it from the delivery queue).
- After the delay, the delayed exchange routes the message back to the delivery exchange using the original routing key → the message reappears in the endpoint’s delivery queue.
- If `retry-count >= MAX_RETRIES` → publish to a shared **Dead Letter Queue** (DLQ) `webhook.dlq`, store failure details (error, timestamp, last status code).

**Backoff policy** (configurable per tenant? Default):
| Attempt | Delay        |
|---------|--------------|
| 1       | 1 min        |
| 2       | 5 min        |
| 3       | 15 min       |
| 4       | 30 min       |
| 5       | 1 h          |
| 6       | 2 h          |
| 7       | 4 h          |
| 8       | 8 h          |
| 9       | 16 h         |
| 10      | 24 h         |

After attempt 10 the message lands in the DLQ; manual or automated recovery can redeliver it later.

### 3.3 Event persistence & recovery

All **original events** are stored in the **event outbox table** (and archived).  
- The outbox record includes event ID, type, version, payload.
- The DLQ stores the full delivery context (event ID + endpoint ID + attempt timestamp).  
- A customer‑facing Replay API (`POST /endpoints/{id}/replay?since=...`) can **re‑publish** events from the event store to the endpoint’s delivery queue. Because every delivery carries the event ID, the customer can safely deduplicate.

---

## 4. Isolation Details

### 4.1 Per‑endpoint concurrency & circuit breaker

- **Concurrency**: Each delivery queue has **N consumers** (default N=5). Each consumer uses `prefetch=1` and processes messages sequentially. Thus at most N simultaneous requests per endpoint. N is configurable per endpoint.
- **Circuit breaker** (implemented in the worker process per consumer):
  - Sliding window of last M deliveries.  
  - If failure rate exceeds threshold (e.g., >80% in the last 20 attempts) **and** the endpoint is not responding at all → **pause all consumers** for that queue for a cool‑down period (e.g., 2 minutes).  
  - After cool‑down, one consumer resumes in **half‑open** state; success resets the breaker and resumes all consumers; failure triggers a longer pause.
- **Timeout**: HTTP client has a default connect timeout of 3 s and read timeout of 5 s; these can be overridden per endpoint.

These measures guarantee that an endpoint returning 500s or hanging will never consume a disproportionate share of worker connections.

### 4.2 Worker pool design

A set of stateless worker instances (Kubernetes pods) connect to RabbitMQ. Each worker:
- Maintains a long‑lived AMQP connection with multiple channels.
- For every assigned endpoint, starts up to **max_concurrency** consumer goroutines using `basic.consume`.
- Queue‑to‑worker assignment is done via **consistent hashing** (e.g., using a Rendezvous hash of the endpoint ID) so that queues are evenly distributed and failover is fast when workers come/go.
- Worker instances register in a coordination service (Redis or the cluster itself) so that the number of active consumers per queue never exceeds the desired concurrency; a small controller adjusts consumer counts across the pool.

---

## 5. Security Design

- **Transport**: all outbound requests use HTTPS (TLS 1.2+). Custom CA certificates can be pinned per endpoint if the customer provides one.
- **Authentication**: HMAC‑SHA256 request signing.
  - A per‑endpoint secret is generated at creation time (256‑bit random) and stored in **HashiCorp Vault** (or AWS Secrets Manager). It is **never** logged or returned after initial reveal.
  - For each delivery, the worker retrieves the secret (with caching, TTL 5 min) and computes:
    ```
    signature = HMAC-SHA256(secret, "{timestamp}.{request_body}")
    ```
  - Headers set:
    ```
    X-Webhook-Signature: t=<unix_seconds>, v1=<base64(signature)>
    ```
- **Customer verification**: customers can validate the signature with the shared secret and tolerate a small clock skew (e.g., ±2 minutes).
- **IP allowlisting** (optional): on customer request, the delivery infrastructure can be pinned to a set of static egress IPs.
- **Idempotency**: every request includes `X-Webhook-Event-Id` (unique event identifier). Customers can use it to deduplicate.

---

## 6. Recovery & Reprocessing

- **DLQ inspection**: a cron job or admin UI lists messages in `webhook.dlq`, grouped by endpoint. Operators can **redeliver** selected messages (or a batch) back to the delivery queue after the endpoint issue is resolved.
- **Replay API** (customer‑facing):
  - `POST /endpoints/{id}/replay` with optional `?since=ISO8601&event_type=...` → the system reads events from the **event store**, re‑publishes them to the endpoint queue. Rate‑limited to avoid overwhelming the customer.
- **Dead‑letter retention**: messages in DLQ are kept for 30 days; the event store retains events for 90 days by default. This gives customers a generous window to recover.

---

## 7. Operational Toolkit

### 7.1 Observability
- **Metrics**: delivery attempts, successes, failures (by status code), retry counts, DLQ depth, per‑endpoint latency (p50/p99), circuit‑breaker state. Exported to Prometheus/Grafana.
- **Logging**: structured logs (JSON) with correlation IDs: event ID, endpoint ID, attempt number.
- **Alerting**: DLQ growth rate > 10/min, global failure rate spike, per‑endpoint failure rate > 90% for more than 10 minutes.

### 7.2 Administration
- **Pause/Resume endpoint**: API call toggles the consumers for that queue (via a control topic consumed by workers).
- **Secret rotation**: API to generate a new secret; old secret remains active for a grace period (configurable) so in‑flight deliveries are not rejected.
- **Rate limiting**: global outbound throttle (e.g., 1000 concurrent connections across all workers) to protect our own infrastructure.

### 7.3 Scalability
- **Fan‑out Service**: stateless; scales horizontally with Kafka or RabbitMQ consumer groups.
- **Delivery Workers**: stateless; scale by adding more pods; the queue‑to‑worker balancing re‑distributes consumers automatically.
- **RabbitMQ**: quorum queues (replicated, durable) on a 3‑node cluster; can be scaled by adding nodes and rebalancing queues.
- **Database**: subscriptions and event outbox are in separate RDBMS (or the same) with read replicas for fan‑out service; outbox relay ensures no hot‑spot.

---

## 8. Rejected Alternatives

| Alternative | Reason for rejection |
|-------------|----------------------|
| **Single shared delivery queue for all endpoints** | Inevitable head‑of‑line blocking: a single hung endpoint consumes a worker and delays all others. Per‑endpoint concurrency control would be complex and fragile. |
| **Retry by rescheduling to the same queue with `visibility timeout` (e.g., SQS)** | SQS’s per‑message delay is limited to 12 hours; we need delays up to 24 h. Would need a separate scheduler, adding complexity. Per‑endpoint SQS queues would require 50 K queues × long‑polling connections – too many network resources. |
| **Kafka + external state store for retries** | Kafka is excellent for event streaming but poor at per‑message scheduling with long, variable delays. Would require a separate scheduler and state handling, increasing operational burden. |
| **Serverless function per endpoint** | Not feasible at 50 K endpoints (cold starts, connection limits, cost). Making one misbehaving endpoint not impact others would be impossible without a queue layer anyway. |
| **No circuit breaker, only concurrency limit** | A flaky endpoint that answers slowly could still tie up its allotted concurrency slots for long periods, causing high latency for that endpoint and possibly filling up memory buffers. The circuit breaker proactively pauses work, saving resources. |
| **Database‑only job queue (PostgreSQL `FOR UPDATE SKIP LOCKED`)** | For 500 req/s, lock contention and constant polling can become a performance challenge, and building a multi‑node “consumer” with per‑endpoint isolation would require row‑level advisory locks and complex scheduling. Dedicated queues are purpose‑built for this. |

---

## 9. Verification Strategy

The design has been simulated conceptually, but real‑world verification would include:
- **Load tests** with 50 K synthetic endpoints, varying failure modes, to prove isolation under stress.
- **Chaos engineering**: kill worker pods, split network, flood DLQ – confirm no cross‑endpoint impact.
- **Security audit**: penetration test on the signing mechanism, secret leakage paths.
- **Scale test**: ramp to 2× peak throughput, observe queue depths and latency.

*(No executed tests provided here; this is an architectural design document.)*