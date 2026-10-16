# Moderator app: Model Flags

`Models → Model Flags` in the moderator app (`apps/moderator`, `/models/flags`) is where moderators decide
the minor and real-person (`poi`) flags on models. It replaces three pages (Minor Hash Matches, Model
Flag Appeals, Held Detections) with one section of three tabs on the shared triage shell: a list on the
left, the open item and its evidence on the right, decisions in a bar at the bottom.

Related: [minor-model-hash-detection.md](minor-model-hash-detection.md) (the hash sweep and the
auto-flag), [minor-detection-review.md](minor-detection-review.md) (text-scan holds and re-detections),
[text-scan.md](text-scan.md).

## Tabs

| Tab | Path | What is in it | Decisions |
|-----|------|---------------|-----------|
| Appeals | `/models/flags/appeals` | Every pending model appeal: minor, real-person, or both | **1** reject the appeal (flag stays), **2** approve it (flag lifted); a split keeps one label and lifts the other. A reason is required. |
| Flagged | `/models/flags/review` | Hash auto-flags inside their 30-day review window, and re-detections (text changed after a clear) | **1** keep the flag, **2** lift it. Re-detections take a reason (plus a note for Other); hash rows record none. |
| File matches | `/models/flags/matches` | Minor only: unflagged models that share a file with a model a moderator flagged as minor, from a different uploader | **1** flag as minor, **2** dismiss the match. No reason fields. |

Notes on the tabs:

- Same-uploader file matches are flagged automatically at scan time, so they appear in Flagged, not in File
  matches. A hash row can only be ruled as `minor`; the action refuses any other label. A hash flag past its 30-day window leaves the list but is still found by searching its model id, with the chip "review window closed".
- A model with an open appeal shows an "also in Appeals" chip in Flagged. Keeping its flag is disabled (the
  main app refuses it); lifting proceeds and closes the appeal. A re-detection under appeal is locked both ways.
- File matches rows carry the "uploaded Nd" age of the copy, not a match date: no match timestamp is
  stored. Prior decisions on the same file are not shown for the same reason.
- Search takes a model id, a user id or a username. Selection is mirrored in `?item=`.
- Writes go through the main app's `/api/mod/minor-flag/*` endpoints (`confirm`, `revert`, `set-minor`,
  `dismiss`, `resolve-appeal`, `resolve-redetection`); the spoke reads the queues itself. The set-minor,
  dismiss, confirm and revert endpoints take a model id only.

## Keyboard

| Key | Action |
|-----|--------|
| `J` / `K` | Next / previous item |
| `1` / `2` | The first / second decision of the open item, as listed above |

Keys are ignored while typing in a field and when a decision is disabled. On rows that need a reason, `1`
and `2` pick the verdict and the reason fields take focus; rows that record no reason submit immediately.

## Grants and routes

- Each tab is its own `AppPageAccess` row: `/models/flags/appeals`, `/models/flags/review`,
  `/models/flags/matches`, shown as three grantable rows under Models on `/admin`. Tabs only render for
  holders, and a direct URL to an ungranted tab is a 403.
- `/models/flags` has no page of its own; it redirects to the first tab the user holds.
- The sidebar shows one "Model Flags" entry with a combined count.
- The grants for the new paths are copied from the three old pages by a **hand-applied** migration,
  `packages/civitai-db-schema/prisma/migrations/20261101120000_moderator_model_flags_pages/`. Apply it before the
  release that ships the section; it is idempotent and leaves the old rows in place for rollback.

## Old URLs

Spoke (query string carried over):

| Old | New |
|-----|-----|
| `/models/minor-hash-matches` | `/models/flags/matches` |
| `/models/minor-hash-matches?tab=appeals` | `/models/flags/appeals` |
| `/models/minor-hash-matches?tab=auto` | `/models/flags/review?source=hash` |
| `/models/flag-appeals` | `/models/flags/appeals` |
| `/models/flag-appeals?view=redetected` or `/models/held-detections` | `/models/flags/review?source=redetected` |

Main app (`src/shared/constants/migrated-moderator-routes.ts`; its catchall drops the query string, so each
tab is its own key):

| Old | New |
|-----|-----|
| `/moderator/minor-hash-matches` | `/models/flags/matches` (a bare `?tab=` bookmark also lands here) |
| `/moderator/minor-hash-matches/appeals` | `/models/flags/appeals` |
| `/moderator/minor-hash-matches/auto` | `/models/flags/review?source=hash` |

## Not yet built

- Text-scan auto-flags (no moderator ruling yet) as a third Flagged source, and the `minorFlag.rule` action
  that would rule them. Today Flagged lists hash auto-flags and re-detections only.
- Reasons on the set-minor, dismiss, confirm and revert endpoints.
