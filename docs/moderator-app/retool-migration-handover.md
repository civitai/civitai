# Retool migration — what a person has to do

> **Two checklists now govern the work itself:**
> [`retool-parity-checklist.md`](retool-parity-checklist.md) — everything Retool does today that the
> port does not, which is the priority — and
> [`post-migration-backlog.md`](post-migration-backlog.md) — improvements the team asked for on top,
> which wait. This file stays what it was: the operational steps a person has to run.
>
> **The tracker listed 9 of the parent ticket's 13 subtasks.** Bulk Ban is a real ninth app; its
> export is now saved at [`retool-exports/bulk-ban.md`](retool-exports/bulk-ban.md).

Branch `moderator-app-pages`. This is the short list. Every item links to the reasoning and the exact
commands in [`retool-migration-handover-detail.md`](retool-migration-handover-detail.md); read the
detail before doing anything destructive.

**Nothing in this migration has been seen rendering in a browser, and no action has been fired.**

---

## Blocking — the app is wrong or unreachable without these

| # | Do | Why it blocks |
| --- | --- | --- |
| ~~1~~ | ~~Set **`CIVITAI_MOD_API_KEY`**~~ **RESOLVED 2026-08-19 — do NOT provision this.** The spoke no longer holds a moderator key: every main-app call now goes to `/api/mod/*` and relays the acting moderator's own session cookie. The variable is gone from the code and from `.env.example`. | — |
| 2 | Set **`RETOOL_DATABASE_URL`** in every deployed env | Otherwise notes/strikes/mutes read the wrong database → [detail](retool-migration-handover-detail.md#1-environment--appsmoderatorenv) |
| 3 | Rename **`FRESHDESK_TOKEN` → `FRESHDESK_API_KEY`** | Support panel has shown "no contact found" for *every* user → [detail](retool-migration-handover-detail.md#1-environment--appsmoderatorenv) |
| 4 | Apply **3 SQL migrations** by hand (each `CREATE INDEX CONCURRENTLY`, so outside a transaction) | Page-access table + mod-activity history + a report index → [detail](retool-migration-handover-detail.md#2-database-migrations--none-are-auto-applied) |
| 5 | **Grant 5 new pages on `/admin`** — `article-lookup`, `user-reports`, `bulk-image-manager`, `front-page-audit`, `image-help` | A new page is reachable only by `moderator:admin` until granted. Grant Bulk Image Manager **narrowly**. Front Page Audit's rating buttons are gated on its own grant, so a moderator without it sees the sweep read-only → [detail](retool-migration-handover-detail.md#2b-grant-the-new-pages-on-admin) |
| ~~5b~~ | ~~**Repoint the main app's moderator lookup buttons** off Retool~~ **RESOLVED 2026-08-20 — no env work.** There are no per-target lookup variables any more. One `NEXT_PUBLIC_MODERATOR_APP_URL` (with a default) plus path helpers in `src/shared/constants/moderator-app.ts`. User → `/retool/user-lookup?q=`, post → `/retool/bulk-image-manager?source=post&q=` (note `source`+`q`, not Retool's `postId`). Model was waived; chat had no reader left and its variable is deleted. | Per-target detail: [`mod-studio-feedback-2026-08-19.md`](mod-studio-feedback-2026-08-19.md). |

## Decisions only a dev can make

| # | Decide | Detail |
| --- | --- | --- |
| ~~6~~ | ~~**Where the 2 Retool Workflows live.**~~ **RESOLVED 2026-08-11** — not ported. Both are inert alerting wrappers (no crontab, `isEnabled: false`, orphaned Discord block); the underlying jobs are already ours. The alert they provided was genuinely missing and is reimplemented as `src/server/jobs/challenge-health-check.ts`. | [decision](retool-workflows-decision.md) |
| 7 | **`RatingChanges`** — the one Front Page Audit write still unported (the rating audit trail). `FrontPageTimers` was built 2026-08-20, so the shared resume point works; the table's columns are confirmed and this is ordinary porting work, not a decision. | Canonical state: [Front Page Audit port state](retool-exports/parity-findings.md) |
| 8 | **`aiNsfwLevel` and `aiModel` exist in production but not in `schema.full.prisma`.** The scan webhook writes them; the moderator app reads `aiNsfwLevel` through raw `sql` because it cannot be typed. Add to the schema, or accept the raw read. | [detail](retool-migration-handover-detail.md#4-known-open-decided-or-deferred) |
| 9 | **`ReToolActions` vs `ModActivity`** — two mod-action logs, nothing reconciles them. **Recommendation made 2026-08-11**: migrate as a read-only archive, do NOT merge into `ModActivity` — the user id is embedded in free text and matched with `LIKE`, so any merge would invent `entityType`/`entityId` and attribution that then reads as real. Still needs a human's yes. | [decision](retool-db-cutover.md) |
| ~~10~~ | ~~**Two strike systems** — this app writes Retool's `UserStrikes`.~~ **RESOLVED 2026-08-20.** `issueStrike` writes the main app's `Strike` through `retool/strike → create`, so escalation, points, expiry, the typed notification and the void path all come with it. Legacy `UserStrikes` rows are still read alongside so history is not lost. | [detail](retool-migration-handover-detail.md#4-known-open-decided-or-deferred) |

## Before Retool access is lost

| # | Do | Why now |
| --- | --- | --- |
| 11 | **Re-extract every export** (needs ClickUp creds or the raw JSON dropped in `~/Downloads/Retool/`) | The extractor only learned option sets on 2026-08-07 and **layout on 2026-08-08**. Older exports are missing tab labels, canned workflows, role gates and pane structure. One pass now gets all of it — and it is the only thing that can confirm Front Page Audit's rating vocabulary. → [detail](retool-migration-handover-detail.md#2c-re-extract-the-remaining-retool-exports) |

## Exercise before trusting it in production

Highest risk first. Full list and what to watch for: [detail](retool-migration-handover-detail.md#3-nothing-has-been-run).

**Local dev fires at two different places — know which before reading a result.** `DATABASE_URL` is the
dev clone, so mute, force-logout and the cosmetic paths write there; but `callMainApp` targets
`CIVITAI_APP_URL`, so **ban, unban, purge and image removal hit production**. The consequence when
exercising: the app *reads* identity from the clone, so a prod ban does not change the button, and a
green form is not evidence. Verify against the real target, not the page.

- [ ] **Bulk Image Manager** — the POI/minor **clear** path especially: Retool could only ever *set*, so that direction has no prior behaviour to compare against
- [ ] **`sendBuzz`** send *and* deduct — a reversed direction or wrong ledger type is silent, and this shipped wrong once. ⚠️ **Still unexercised**: `BUZZ_ENDPOINT` is `localhost:8080` and nothing listens there in dev, so the call fails at connect and tests nothing. Needs an environment with the buzz service up.
- [ ] **Issue strike** — strike counts drive bans; exercise from User Reports first
- [x] **Purge all content** (2026-08-11, owner-authorised on their own prod test account 1290051).
      Verified by id against prod: `/api/v1/images?imageId=` returns `items:[]` for both of the
      account's images. **Read that endpoint, not `?username=`** — the username listing is served from
      Meilisearch and `removeAllContent` only *queues* the index delete, so purged content stays listed
      for a while and reads as a failed purge. It caught up here within a few minutes.
- [x] **Ban / unban round trip** (2026-08-11, same account). Prod SSR payload carried
      `"bannedAt":"…"` after the ban and no `bannedAt` after the unban; both attributed to the real
      moderator in `ModActivity`. Note the profile page returns **200 either way** — it renders
      "Banned" rather than 404ing, so a status code proves nothing here.
- [ ] **Front Page Audit** — confirm re-rating locks the level and the row dims
- [ ] Videos render as video, not through the image pipeline

## Known gaps in what was ported

**[`parity-findings.md`](retool-exports/parity-findings.md)** is the live list — every finding from
comparing each export's SQL against what was built, with fixed/open status, and it moves faster than
this file. Read it there; nothing is restated here.
