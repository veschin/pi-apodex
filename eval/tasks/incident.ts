// Incident bucket: symptom + logs -> diagnosis, checked against the known root
// cause. Confidently-wrong diagnoses are penalized (tracked separately).

import { scoreIncidentDiagnosis } from "../scoring.ts";
import type { EvalTask } from "../types.ts";

// ---------------------------------------------------------------------------
// Incident 1: connection pool exhaustion via leak on an early-return error path.
// Red herrings: recent deploy also bumped pool lib version; CPU is fine; restart "fixes" it.

const poolPrompt = `Diagnose this production incident. Name the most likely root cause, your
confidence, the evidence chain, competing hypotheses, and the minimal safe
verification step before any fix.

## Symptom
Node.js API service. Starting ~40 minutes after each deploy, requests to several
endpoints hang ~5s and fail with "timeout exceeded when trying to connect" from
the Postgres pool (pg-pool). A service restart clears it for another ~40 minutes.
Traffic is flat; DB CPU < 20%; no slow-query alerts.

## Facts
- Deploy diff includes: pg-pool 3.6.1 -> 3.7.0 bump, and a new feature in
  getUserPrefs() (below).
- Pool config: max=10, connectionTimeoutMillis=5000, idleTimeoutMillis=10000.
- pg_stat_activity during the incident: 10 connections from this service, all
  state='idle', several with state_change > 20 minutes old.
- Log excerpts (during incident):
    [pool] waiting for available connection (queue depth 37)
    [api] GET /prefs 500 timeout exceeded when trying to connect
- Metrics: pool "acquired" counter rises steadily after deploy; "released"
  counter plateaus below it. Gap grows roughly with /prefs traffic.

## New code in the deploy
\`\`\`js
async function getUserPrefs(userId) {
  const client = await pool.connect();
  const res = await client.query("SELECT prefs FROM user_prefs WHERE user_id = $1", [userId]);
  if (res.rows.length === 0) {
    return DEFAULT_PREFS;            // new fast path added this deploy
  }
  const prefs = parsePrefs(res.rows[0].prefs); // parsePrefs may throw on legacy rows
  client.release();
  return prefs;
}
\`\`\`

What is the root cause?`;

const poolRootCause = `Connection leak in getUserPrefs(): the early return for the empty-rows fast
path (and the throwing parsePrefs path) skip client.release(), so checked-out
clients are never returned to the pool. With max=10 the pool exhausts after
enough /prefs requests, all connections sit 'idle' in Postgres (checked out but
unused), and new acquires time out after connectionTimeoutMillis=5000. The
pg-pool version bump is a red herring. Fix shape: release in a finally block.`;

// ---------------------------------------------------------------------------
// Incident 2: cache stampede on hot key expiry.
// Red herrings: GC pauses suspected; a cron job runs every 10 min too.

const stampedePrompt = `Diagnose this production incident. Name the most likely root cause, your
confidence, the evidence chain, competing hypotheses, and the minimal safe
verification step before any fix.

## Symptom
Read-heavy product-catalog service (12 instances behind LB). Every ~10 minutes,
p99 latency spikes from 40ms to 3-8s for ~15 seconds, and the primary DB CPU
pegs at 100% for the same window. Between spikes everything is calm.

## Facts
- The catalog landing payload is cached in Redis under key "catalog:landing:v2"
  with TTL 600 seconds, populated on-demand (cache-aside: on miss, query DB,
  set key).
- Building that payload runs an expensive 1.2s aggregate query on the DB.
- During a spike, DB logs show the SAME aggregate query executing 300-700 times
  concurrently from all 12 instances.
- Redis monitoring: GET catalog:landing:v2 returns nil at the start of each
  spike window; SET arrives ~1-2s later, then hundreds more SETs of the same key.
- A cleanup cron also runs every 10 minutes on a different host (it only
  deletes temp files; DB user 'cron_ro' shows no queries in the window).
- GC pause logs on service instances: max 45ms, no correlation with spikes.

What is the root cause?`;

const stampedeRootCause = `Cache stampede (dogpile) on the hot key "catalog:landing:v2": when its 600s TTL
expires, every instance and every concurrent request misses simultaneously and
all of them run the expensive 1.2s aggregate against the DB (hundreds of
identical concurrent queries), pegging DB CPU until one SET repopulates the key.
The 10-minute periodicity is exactly the TTL. The cron job and GC are red
herrings. Fix shape: single-flight/lock around recompute, stale-while-revalidate,
or jittered/refresh-ahead expiry.`;

// ---------------------------------------------------------------------------
// Incident 3: DST nonexistent local time skips a cron job.
// Red herrings: a deploy the same week; NTP drift suspicion.

const dstPrompt = `Diagnose this production incident. Name the most likely root cause, your
confidence, the evidence chain, competing hypotheses, and the minimal safe
verification step before any fix.

## Symptom
A nightly billing-report job did not run on Sunday 2026-03-29. No alert fired
from the job itself (it alerts on failure, and there was no failure - and no run).
On all other days, including the following Monday, it ran normally.

## Facts
- Schedule: cron expression "30 2 * * *" with timezone Europe/Berlin
  (scheduler: a k8s CronJob with timeZone: "Europe/Berlin").
- Job history: ran 2026-03-28 at 02:30:00+01:00; NO entry for 2026-03-29;
  ran 2026-03-30 at 02:30:00+02:00.
- Europe/Berlin switched to daylight saving time on Sunday 2026-03-29:
  clocks jumped from 02:00:00+01:00 directly to 03:00:00+02:00.
- A routine deploy of the report image happened Friday 2026-03-27 (only a
  base-image CVE patch; job ran fine on the 28th).
- Node NTP offset on the cluster: < 10ms all week.
- The kube-controller-manager logs contain no error for the CronJob that night.

What is the root cause and what should be done so the report is not silently
skipped at the next DST transition?`;

const dstRootCause = `The job's scheduled local time 02:30 Europe/Berlin did not exist on
2026-03-29: the spring-forward DST transition jumped clocks from 02:00 CET
straight to 03:00 CEST, so a cron scheduled inside the skipped 02:00-03:00
window was never triggered. Nothing failed - the trigger time simply never
occurred. The deploy and NTP are red herrings. Fix shape: schedule outside the
DST-skipped window (or in UTC), and/or add absence-of-run alerting (dead man's
switch) rather than failure-only alerting.`;

export const incidentTasks: EvalTask[] = [
  {
    id: "incident-pool-leak",
    bucket: "incident",
    prompt: poolPrompt,
    score: (answer, ctx) => scoreIncidentDiagnosis(answer, poolRootCause, ctx),
  },
  {
    id: "incident-stampede",
    bucket: "incident",
    prompt: stampedePrompt,
    score: (answer, ctx) => scoreIncidentDiagnosis(answer, stampedeRootCause, ctx),
  },
  {
    id: "incident-dst-cron",
    bucket: "incident",
    prompt: dstPrompt,
    score: (answer, ctx) => scoreIncidentDiagnosis(answer, dstRootCause, ctx),
  },
];
