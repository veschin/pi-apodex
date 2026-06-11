## Diagnosis: Nightly Billing‑Report Job Skipped on DST Spring‑Forward Day

### Observed Facts
- **Schedule:** `30 2 * * *` with timezone `Europe/Berlin` (Kubernetes CronJob with `timeZone: "Europe/Berlin"`).
- **History:**
  - 2026‑03‑28 (Saturday) → **ran** at `02:30:00+01:00` (CET).
  - 2026‑03‑29 (Sunday) → **no run** – no Job creation, no failure alert.
  - 2026‑03‑30 (Monday) → **ran** at `02:30:00+02:00` (CEST).
- **DST Transition:** Europe/Berlin switches to daylight saving time on 2026‑03‑29 at `02:00:00+01:00`, jumping directly to `03:00:00+02:00`. The time `02:30` **does not exist** on that date.
- **Infrastructure:** Node NTP offset < 10ms all week; a routine CVE patch was deployed on Friday 27th, but the job ran fine on Saturday; kube‑controller‑manager logs show **no error** for the CronJob that night.

### Most Likely Root Cause
**The cron schedule `30 2 * * *` fell into the local‑time gap caused by the spring‑forward DST transition in the `Europe/Berlin` timezone.** Because `02:30` never occurred on 2026‑03‑29, the Kubernetes CronJob controller (which respects local‑time rules) correctly skipped the schedule. No job was created, no failure was raised, and no alert fired.

**Confidence: 95%** – every fact aligns exactly with standard cron DST gap behaviour. The alternative explanations below are far less likely given the available evidence.

### Evidence Chain
1. The missing run occurs precisely on the DST transition date; runs on adjacent days are normal.
2. The cron expression (`30 2`) targets a time that lies inside the 1‑hour gap (02:00–03:00 CET) that is skipped when clocks spring forward.
3. The timezone is set explicitly to `Europe/Berlin`, so the controller uses the local timezone definition including DST rules.
4. The job ran normally on Monday after the transition, showing the infrastructure and image are fine.
5. No controller errors – the controller does not consider a missing schedule within a gap to be an error; it’s expected behaviour for most cron implementations.
6. NTP skew is negligible, ruling out clock drift as a cause.
7. The CVE patch deploy on Friday had no effect on Saturday’s run and is unrelated.

### Competing Hypotheses

| Hypothesis | Evidence that would discriminate |
|------------|----------------------------------|
| **Controller bug** – the CronJob controller missed the event due to transient failure (e.g., watch cache corruption, pod restart). | • Look for controller‑manager restarts or error logs at 02:30 on 2026‑03‑29 (none reported). • Check if the CronJob’s `.status.lastScheduleTime` is set (it would be empty if skipped; if a bug caused a schedule attempt that failed, it would still set a time). |
| **Timezone database inconsistency** – The controller’s tzdata did not match the actual DST rule. | • Compare the system tzdata of the controller pod (or node) with IANA tzdata. • If the database were outdated, the transition would have been missed, but the gap would still exist; the schedule would likely still skip. Unlikely because the cluster correctly uses the current tzdata (other jobs with similar schedules would also be affected). |
| **Job accidentally suspended or deleted** – The CronJob was suspended or removed on that day. | • Check `kubectl get cronjob` for `.spec.suspend` and `metadata.deletionTimestamp`. • Verify audit logs for any modifications on 2026‑03‑29. Not supported by any fact. |
| **Resource pressure / quota limit** prevented Job creation. | • Check namespaces for resource quotas, Pod limits, and controller‑manager logs for “exceeded quota” messages. • No evidence of global issues; other jobs ran normally. |

### Minimal Safe Verification Step (Before Any Fix)
**Do not change anything yet.** Confirm the root cause with read‑only operations:

1. **Examine the CronJob object’s events and status:**
   ```bash
   kubectl describe cronjob <name> -n <namespace>
   ```
   - Look for `.status.lastScheduleTime` – it should show the last successfully created Job (2026‑03‑28) and the next scheduled time after that. For the missing day there will be **no record**.
   - Check `Events` for any “Missed schedule” or “Saw scheduled job” entries around 02:30 on 2026‑03‑29. A typical output for a gap is **no event at all**.

2. **Simulate the schedule for 2026‑03‑29 with the timezone – this proves the gap:**
   - Use a cron library (e.g., Python’s `croniter`, or `cron` command with `--timezone`) to list occurrences of `30 2 * * *` in `Europe/Berlin`:
     ```
     $ python3 -c "import croniter, datetime, pytz; tz=pytz.timezone('Europe/Berlin'); base=tz.localize(datetime.datetime(2026,3,28,2,30)); it=croniter.croniter('30 2 * * *', base); print(it.get_next(datetime.datetime)); print(it.get_next(datetime.datetime))"
     ```
     The first next should be 2026‑03‑30 (not the 29th). This confirms the gap.

3. **Double‑check controller logs** (already observed clean):
   ```bash
   kubectl logs -n kube-system <controller-manager-pod> --since-time=2026-03-29T00:00:00Z | grep -i <cronjob-name>
   ```
   If no log line appears at all for that night, it means the controller never tried to create a Job – consistent with a gap.

**Result:** Once the gap is confirmed, you can safely proceed with a fix without changing the running system first.

### Recommended Fix (to Prevent Silent Skipping at Future DST Transitions)
**Change the schedule to a time that exists every day**, or move to a UTC‑based schedule.

#### Option A: Use UTC timezone (most robust)
Set `timeZone: "UTC"` and adjust the hour so that the job still runs at the desired *local* time for most of the year.  
Example: to run at 02:30 CET/CEST, the UTC equivalent shifts:
- Winter (CET, UTC+1): 02:30 CET → 01:30 UTC
- Summer (CEST, UTC+2): 02:30 CEST → 00:30 UTC

A single schedule cannot map to **both** 02:30 local times without a duplicate/skip. Instead, pick a fixed UTC time (e.g., `00:30 UTC` → 01:30 in winter, 02:30 in summer — if that local timing is acceptable).  
**Best practice:** Schedule well after the DST transition window (e.g., `00 3 * * *` in UTC → 04:00 CEST in summer, 03:00 CET in winter – both exist and avoid the 02:00–03:00 gap).

#### Option B: Keep local timezone but pick a safe hour
Change the cron expression to a time that **always exists** in Europe/Berlin:
- `30 3 * * *` – 03:30. On spring‑forward, 03:30 is the first half‑hour after the gap, so it will run. On fall‑back, 03:30 occurs only once (the duplicate hour is 02:00–03:00 CEST→CET). This avoids the spring skip, but the fall duplicate of `02:30` would be eliminated as well.
- Alternatively, schedule at `30 1 * * *` – 01:30 exists both before (CET) and after (CEST) the spring transition; on fall‑back, 01:30 occurs twice (once in CEST then again in CET). **Be aware** – for a billing report, a duplicate run might cause double counting. If that is unacceptable, avoid times that fall in the fall‑back overlap.

**Final recommendation:** Adopt **UTC timezone** and schedule at a time that is safe for your business logic (e.g., 00:30 UTC). This completely decouples the schedule from local DST rules and eliminates both spring skips and fall duplicates.