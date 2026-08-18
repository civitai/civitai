# Retool migration — handover detail

The reasoning and exact commands behind
[`retool-migration-handover.md`](retool-migration-handover.md), which is the short list. Read this
before doing anything destructive.

Written 2026-08-07. Delete items as they are done.

---

## 1. Environment — `apps/moderator/.env`

- [x] **`CIVITAI_MOD_API_KEY=`** — **no longer exists (2026-08-18). Do not set it.** The spoke calls
      `/api/mod/*` and forwards the acting moderator's session cookie, so there is no shared key and
      no shared actor: the audit row names the moderator who clicked. The variable was removed from
      the code and from `.env.example`.

      🔴 One consequence to check before relying on it: those endpoints evaluate `privileged` against
      the **individual moderator's** `user.permissions`, where the shared key's owner used to hold
      them. `user.updateIdentity` needs `retoolUpdateIdentity` and `user.toggleModerator` needs
      `retoolToggleModerator`; grant them per moderator via `POST /api/admin/permission`.

- [ ] **`FRESHDESK_TOKEN` → `FRESHDESK_API_KEY`** — pre-existing bug, not from this migration.
      `freshdesk.service.ts:27` reads `env.FRESHDESK_API_KEY`; the local `.env` defines
      `FRESHDESK_TOKEN`. The support panel in User Lookup has therefore been showing
      "no contact found" for **every** user regardless of whether they have contacted support.

- [ ] **`FRESHDESK_DOMAIN` includes a scheme** (`https://civitai.freshdesk.com`). The service builds a
      URL from it and `.env.example` has it bare. Check it is not producing `https://https://…`.

- [x] **`MODERATOR_DATABASE_URL` was defined twice in `.env.example`** with different values — the
      xguard-lab one and the Retool one. Split: `MODERATOR_DATABASE_URL` is the internal_tools instance
      (XGuard lab), `RETOOL_DATABASE_URL` is Retool's Postgres behind `getModeratorDb()`.

      **Deployed environments need `RETOOL_DATABASE_URL` set.** Prod already had
      `MODERATOR_DATABASE_URL` pointing at internal_tools for the lab, so until this is set every
      `UserNotes` / `UserStrikes` / `TimedMutes` read and write was aimed at the wrong database.

## 2. Database migrations — none are auto-applied

**All three use `CREATE INDEX CONCURRENTLY`, so each must run OUTSIDE a transaction.** The first two
predate this session; verify rather than assume they are already applied.

- [ ] `20260803120000_add_app_page_access` — creates `AppPageAccess` (per-page role grants)
- [ ] `20260805120000_mod_activity_append_only` — drops the unique constraint that collapsed repeat mod
      actions into one row; adds `(entityType, entityId, createdAt)` and `(userId, createdAt)`
- [ ] `20260807120000_report_open_reason_index` — partial index on `Report (reason, id)` for open
      statuses. The Reports sub-nav count query was seq-scanning ~2.4M rows (~300ms) without it.

## 2b. Grant the new pages on `/admin`

A new page has **no `AppPageAccess` rows**, so only `moderator:admin` can reach it until someone ticks
the boxes. Three pages need granting before mods can review them:

- [ ] `/retool/article-lookup`
- [ ] `/retool/user-reports`
- [ ] `/retool/bulk-image-manager` — **grant this one narrowly.** Reaching it is gated on the page, but
      every action on it is additionally gated on `/users`, and it removes images in bulk across
      accounts that the moderator never looked up. Treat it as an enforcement page, not a lookup one.
- [ ] `/retool/front-page-audit` — this grant also controls the rating buttons and the tag votes, not
      just reaching the page. Without it the sweep renders read-only.
- [ ] `/retool/image-help` — the second-opinion queue from Moderation Status. Same grant gates
      "Mark handled".
- [ ] Confirm the existing Retool pages still carry the grants you expect after the User Lookup
      restructure — its sections moved to `/retool/user-lookup/[section]`, and `canAccess`
      longest-prefix matches.

## 2c. Re-extract the remaining Retool exports

**`extract.mjs` only learned to emit widget option sets on 2026-08-07, and layout structure on
2026-08-08.** Every export taken before that — `user-reports`, `bulk-image-manager`,
`front-page-audit`, `moderation-status`, `article-lookup` — has neither the "tabs & option sets"
section (tab labels, dropdown presets, canned workflows) nor the `## layout` section (which container
held which panes, which panes are role-gated, which modals existed). The option-set blind spot is what
left 97 User Lookup queries unported; the layout blind spot is why nested tab groups were flattened
into scrolling pages.

Re-extracting is now worth more than it was: one pass gets both sections. `user-lookup-v2` has already
been regenerated and immediately showed a **`Senior Mod` role gate** on the Buzz Transaction pane that
appears in no query.

It matters most for **User Reports** (17 of 57 components are buttons) and **Bulk Image Manager**.

**It currently blocks one thing outright:** Front Page Audit's age-rating vocabulary. Its
`RadioGroupWidget2` holds the set of ratings the sweep offers, and the SQL only shows the parameter
(`selectedAgeRating`) compared against `nsfwLevel`. The port assumes `@civitai/shared`'s `NsfwLevel`;
if Retool offered a subset, the page offers ratings the tool never swept.

The ClickUp skill is not configured locally (`accounts.json`/`.env` missing in
`.claude/skills/clickup/`), so this needs either those credentials or the raw exports dropped into
`~/Downloads/Retool/`. Then:

```bash
node .claude/skills/retool-migration/extract.mjs "<export.json>"
```

- [ ] Re-extract `user-reports` and re-check its audit against the surfaced option sets
- [ ] Re-extract the three not-yet-started apps before their slices begin

## 2d. Two schemas Front Page Audit needs before it can resume or log

The sweep itself is built and works without these. What they gate is **coordination and audit**: the
shared resume point and the audit log. (A third, `research_ratings`, is closed — the main app
deliberately dropped it.)

Retool wrote the first two through **GUI-mode queries**, which record the target table and *no column
list* — so the export cannot tell us the shape, and neither table is in `moderator-db-types.ts`.

- [ ] **`FrontPageTimers`** (~67k rows, `retool_db`). Read shape is known from `Timestamp`:
      `lastCheckedAt`, `username`, `buttonPressedTime`, filtered by `nsfw = <rating>`. The WRITE
      (`LogTimestamp`) is GUI-mode. Needed for: the per-rating resume point, so two moderators sweeping
      "X" do not re-check the same images. **Until this lands, the page takes `since` from the URL and
      the resume point is per-moderator, not shared.**

      ```sql
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_name = 'FrontPageTimers' ORDER BY ordinal_position;
      ```

- [ ] **`RatingChanges`** (363,465 rows, `retool_db`) — the audit trail of front-page rating
      corrections and the largest table in the migration. Written by `LogNsfwLevel`/`LogNsfwLevel2`
      (one table, two GUI-mode queries). Same `information_schema` query as above.

- [x] **`research_ratings` — CLOSED, deliberately dead.** `/api/mod/retool/image` documents it:
      *"the deprecated `research_ratings` insert from the original Retool query is intentionally dropped
      (Knights of New Order replaced that data source)."* Do NOT port it. Original note follows.
- [ ] ~~**`research_ratings`** (main DB). Retool inserts~~ `(userId, imageId, nsfwLevel)` with
      `ON CONFLICT ("userId","imageId") DO UPDATE`, on the `Prod` resource — but the table is **not in
      `@civitai/db-schema/kysely`**, so it is either missing from `schema.full.prisma` or marked
      `@no-type`. Confirm which; if it should be typed, it needs a schema addition and
      `pnpm run db:generate`. Otherwise the insert has to go through raw `sql`.

Once the two `retool_db` shapes are known, add them to `moderator-db-types.ts` alongside `UserNotes`
and friends — that file is the migration target when these tables move off Retool's database.

## 3. Nothing has been run

**No panel in this migration has been seen rendering, and no action has been fired.** It typechecks
and builds; that is all that is established. Before any of it is trusted in production:

- [ ] **`sendBuzz` — send AND deduct.** Confirm a deduct actually debits and a send actually credits,
      and that the ledger `type` lands correctly (a reversed from/to or a wrong type is silent, and
      this bug already shipped once — see the review notes below).
- [ ] **`refundShopPurchase`.** Confirm the cosmetic disappears, the purchase flags `refunded`, a
      second refund is refused, and the badge stops rendering on the user's profile (cache bust).
- [ ] **Bulk comment / review actions**, once the API key is set — including that a no-op submit now
      reports failure rather than false success.
- [ ] **Purge all content**, on a throwaway account only.
- [ ] **Issue strike** — confirm the user is notified, and that a notification failure still reports
      the strike as recorded. **Exercise this first on User Reports**: a review found that the partial
      failure previously left the form armed, and a second click writes a second strike for one
      offence. Strike counts drive bans.
- [ ] **User Reports queue** — action / dismiss / claim a report, confirm the queue refreshes and the
      count matches the sidebar badge (they previously disagreed, which is why the queue now uses the
      shared `getReports`).
- [ ] **The suspect grid** — confirm a reported account's **videos** render as video. They were going
      through the image pipeline before the review caught it.

## 4. Known-open, decided or deferred

- **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`.**
  `src/pages/api/webhooks/image-scan-result.ts` writes both, and Front Page Audit reads `aiNsfwLevel`
  through raw `sql` because it cannot be selected as a typed column. It is the scanner's own rating, and
  disagreement with `nsfwLevel` is the strongest signal that a row needs a human — so it is worth
  having. Either add both to the schema and regenerate, or accept the raw read as permanent.
  (`ImageRank` is the same situation: a production view the schema does not model, so the
  reactions ordering uses a raw subquery.)
- **`ActionReport`** — the report rows render, but actioning one still means going to `/reports`,
  which owns that flow and its side effects.
- **`GetSuccesfulPromptsUpdated`** — MongoDB; this app has no connection and adding one for a single
  read was not judged worth the dependency.
- **Bulk Image Manager** — ticket 1.3, absent from the User Lookup section nav until it has a panel.
- **`ReToolActions` vs `ModActivity`** — Retool logged to its own table, this app logs to
  `ModActivity`, and nothing reconciles them. Not treated as a blocker (this was a 1:1 port), but it
  is a real decision someone owns.
- **Strikes are written to the Retool `UserStrikes` table**, not the main app's newer `Strike` system.
  Deliberate, per "1:1 with Retool; consolidation is another day" — but it does mean two strike
  systems exist.
- **Paddle account-linking workflow** — not ported; Paddle is no longer used (confirmed 2026-08-07).
- **`transactionTypes`** — Retool's free-choice ledger-type picker is not ported; a fixed set of four
  meaningful types is offered instead.

## 5. Review findings deliberately left undone

Three review agents ran over the migration diff. Everything they found in the migration surface is
fixed. These were judged broad mechanical sweeps rather than defects, and are **not** done:

- **`modAction` helper** — 18 form actions repeat `canAccess` + parse + `fail(scope)`. This is the one
  with a correctness edge: a missing first line is an **invisible authorization hole**, since nothing
  fails, the action just works for someone who should not have it.
- `fetchJson` — eight copies of the same four-line fetch + error contract.
- `AsyncPanel` — the `{#await}` / loading / `{:catch}` shell repeated across ~20 panels.
- `Alert` from `@civitai/ui` — the error banner is hand-written in 16 places; the primitive is unused.
- Splitting `getModActivity` and `getBuzzHistory` out of `user-account.service.ts`, which is 746 lines
  and backs three endpoints against the app's one-file-per-endpoint rule.

Findings **outside** the migration (the `xguard` segment, `comics-review`, `images/downleveled`,
`images/ratings`, the dashboard's `onMount` fetch) were surfaced by an over-broad review scope and are
not this branch's business. They are real, and they want their own pass.

## 6. The two Retool Workflows (cron)

**Retool Workflows is a scheduled-job product, separate from Retool apps.** That is why the tracker
lists "Workflows (2)" as a row with no route: they are not pages and nothing about them ports into
`apps/moderator`. Our cron already lives in the main app (`src/server/jobs/`), which is where any
survivor belongs.

The candidates, identified from Moderation Status's inventory rather than from the workflow exports
themselves: `MinorInsert`, `PoIInsert`, `ModelInsert`, `newUserInsert`, the `*_catchup` variants and
the `*Timer` queries. These are backfills and timer bookkeeping, not moderation UI.

**This needs a decision per job, not a port.** For each one:

1. Does an equivalent main-app job already run? Several look like they duplicate existing search-index
   or metric jobs.
2. If not, is it still needed once Retool is gone — or was it feeding a Retool-only table
   (`Mods_TaskTimers`, `FrontPageTimers`) that nothing in the new app reads?
3. Only what survives both questions becomes a `src/server/jobs/*.ts` entry.

- [ ] Pull the two workflow exports from ClickUp (`868kn80u9`) while Retool access remains — they are
      the only record of what these actually run and on what schedule.
- [ ] Decide per job: already covered / port to main-app cron / drop with Retool.

Nothing here blocks the moderator app. It blocks *turning Retool off*.
