# Scope from ClickUp

Two tickets define this migration. Their content is reproduced as checklists here so the work does not
depend on ClickUp access.

> **Direct instructions supersede these tickets.** The tickets are background and scope, not standing
> orders — where guidance from the team conflicts with what a ticket says, the team wins. Record the
> override here rather than leaving the two in silent disagreement.

- **868kkxqpn** — *Moderation Tooling — Retool → Civitai migration (design)*: what to build. **Its
  subtasks carry the app exports**, one per app.
- **868kn67aq** — *ReTool Database Migration*: which tables to move. (A subtask of the above.)
- **868kn8aa0** — *Misc Mod Asks*: deferred requests that are not Retool ports.

App-by-app progress lives in [MIGRATIONS.md](MIGRATIONS.md). This file is the higher-level scope.

> **868kn67aq contains the Retool database password in its description.** Anyone with ticket access has
> production credentials. Worth raising, and worth rotating when the migration completes.

---

## 868kn67aq — database migration

Six tables named for migration, plus one candidate for deletion.

**Treat this list as a guide, not a definitive scope.** It neither matches nor bounds what the exports
query, in both directions:

- Tables here that no *current* export reads are most likely for **Retool apps not yet handed over** —
  not dead data. Do not propose dropping a table just because nothing we have read touches it.
- Tables missing from the list may simply have been overlooked by whoever wrote the ticket. Two are
  known already (below).

Cross-check against [retool-db-tables.md](../../../docs/moderator-app/retool-exports/retool-db-tables.md),
which is derived from the live schema and the exports rather than from memory.

- [ ] **`User`** — 25,359 rows. `(userId, deservedMute, spamWhitelist)`. Not a user roster: two
      moderation flags keyed by Civitai user id. Duplicates the same two columns on `UserNotes` —
      establish which is authoritative before moving either.
- [ ] **`UserNotes`** — 56,339 rows. Moderator notes. Attribution by name; needs
      [the id mapping](../../../docs/moderator-app/retool-exports/moderator-id-mapping.md).
- [ ] **`UserStrikes`** — 12,771 rows. Strike history. Same attribution problem.
- [ ] **`ModelNotes`** — 930 rows. `(modelId, createdBy, createdAt, content)`. **Keep — do not drop.**
      No Retool app writes it; the data was exported *into* Retool for safekeeping. Ticket 868kn8aa0
      ("Misc Mod Asks") wants it surfaced, which is deferred — see below.
- [ ] **`RatingChanges`** — 363,465 rows, the largest table. `(imageId, rating, originalRating,
      updatedBy, createdAt)` — an audit trail of image-rating changes. No export we hold reads it;
      Moderation Status has rating-review queries, so the app that writes this is plausibly one we have
      not seen. Size makes it the bulk of the migration, so confirm its owner before planning it.
- [ ] **`ReToolActions`** — 131,024 rows. Retool's own action log. Free text, no join key — the user id
      is embedded in `ActionType` and queried with `LIKE`. Migrate into `ModActivity`, keep as a
      read-only archive, or drop.
- [x] **`BuzzCodes`** — 294 rows. `(createdBy, code)`. **Drop — do not migrate.** Confirmed unused by
      Seb, 2026-08-06: *"buzzcodes is indeed not used, i didnt know if it was data worth keeping or
      not.. it can probably be dropped"*.

### Missing from the ticket — probably an oversight

Both are read by exports we already hold, so they belong in the migration unless someone says otherwise.

- [ ] **`ModerationImageHelp`** — 37 open rows, actively read by Moderation Status
      (`GetHelpers`/`UpdateHelpRequest`). Without it the help-request feature dies with Retool.
- [ ] **`TimedMutes`** — read by User Lookup (`RevokeTimedMutes`, `ViewMutes`), but the table is empty.
      Confirm whether the feature is dead before building or dropping.

### When a new export arrives

Re-run the table cross-reference — an export may reference tables nobody has accounted for yet:

```bash
node .claude/skills/retool-migration/extract.mjs "<new export>.json" --json   # find retool_db queries
node .claude/skills/retool-migration/retool-db.mjs --tables                   # what exists, with counts
```

Add anything new to this checklist and to
[retool-db-tables.md](../../../docs/moderator-app/retool-exports/retool-db-tables.md).

### Cross-cutting

- [ ] Apply [the moderator id mapping](../../../docs/moderator-app/retool-exports/moderator-id-mapping.md)
      — 72% exact, 21% variants to confirm, 6% unmapped.
- [ ] Decide the fate of the largest unmapped identifier's 3,888 notes (a former moderator — named in
      the private mapping, not here).
- [ ] `TimedMutes.userId` is `text` where the others are `integer` — cast, after checking for
      non-numeric values.
- [ ] Rotate the Retool credentials once the migration is done.

---

## 868kkxqpn — moderation tooling design

The full per-app breakdown is in
[docs/moderator-app/retool-migration-tasks.md](../../../docs/moderator-app/retool-migration-tasks.md).
The conventions that apply to every page:

- [x] **Permissions gated by role** — grant-based, `/admin`.
- [x] **Shared entity resolver** — user by id / username / email (User Lookup). Content tools still need
      post / model / model-version resolution.
- [ ] **Action attribution and logging** — every action logged with who, what, when, target, reason.
      `ModActivity` is append-only and indexed for this, but has **no reason/detail column** — add one
      before §1.2e and §1.5 can show *why* something happened.
- [ ] **Everything on one screen** — reports, past removals, past reports and the offending content
      together.

### Apps V1

- [x] **§1.1 Overview page** — dashboard with per-queue counts. Anti-overlap (check-in or
      action-logging warnings) not started.
- [ ] **§1.2 User Lookup** — 8 of 11 slices shipped. Remaining: account actions, mutes, Freshdesk.
- [ ] **§1.3 Bulk Image Manager** — masonry grid, load by entity, bulk ToS with reason + optional
      strike, nsfwLevel and date filters.
- [ ] **§1.5 User / Post Reports** — reports list with images inline, plus prior mod activity and prior
      reports on the same screen.
- [ ] **§1.6 Chat Audit** — blocked on open questions (read-only? whose conversations? retention?).
- [ ] **§1.7 Image Lookup** — by image id: rating history, delete/ToS/review history, full Image row.
- [ ] **§1.8 Article Lookup** — full Article row by id.
- [ ] **§1.9 Front Page Audit** — open question: drop, or keep a video-only version? Sound is the usual
      miss.
- [ ] **§1.12 Buzz add/subtract** — open question: standalone app or inside User Lookup?

### Apps V2

- [ ] **§2.1 Bulk Ban** — restricted tool.
- [ ] **§2.2 Moderation Rules** — low priority, "not used much".
- [ ] **§2.3 Model notes** — free text on models. `ModelNotes` above is the existing data.

### Workflows

- [ ] Migrate the two confirmed-active Retool workflows: *Daily Challenge — Not Prepared Check*,
      *Daily Challenge — Not Started Check*. Both are webhook-triggered alerting flows, **not cron**
      — see the Workflows row in `MIGRATIONS.md`.
- [ ] Find what calls the `startTrigger` webhook on those two. The export does not say, and the
      alerts point at the Hangfire job scheduler, so that is the first place to look.
- [ ] Rotate the three credentials the exports carried (Discord webhook token, PagerDuty routing key,
      `run-jobs` webhook token) — they were attached to a ClickUp task, so treat them as disclosed.
- [ ] Audit the remaining Retool workflows for usage before decommissioning anything.

---

## 868kn8aa0 — Misc Mod Asks (deferred)

Not Retool ports; requests that happen to depend on migrated data. **Deferred — the reason it is
recorded here is that it settles what happens to `ModelNotes`.**

- [ ] **Model notes on model pages** — surface the exported `ModelNotes` on
      `civitai.com/models/<id>`, and let moderators add notes and edit their own.
      This is a **main-app** feature, not a moderator-app page: the notes appear on the public model
      page for moderators, so it lands in `src/`, not `apps/moderator`.
      Overlaps ticket 868kkxqpn §2.3, and matches the add/edit-own pattern already built for user notes
      in `moderation-memory.service.ts`.
      **Consequence for the database migration: `ModelNotes` must be kept.** The 930 rows are the whole
      point of the ask — nothing writes them today because they were exported *into* Retool for
      safekeeping.

### Open questions blocking scope

| Question | Blocks |
| --- | --- |
| Front Page Audit — drop or slim down? | §1.9 |
| Buzz — standalone or inside User Lookup? | §1.12 |
| Anti-overlap — check-in, warnings, or both? | §1.1 |
| Chat Audit — visibility and retention? | §1.6 |
| Which of Moderation Status's 77 queries are still live? | that whole app |

Sections **1.4, 1.10 and 1.11 are absent** from the ticket — numbering jumps 1.3 → 1.5 → 1.9 → 1.12.
Confirm nothing was lost in editing.
