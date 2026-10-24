# User Reports — coverage classification

All 34 queries bucketed per the migration skill's §2, before any code.

**Headline: this app is mostly already built, and the tracker's blockers are stale.** 34 queries sound
like a large slice; 13 are Retool-side JavaScript glue, and most of the rest have equivalents shipped
during the User Lookup, Chat Audit and `/reports` work. What is genuinely missing is a *workflow*, not
a dataset — see "What is actually left".

## Classification of all 34

### port (4)

| Query | What it is |
| --- | --- |
| `GetReports` | The pending queue of reports **against a user** — `Report ⋈ UserReport`, open statuses, excluding `reason = 'Automated'`, carrying the suspect's ban/mute/delete state |
| `ReportHistory` | Last 300 status changes on user reports, with who set each — the "who has been working this queue" view |
| `GetImageCount` | How many images the reported user has, for the inline review step |
| `TOSImages` | Selecting a user's images for review. `JavascriptQuery`, but it carries the selection semantics the port needs |

### equivalent (14) — shipped, name the winner

| Query | Covered by |
| --- | --- |
| `ReceivedReports` | **Byte-identical** to User Lookup's `ReportsReceived` → `getReportsReceived` (`user-reports.service.ts`) |
| `ClickhouseUserActivities` | User Lookup's same query → `getAccountEvents` (`user-signals.service.ts`) |
| `UserStrikes` | `getUserStrikes` (`moderation-memory.service.ts`) |
| `InsertStrike`, `LogStrike` | `addUserStrike` — **including the notification**, which the tracker still lists as blocked |
| `SendNotification2`, `PostNotification`, `SendCorrectNotif` | `sendModNotification` (`moderation-memory.service.ts`) |
| `RetoolNotes` | `getUserNotes` / `addUserNote` |
| `ActionReport` | Already shipped: the dashboard's "Most reported" and `/reports/[slug]`, both via `setReportStatus` |
| `UserQuery`, `UsernameQuery`, `UserQuery5000` | `resolveUserId` (`user-lookup.service.ts`) resolves id / username / email in one |
| `RemoveImages`, `RemoveImages2`, `RestoreImages` | `image-moderation.service.ts` + `image-deletion.ts` own this path, with the cache/search-index side effects Retool's raw REST calls did not do |

### plumbing (16)

All 13 `JavascriptQuery` entries — `query30` (batches of 10), `query31`, `log`, `UnselectAll`,
`UnselectAll2`, `UpdateAfterDelete`, `UpdateAfterRestore`, `SendCorrectNotif` — plus `DisableApp`,
`EnableApp`, `EnableApp2`, `DisableAppRestore` (Retool locking its own UI while a batch runs). A form
action does all of this; none is a data source.

### superseded (0) · blocked (0)

Nothing. The three items the tracker lists as blocked — strike notifications, moderator notifications,
and the destructive image path — were all resolved during the User Lookup slice.

## The audit-log queries

`LogTos`, `LogRestore`, `LogStrike`, `RetoolActions` write to Retool's `ReToolActions` table. Bucketed
**equivalent**: this app logs to `ModActivity` instead, as every ported action already does. The two
tables still do not reconcile — that open question is unchanged and is recorded in
[`user-lookup-audit.md`](user-lookup-audit.md).

## What is actually left

Four queries, but the value is in the workflow they compose, which nothing currently offers:

**Triage one user's reports end to end.** Today a moderator does this across three pages — `/reports`
for the queue, User Lookup for the account's history and strikes, and an image queue for the content.
Retool's app put the reports, the reported user's images, and the strike/notify actions on one screen,
which is the whole point of it.

`/reports/[slug]` already covers `ReportEntity.User` (`'reportedUser'`) generically, so the queue half
exists. What does not exist is the **per-user drill-down**: given a report against a user, see their
open reports, their images inline for review, and act on all of it without leaving.

Two things to decide before building:

1. **Is this a new page, or a section of User Lookup?** User Lookup already has Reports, Notes &
   Strikes and Notifications sections, and the section nav was built precisely to hold this kind of
   thing. A separate `/retool/user-reports` page would duplicate three of its sections.
2. **Inline image review needs `ImageQueueGrid`** (300px cards, per the app standard) rather than a
   fresh grid. Confirm the selection/bulk semantics match — the existing action pages are per-card
   immediate actions, not selection-and-bulk, which is what Retool did here.

## Note on the export

Extracted 2026-08-06, **before `extract.mjs` emitted widget option sets**, so it has no "tabs & option
sets" section. With 57 components and 17 buttons this is a real gap, unlike Article Lookup — the
button labels and any dropdown presets are exactly what that section would surface, and this app is
described as the most action-heavy of the three. **Re-extract before building.**
