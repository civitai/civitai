# Retool migration — handover checklist

Everything on branch `moderator-app-pages` that a **person** has to do. Code-side work is finished and
committed; this is what cannot be done from a diff.

Written 2026-08-07. Delete items as they are done.

---

## 1. Environment — `apps/moderator/.env`

- [ ] **`CIVITAI_MOD_API_KEY=`** — currently unset. Without it, bulk comment delete, comment ToS,
      review delete and review exclude/include **refuse up front** (they fail with a clear message
      rather than silently). It is a **moderator user's API key sent as a Bearer token**, NOT
      `WEBHOOK_TOKEN` — `/api/mod/retool/*` authenticates via `getSessionFromBearerToken` and rejects
      the webhook token. The account it belongs to needs the mod role and becomes the recorded actor
      for those writes. Documented in `.env.example`.

- [ ] **`FRESHDESK_TOKEN` → `FRESHDESK_API_KEY`** — pre-existing bug, not from this migration.
      `freshdesk.service.ts:27` reads `env.FRESHDESK_API_KEY`; the local `.env` defines
      `FRESHDESK_TOKEN`. The support panel in User Lookup has therefore been showing
      "no contact found" for **every** user regardless of whether they have contacted support.

- [ ] **`FRESHDESK_DOMAIN` includes a scheme** (`https://civitai.freshdesk.com`). The service builds a
      URL from it and `.env.example` has it bare. Check it is not producing `https://https://…`.

- [ ] **`MODERATOR_DATABASE_URL` is defined twice in `.env.example`** (lines 44 and 54) with different
      values — the local xguard-lab one and the Retool one. Last-wins happens to give the intended
      Retool value, but it should not be ambiguous.

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
- [ ] Confirm the existing Retool pages still carry the grants you expect after the User Lookup
      restructure — its sections moved to `/retool/user-lookup/[section]`, and `canAccess`
      longest-prefix matches.

## 2c. Re-extract the remaining Retool exports

**`extract.mjs` only learned to emit widget option sets on 2026-08-07.** Every export taken before
that — `user-reports`, `bulk-image-manager`, `front-page-audit`, `moderation-status`,
`article-lookup` — has no "tabs & option sets" section, which is where tab labels, dropdown presets
and canned workflows live. That blind spot is what left 97 User Lookup queries unported.

It matters most for **User Reports** (17 of 57 components are buttons) and **Bulk Image Manager**.

The ClickUp skill is not configured locally (`accounts.json`/`.env` missing in
`.claude/skills/clickup/`), so this needs either those credentials or the raw exports dropped into
`~/Downloads/Retool/`. Then:

```bash
node .claude/skills/retool-migration/extract.mjs "<export.json>"
```

- [ ] Re-extract `user-reports` and re-check its audit against the surfaced option sets
- [ ] Re-extract the three not-yet-started apps before their slices begin

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
