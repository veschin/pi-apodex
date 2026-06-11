// Design bucket: system design under constraints, scored against a LOCKED
// rubric of required failure-mode handling. Each rubric item is a strict
// yes/no check; vague mentions do not pass.

import { scoreDesignRubric, type RubricItem } from "../scoring.ts";
import type { EvalTask } from "../types.ts";

// ---------------------------------------------------------------------------

const rateLimiterPrompt = `Design a distributed rate limiter for a public HTTP API.

Constraints:
- ~10,000 RPS aggregate, 30 API gateway nodes, Redis cluster available.
- Per-API-key limits (e.g. 100 req/min) plus a global service ceiling.
- Added latency budget: p99 < 5 ms for the limit check.
- Limits must hold approximately even during node restarts and deploys.

Deliver a concrete engineering design: algorithm, data layout, failure handling,
operational concerns. State tradeoffs and what you rejected.`;

const rateLimiterRubric: RubricItem[] = [
  { id: "algo", requirement: "Chooses a concrete rate-limiting algorithm (e.g. token bucket, sliding window counter/log, GCRA) and justifies the choice against the stated constraints." },
  { id: "atomicity", requirement: "Addresses race conditions / atomicity of the check-and-update step across concurrent gateway nodes (e.g. Lua script / atomic Redis ops / CAS) with a concrete mechanism." },
  { id: "redis-down", requirement: "Defines behavior when Redis is unavailable or slow, including an explicit fail-open vs fail-closed decision with its rationale." },
  { id: "latency", requirement: "Explains how the p99 < 5 ms budget is met (e.g. local caching/batching, pipelining, hot-path design), not just asserts it." },
  { id: "hot-keys", requirement: "Addresses hot keys or shard skew (one API key hammering one Redis shard) with a concrete mitigation." },
  { id: "429", requirement: "Specifies the over-limit client contract: HTTP 429 (or equivalent) plus limit/remaining/retry headers or a documented backoff contract." },
  { id: "alternative", requirement: "Names at least one rejected alternative design and gives a concrete reason for rejecting it." },
  { id: "observability", requirement: "Covers observability: metrics/alerts for limiter health, rejection rates, or limit saturation." },
];

// ---------------------------------------------------------------------------

const webhookPrompt = `Design a reliable webhook delivery subsystem for a SaaS platform.

Constraints:
- ~2M events/day fan out to ~50k customer-configured HTTPS endpoints.
- Customer endpoints are unreliable: slow, flapping, sometimes down for days.
- Delivery guarantee: at-least-once; customers demand both security and the
  ability to recover missed events.
- One misbehaving endpoint must not degrade delivery for others.

Deliver a concrete engineering design: queueing/retry model, isolation, security,
recovery, operations. State tradeoffs and what you rejected.`;

const webhookRubric: RubricItem[] = [
  { id: "queue-retry", requirement: "Specifies a persistent queue with a concrete retry policy including backoff schedule (e.g. exponential with caps) for failed deliveries." },
  { id: "isolation", requirement: "Provides per-endpoint isolation (per-destination queues/partitions, concurrency caps, or circuit breakers) so one dead endpoint cannot starve or delay others." },
  { id: "idempotency", requirement: "Addresses at-least-once consequences for consumers: idempotency keys / event IDs / dedup guidance." },
  { id: "signing", requirement: "Secures payloads concretely: HMAC signature (or equivalent) with key management or rotation mentioned." },
  { id: "dlq-replay", requirement: "Includes a dead-letter mechanism AND a customer-facing recovery path (replay/redrive of missed events)." },
  { id: "ordering", requirement: "Honestly states the ordering guarantees (or explicit lack thereof) and what consumers should assume." },
  { id: "alternative", requirement: "Names at least one rejected alternative design and gives a concrete reason for rejecting it." },
  { id: "observability", requirement: "Covers observability: delivery success rates, queue depth/age, per-endpoint health visibility or alerting." },
];

// ---------------------------------------------------------------------------

const dedupPrompt = `Design content-addressable deduplicated blob storage for an internal backup
product.

Constraints:
- ~100 TB logical data, target dedup ratio >= 3x, single region.
- Writers upload large files (1 MB - 500 GB); concurrent uploads of identical
  content are common.
- Deleting a backup must eventually reclaim space, but never corrupt other
  backups that share chunks.
- Commodity object storage (S3-compatible) underneath; a relational DB or KV
  store is available for metadata.

Deliver a concrete engineering design: chunking, addressing, metadata, garbage
collection, failure handling. State tradeoffs and what you rejected.`;

const dedupRubric: RubricItem[] = [
  { id: "chunking", requirement: "Chooses a chunking strategy (fixed-size vs content-defined chunking) and justifies it with the dedup-ratio / shift-resistance tradeoff." },
  { id: "hashing", requirement: "Specifies the content hash (e.g. SHA-256) and takes an explicit stance on collision handling/probability." },
  { id: "gc", requirement: "Designs garbage collection of unreferenced chunks concretely (ref-counting or mark-and-sweep) including how correctness is kept under concurrency." },
  { id: "gc-race", requirement: "Addresses the specific race between concurrent upload (re-using a chunk) and deletion/GC of that same chunk, with a concrete mechanism (e.g. grace period, two-phase delete, ref pinning)." },
  { id: "partial-upload", requirement: "Handles failure mid-upload: partial state must not corrupt or orphan data permanently (atomic manifest commit, resumable upload, or cleanup)." },
  { id: "metadata-scale", requirement: "Addresses metadata store scaling for billions of chunk records (sharding/partitioning, index size, or caching), not just names a database." },
  { id: "alternative", requirement: "Names at least one rejected alternative design and gives a concrete reason for rejecting it." },
  { id: "integrity", requirement: "Covers integrity verification (checksum validation on read/write or scrubbing) or honestly bounds corruption risk." },
];

export const designTasks: EvalTask[] = [
  {
    id: "design-rate-limiter",
    bucket: "design",
    prompt: rateLimiterPrompt,
    score: (answer, ctx) => scoreDesignRubric(answer, rateLimiterRubric, ctx),
  },
  {
    id: "design-webhooks",
    bucket: "design",
    prompt: webhookPrompt,
    score: (answer, ctx) => scoreDesignRubric(answer, webhookRubric, ctx),
  },
  {
    id: "design-dedup-store",
    bucket: "design",
    prompt: dedupPrompt,
    score: (answer, ctx) => scoreDesignRubric(answer, dedupRubric, ctx),
  },
];
