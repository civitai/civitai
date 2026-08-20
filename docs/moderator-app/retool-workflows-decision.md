# The two Retool Workflows — decision

Subtask `868kn80u9`. **Decision: do not port. Reimplement the condition as a main-app cron job.**
Shipped as `src/server/jobs/challenge-health-check.ts`.

Retool Workflows is a scheduled-job product separate from Retool apps, which is why this row in the
tracker has no route. Neither of these is a page and neither ports into `apps/moderator`.

## What they actually were

Both are alerting wrappers, not work. Each is the same five-block graph: a webhook trigger, one SQL
existence probe against `"Challenge"`, a conditional branch on the probe being false, then a Discord
role ping and a PagerDuty `trigger`.

The SQL, verbatim from the exports:

```sql
-- "Daily Challenge Not Prepared"
SELECT COUNT(*) >= 1 AS "hasUpcoming"
FROM "Challenge"
WHERE status = 'Scheduled' AND source = 'System'
  AND "startsAt" > now() AND "startsAt" < now() + interval '48 hours';

-- "Daily Challenge Not Started"
SELECT COUNT(*) >= 1 AS "hasRecent"
FROM "Challenge"
WHERE status = 'Active' AND source = 'System'
  AND "startsAt" <= now() AND "startsAt" > now() - interval '24 hours';
```

The filter is `source = 'System'` on the `ChallengeSource` enum, not a `userId` — so both deliberately
ignore mod- and user-created challenges.

## Why not port them

Four independent reasons, any one of which is sufficient:

1. **Neither has run in a long time, if ever.** `crontab` is `null`, `isEnabled` is `false`, and the only
   trigger is a webhook. Nothing in Retool invoked them on a schedule.
2. **Half of each graph is unreachable.** The branch's single conditional port feeds the PagerDuty block
   only. The Discord block has no inbound edge of any kind — it is orphaned, so it could never have
   fired. Porting the graph faithfully would port a path that does nothing.
3. **They point at jobs that no longer exist.** The dead Discord embeds tell the operator to run
   `daily-challenge-pick-winners`; that job name is not registered in this repo — winner picking is
   `challenge-completion`. Both graphs also carry a stale copy-paste comment on the branch
   (*"If the leaderboard isn't populated"*), so they were cloned from a leaderboard alert.
4. **PagerDuty does not exist here.** There is no PagerDuty integration anywhere in the repo, and adding
   one is an infra decision, not a migration one.

## Why the condition is worth keeping anyway

The delivery was broken; the question it asked was not, and nothing currently answers it.

`createJob` already reports a **thrown** failure — `jobErrorsCounter.inc()` plus a `job-error` Axiom
event with a source-mapped stack. What it cannot see is the challenge pipeline's actual failure mode,
which is a silent no-op:

- `createUpcomingChallenge()` has three early returns that log to console and nothing else.
- `challenge-auto-queue` counts `result.failed` per date and never alerts on it, and has no
  `logToAxiom` call at all.
- Both no-op entirely when `CHALLENGE_PLATFORM_ENABLED` is off.

So a pipeline that stops producing challenges — flag flipped, job never invoked, dates failing inside a
batch — produces no error, no metric, and no alert. That is exactly the gap the two workflows covered.

Which job to look at differs per condition:

| Condition | Meaning | Suspect |
| --- | --- | --- |
| not prepared | nothing `Scheduled` in the next 48h | `challenge-auto-queue` (`0 6 * * *`), `daily-challenge-setup` (`0 22 * * *`) |
| not started | nothing went `Active` in the last 24h | `challenge-activation` (`0 * * * *`) |

## What was built

`src/server/jobs/challenge-health-check.ts`, registered in `run-jobs`, on `0 */6 * * *`.

- Both predicates in one query, plus `nextScheduledAt` / `lastActivatedAt` so the alert says how far
  behind things are rather than just that they are.
- Alerts to Axiom (`type: 'warning'`, name `challenge-health-check`) and to Discord through the existing
  `DISCORD_WEBHOOK_MOD_ALERTS` webhook, following the pattern already in `new-order-jobs.ts`. Both are
  `.catch(() => null)` — alerting never breaks the job.
- No PagerDuty. See reason 4.
- When `CHALLENGE_PLATFORM_ENABLED` is off it does not page, because both producing jobs are then
  no-ops by design and paging would be noise. It still emits an `info` Axiom event, so "why are there no
  challenges" lands on the flag immediately instead of looking like a broken job.

Six-hourly rather than hourly: both conditions mean "this has been broken for hours already", so a
tighter loop adds Discord noise without shortening the detection window meaningfully.

## Open questions

1. **Is the 24h "not started" window right for us?** It is Retool's number, kept as-is. If system
   challenges can legitimately go more than 24h between starts — a deliberate pause, a schedule gap —
   this will alert on healthy states. Nobody has confirmed the intended cadence.
2. **Should this page rather than post?** The Retool version paged PagerDuty. Discord is what this repo
   can do today. If challenge downtime is genuinely page-worthy, that is an infra request.
3. **`challenge-auto-queue` swallowing `result.failed`** is a real gap this job only detects
   *downstream*, and days later. Alerting at the source would be better and is out of scope here.

## Security note on the exports

The two raw exports under `retool-exports/raw/` were sanitized before their only commit. Re-verified
2026-08-11: the Discord webhook URL, the PagerDuty routing key, the `run-jobs` token and the internal
job-scheduler host are all placeholders in every version in git history. Nothing needs rotating.
Re-sanitize the same four if the exports are ever refreshed.
