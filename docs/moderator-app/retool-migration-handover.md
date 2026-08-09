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
| 1 | Set **`CIVITAI_MOD_API_KEY`** (a moderator's API key, NOT `WEBHOOK_TOKEN`) | Bulk comment/review actions refuse up front → [detail](retool-migration-handover-detail.md#1-environment--appsmoderatorenv) |
| 2 | Set **`RETOOL_DATABASE_URL`** in every deployed env | Otherwise notes/strikes/mutes read the wrong database → [detail](retool-migration-handover-detail.md#1-environment--appsmoderatorenv) |
| 3 | Rename **`FRESHDESK_TOKEN` → `FRESHDESK_API_KEY`** | Support panel has shown "no contact found" for *every* user → [detail](retool-migration-handover-detail.md#1-environment--appsmoderatorenv) |
| 4 | Apply **3 SQL migrations** by hand (each `CREATE INDEX CONCURRENTLY`, so outside a transaction) | Page-access table + mod-activity history + a report index → [detail](retool-migration-handover-detail.md#2-database-migrations--none-are-auto-applied) |
| 5 | **Grant 5 new pages on `/admin`** — `article-lookup`, `user-reports`, `bulk-image-manager`, `front-page-audit`, `image-help` | A new page is reachable only by `moderator:admin` until granted. Grant Bulk Image Manager **narrowly**. Front Page Audit's rating buttons are gated on its own grant, so a moderator without it sees the sweep read-only → [detail](retool-migration-handover-detail.md#2b-grant-the-new-pages-on-admin) |

## Decisions only a dev can make

| # | Decide | Detail |
| --- | --- | --- |
| 6 | **Where the 2 Retool Workflows live.** Retool Workflows is a scheduled product separate from its apps; our cron lives in the main app. These are backfill/timer jobs (`MinorInsert`, `PoIInsert`, `*_catchup`, `*Timer`) — most may already be covered by existing jobs. Needs the workflow exports and a yes/no per job, not a port. | [detail](retool-migration-handover-detail.md#6-the-two-retool-workflows-cron) |
| 7 | **Three schemas Front Page Audit needs** to resume and log (`FrontPageTimers`, `RatingChanges`, `research_ratings`). The sweep works without them; what is missing is the shared resume point and the audit trail. | [detail](retool-migration-handover-detail.md#2d-three-schemas-front-page-audit-needs-before-it-can-resume-or-log) |
| 8 | **`aiNsfwLevel` and `aiModel` exist in production but not in `schema.full.prisma`.** The scan webhook writes them; the moderator app reads `aiNsfwLevel` through raw `sql` because it cannot be typed. Add to the schema, or accept the raw read. | [detail](retool-migration-handover-detail.md#4-known-open-decided-or-deferred) |
| 9 | **`ReToolActions` vs `ModActivity`** — two mod-action logs, nothing reconciles them. Retool-era history is invisible in the new app. | [detail](retool-migration-handover-detail.md#4-known-open-decided-or-deferred) |
| 10 | **Two strike systems** — this app writes Retool's `UserStrikes`, not the main app's newer `Strike`. | [detail](retool-migration-handover-detail.md#4-known-open-decided-or-deferred) |

## Before Retool access is lost

| # | Do | Why now |
| --- | --- | --- |
| 11 | **Re-extract every export** (needs ClickUp creds or the raw JSON dropped in `~/Downloads/Retool/`) | The extractor only learned option sets on 2026-08-07 and **layout on 2026-08-08**. Older exports are missing tab labels, canned workflows, role gates and pane structure. One pass now gets all of it — and it is the only thing that can confirm Front Page Audit's rating vocabulary. → [detail](retool-migration-handover-detail.md#2c-re-extract-the-remaining-retool-exports) |

## Exercise before trusting it in production

Highest risk first. Full list and what to watch for: [detail](retool-migration-handover-detail.md#3-nothing-has-been-run).

- [ ] **Bulk Image Manager** — the POI/minor **clear** path especially: Retool could only ever *set*, so that direction has no prior behaviour to compare against
- [ ] **`sendBuzz`** send *and* deduct — a reversed direction or wrong ledger type is silent, and this shipped wrong once
- [ ] **Issue strike** — strike counts drive bans; exercise from User Reports first
- [ ] **Purge all content** — throwaway account only
- [ ] **Front Page Audit** — confirm re-rating locks the level and the row dims
- [ ] Videos render as video, not through the image pipeline

## Known gaps in what was ported

**[`parity-findings.md`](retool-exports/parity-findings.md)** is the live list: 35 findings from
comparing each export's SQL against what was built, with fixed/open status. The open ones a moderator
would notice first:

- User Lookup's "reports they filed" drops the commonest kind while its own tile counts them
- Report entity coverage is 6 of Retool's 11 types, so some reported accounts read as clean
- `UserRestriction` is read nowhere, so a system auto-mute looks like an unexplained manual one
- Report `details` — the reporter's own words — is fetched and dropped on **every** page in the app
