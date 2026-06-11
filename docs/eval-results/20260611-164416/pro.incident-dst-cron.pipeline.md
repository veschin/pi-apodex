## Root Cause (Confidence: High)

The CronJob schedule specifies a time (02:30 Europe/Berlin) that does not exist on the day of the spring‑forward DST transition. Kubernetes CronJob controllers, like most cron implementations, are known to skip such invalid times, so no job was created and no error was emitted.  
**Unverified assumption**: The specific behaviour of the Kubernetes CronJob controller (based on libraries such as `robfig/cron`) has not been confirmed against vendor documentation or logs in the provided materials; the claim is inferred from common cron design and the absence of any error.

### Evidence chain

1. **Cron expression and timezone**: The CronJob uses `"30 2 * * *"` with `timeZone: "Europe/Berlin"`.
2. **DST transition**: On 2026‑03‑29, Europe/Berlin moves from CET (UTC+1) to CEST (UTC+2). Clocks jump from 02:00 CET directly to 03:00 CEST, so **02:30 local time never occurs** on that date.
3. **Reported job history** (per incident report):
   - 2026‑03‑28 ran at 02:30+01:00 (normal).
   - 2026‑03‑29 has **no run entry** at all.
   - 2026‑03‑30 ran at 02:30+02:00 (normal, after transition).
4. **Kubernetes behaviour**: In typical cron implementations (including those that map `TZ`/timezone fields), a trigger that falls inside a DST gap is intentionally skipped – no job is scheduled and no error is logged. The reported absence of any controller error for this CronJob is consistent with that design.
5. **No controller errors**: `kube-controller-manager` logs reportedly contain no error for the CronJob that night, further supporting a deliberate skip rather than a failure.
6. **No other causes**: NTP offset was reportedly negligible (<10 ms all week), a routine image deploy on Friday had no impact (job ran normally on Saturday the 28th), and there are no signs of resource starvation or configuration change.

## Competing hypotheses (and why they are less likely)

| Hypothesis | Evidence against |
|------------|------------------|
| Cluster resource shortage / scheduling failure | Job runs reliably every other day; no `FailedNeedsStart` or other error events/logs reported. |
| CronJob spec changed during Friday deploy | Deploy was image‑only; job ran normally on Saturday 28th. No change to spec reported. |
| Timezone misconfiguration | Timezone is explicitly set to `Europe/Berlin`, which correctly applies the DST rules for the region. |
| Kubernetes bug / unexpected behaviour | The behaviour matches the expected design of timezone‑aware cron libraries; not a bug – it’s the accepted trade‑off. |
| Node clock drift | NTP offset was reportedly <10 ms; even a large drift wouldn’t make 02:30 exist on that date. |

## Minimal safe verification step before any fix

**Inspect the CronJob’s status and controller logs (non‑disruptive):**

```bash
kubectl get cronjob <name> -o yaml
```

Look for `status.lastScheduleTime` – it should show the last successful schedule (2026‑03‑30) and no entry for 2026‑03‑29. This confirms the skip.

Optionally, increase controller log verbosity temporarily to see the skip decision:

```bash
kubectl logs -n kube-system deployment/kube-controller-manager --tail=200 | grep -i "cronjob" | grep "2026-03-29"
```

An explicit “skipping schedule due to DST gap” message (or absence of any schedule attempt) corroborates the root cause.

> **Note:** Do **not** manually recreate the missed billing job until the root cause is confirmed and any dependent data integrity checks are planned.

## Recommended fix to prevent recurrence

Avoid scheduling inside the DST gap (02:00–03:00 local time). The simplest safe change is to **move the schedule to 03:30 or 04:00 Europe/Berlin**. For example:

```yaml
schedule: "30 3 * * *"   # 03:30, which always exists in both standard and summer time
```

This single change eliminates both the spring‑forward skip and the autumn fall‑back double‑run problem that would occur if you kept a time inside the ambiguous hour (e.g., 02:30 in autumn runs twice).

## Verification status

- **Observed / verified from given facts**:
  - CronJob schedule `"30 2 * * *"` in timezone `Europe/Berlin`.
  - Europe/Berlin DST transition on 2026‑03‑29 (02:00 CET → 03:00 CEST).
  - 02:30 local time does not exist on that date.
- **Unverified / assumed**:
  - The Kubernetes CronJob controller’s exact design documentation regarding DST‑gap handling (no reference or log excerpt supplied).
  - The reported job run history (28th, missing 29th, 30th) and controller log contents are given in the incident description but lack direct execution evidence.
  - NTP offset measurement and the image‑only deploy details are reported but not independently validated in the materials.