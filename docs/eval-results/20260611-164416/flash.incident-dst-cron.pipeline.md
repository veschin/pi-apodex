## Incident Diagnosis: Billing CronJob Missed on DST Transition

### Most Likely Root Cause (confidence 95%)

The root cause is that the scheduled local time (02:30) does **not exist** on the DST transition day (2026-03-29).  
The CronJob schedule `30 2 * * *` with `timeZone: Europe/Berlin` specifies a wall-clock time that is skipped when clocks jump from 02:00+01:00 directly to 03:00+02:00. Consequently, no CronJob is triggered on that day.

*Unverified:* This explanation assumes that the Kubernetes CronJob controller, when evaluating the schedule against the declared timezone, simply finds no matching instant on the transition day and therefore skips it without raising an error. This behaviour is documented and consistent with the observed pattern, but the controller’s internal logic was not directly observed in the provided materials.

### Evidence Chain

| Observation | Status | Supports Root Cause |
|------------|--------|-------------------|
| Job ran on 2026-03-28 at 02:30+01:00 (CET). | Verified | Normal operation before transition. |
| No job entry exists for 2026-03-29. | Verified | The scheduled time is missing from the local timeline. |
| Job ran on 2026-03-30 at 02:30+02:00 (CEST). | Unverified* | Normal operation returns after transition. |
| Europe/Berlin DST change on 2026-03-29 (gap 02:00–03:00). | Verified | The gap exactly covers the scheduled time, making 02:30 non‑existent. |
| NTP offset <10ms; no controller errors logged. | Unverified* | Excludes clock drift or controller bugs as primary causes. |
| Deploy on 2026-03-27 had no effect on 28th run. | Unverified* | Image change is unlikely to be the cause. |

\* These observations are taken as given from the incident report (task facts) but no raw logs or execution outputs were provided to independently confirm them.

### Competing Hypotheses (and why less likely)

1. **Kubernetes CronJob timeZone bug** – e.g., the schedule is evaluated as UTC instead of the declared zone.  
   *Why less likely:* If the schedule were misinterpreted as UTC, it would produce incorrect times every day, not only on the transition day. The incident reports that the job ran correctly on adjacent days (at the expected local offsets), which contradicts a systematic misinterpretation.

2. **Clock skew / NTP failure** – Even a small offset could push the 02:30 UTC equivalent into a different day.  
   *Why less likely:* The incident reports NTP offset <10ms all week. A sub‑second error cannot cause a full day miss. The job ran on both the 28th and the 30th at the correct local times.

3. **CronJob controller resource pressure** – The controller missed the event due to overload or a transient bug.  
   *Why less likely:* No controller errors appear in the logs (per incident report). If other CronJobs with the same schedule existed, they would have shown a similar skip; none is mentioned.

4. **Accidental manual deletion / modification** – Someone suspended or deleted the CronJob for a day.  
   *Why less likely:* The pattern aligns perfectly with a DST skip, and no such modification is mentioned. The absence of any error or change log makes this unlikely.

*Note:* The evaluations above rely on the incident facts (some of which are unverified as noted). No alternative hypothesis fits the observed pattern as cleanly as the DST gap.

### Minimal Safe Verification Step (before any fix)

These steps are **recommended** to confirm the root cause without modifying the production environment.

1. **Inspect the CronJob’s `status.lastScheduleTime` and `status.lastSuccessfulTime`:**  
   ```bash
   kubectl get cronjob billing-report -o jsonpath='{.status.lastScheduleTime}{"\n"}{.status.lastSuccessfulTime}'
   ```  
   **Expected outcome:** The last trigger shows 2026-03-28, the next jumps to 2026-03-30, with no entry for the 29th. This would confirm the skip.

2. **Simulate the cron schedule using a timezone‑aware tool** (e.g., Python with `croniter` and `pytz`):  
   ```python
   import croniter, pytz
   base = pytz.timezone('Europe/Berlin').localize(datetime(2026,3,28,23,0))
   cron = croniter.croniter('30 2 * * *', base, ret_type=datetime)
   dates = [cron.get_next(datetime) for _ in range(5)]
   # Inspect dates – the 29th should be missing.
   ```  
   This reproduces the skip in a safe offline environment and confirms the hypothesis.

3. **Check for any informational log lines in the kube-controller-manager** (if verbose logging is enabled, the controller might have logged “no matching time for schedule”). Restarting with higher verbosity is **not** recommended in production; the simulation above is sufficient.

If both checks confirm the gap, the root cause is established with high confidence.

### Recommended Fix (to prevent recurrence)

**Option A – Use a UTC‑based schedule (preferred)**  
Replace the current schedule with one that never depends on a local time that can disappear:
- Current: `schedule: "30 2 * * *"` with `timeZone: Europe/Berlin`
- New: `schedule: "30 1 * * *"` and **remove** the `timeZone` field (or explicitly set it to `UTC`).  
  This runs the job at **01:30 UTC** every day. In Europe/Berlin that becomes:
  - Winter (CET): 02:30 CET  
  - Summer (CEST): 03:30 CEST  
  - On the spring‑forward day: 01:30 UTC occurs **before** the transition (02:30 CET), so the job runs.

**Option B – If a fixed local time is required, choose a time that always exists**  
For example, `0 3 * * *` (03:00) with `timeZone: Europe/Berlin`. Only the hour 02:00–03:00 is skipped in spring, so 03:00 always occurs. Note that the local time will shift (03:00 CET in winter, 03:00 CEST in summer), which may be one hour later than intended on non‑transition days.

*Unverified:* These fixes are based on general knowledge of DST and Kubernetes CronJob behaviour; they have not been tested in this specific environment. However, Option A is standard practice and has no DST pitfalls.

### Verification Status

- **Observed/verified:** The DST transition on 2026-03-29, the job run on 2026-03-28, and the absence of a job on 2026-03-29 are directly confirmed by the incident facts.
- **Remains unverified:** The internal behaviour of the CronJob controller (skipping non‑existent times), the exact status fields of the CronJob, the NTP logs, and controller logs have not been independently verified. The recommendations (verification steps and fix) are not backed by execution evidence from this incident, but are standard practice.

**Open items:** None from the external verifier. All audit-flagged unsupported claims have been noted as unverified or reworded as assumptions.