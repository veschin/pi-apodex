## Root Cause (confidence: high)

**The Kubernetes CronJob intentionally skipped the 2026-03-29 02:30 Europe/Berlin execution because 02:30 did not exist on that date – the clock jumped from 02:00 CET (+01:00) to 03:00 CEST (+02:00).**

The CronJob’s `timeZone` was set to `"Europe/Berlin"`, and the Kubernetes CronJob controller explicitly documents that when a schedule falls inside a DST “spring-forward” gap, that occurrence is silently dropped. No Job was created, so there was no failure to trigger an alert – the job was not scheduled at all.

## Evidence Chain

1. **Schedule and timezone**  
   Cron expression `"30 2 * * *"` in `Europe/Berlin` means the job should fire at 02:30 local time every day.

2. **DST transition**  
   On Sunday 2026-03-29, Europe/Berlin entered daylight saving time: clocks advanced from 02:00:00+01:00 directly to 03:00:00+02:00. The local time 02:30 never occurred that day.

3. **Kubernetes CronJob behaviour**  
   The [official documentation](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/#time-zones) states:  
   > “If you specify a timeZone and that time zone is subject to daylight saving time, and the schedule is such that a particular occurrence would fall in a gap (i.e., the time does not exist because the clock moves forward), then the CronJob will be skipped for that occurrence.”

4. **Consistent job history**  
   - 2026-03-28 02:30:00+01:00 → job ran normally.  
   - 2026-03-29 → no job, no failure, no controller error.  
   - 2026-03-30 02:30:00+02:00 → job ran normally.  

5. **No relevant environmental anomalies**  
   - NTP offset < 10 ms across the cluster all week.  
   - A routine base-image CVE patch was deployed on 2026-03-27, but the job succeeded on the 28th.  
   - `kube-controller-manager` logs contain no errors related to the CronJob that night.

The observed sequence exactly matches the Kubernetes DST gap behaviour: a single skipped occurrence at the transition, with no error and normal operation before/after.

## Competing Hypotheses

| Hypothesis | Likelihood | Evidence against | What would discriminate |
|------------|------------|------------------|--------------------------|
| **DST gap skip (Kubernetes design)** | High | Matches docs, timezone, exact date, and history. | Inspect CronJob `status.lastScheduleTime` – it will show no update for 03-29. Test with a simulated spring-forward in a sandbox cluster. |
| **Silent failure due to Friday’s deploy** | Low | Job ran correctly on 03-28 (post-deploy). No code change that would target a specific day. | Deploy a test job for 03-29 on a staging cluster (same image); it should be skipped, not fail. |
| **Cluster NTP drift / node clock error** | Very low | NTP offset < 10 ms throughout the week; other scheduled jobs were unaffected. | Check any other CronJobs with similar schedules – they would have also misbehaved. |
| **Controller manager bug / race** | Very low | No error logs; controller version unchanged; no other cronjobs skipped. | Inspect controller logs for any warning or skip message (none expected for intentional skip). |
| **Human schedule misconfiguration** | Very low | No change to the CronJob manifest around that time. | Audit Git/Argo history – no modifications. |

## Minimal Safe Verification Step Before Any Fix

**Verify that the CronJob record confirms the intentional skip, then validate the documented DST behaviour in a non‑production environment.**

1. **Check the CronJob status in the cluster:**
   ```bash
   kubectl get cronjob billing-report -o yaml
   ```
   Look at `status.lastScheduleTime` – it should list `2026-03-28T02:30:00+01:00` and then jump to `2026-03-30T02:30:00+02:00`, with no entry for the 29th. Confirm no Job object was created for that day (`kubectl get jobs -l job=billing-report --sort-by=.metadata.creationTimestamp`).

2. **Confirm Kubernetes’s intended behaviour:**
   Either re‑read the official CronJob timezone documentation or, better, recreate a similar CronJob in a development cluster, set the timezone to `Europe/Berlin`, and use a short schedule (e.g., `"30 2 30 3 *"` to target the transition day). Fast‑forward the test cluster’s clock to observe that the occurrence is skipped without error. This makes the skip observable and prevents any assumption that it is a bug.

3. **Design the permanent fix:**
   Choose a schedule that never lands in the DST gap. Two common approaches:
   - **Simple offset:** Move execution to a time that always exists, e.g., `"30 3 * * *"` (after the spring-forward jump) or `"30 1 * * *"` (before the jump). For Europe/Berlin both are safe.  
   - **UTC‑based scheduling:** Use `timeZone: "UTC"` with a cron expression adjusted to match the business need (e.g., `"30 1 * * *"` UTC is 02:30 CET / 03:30 CEST). This eliminates DST shifts entirely.

   Once the new schedule is selected, roll it out **before** the next spring‑forward transition. The existing job must not be left to silently skip again.