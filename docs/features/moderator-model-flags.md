# Moderator app: Model Flags

`Models → Model Flags` in the moderator app (`apps/moderator`, `/models/flags`) is where moderators decide
the minor and real-person (`poi`) flags on models. It replaces three pages (Minor Hash Matches, Model
Flag Appeals, Held Detections) with one section of three tabs (at the top of the list column) on the
triage shell: a list on the left, the open model's header and preview in the middle, and the decisions in
a compact bar pinned under a right sidebar.

Related: [minor-model-hash-detection.md](minor-model-hash-detection.md) (the hash sweep and the
auto-flag), [minor-detection-review.md](minor-detection-review.md) (text-scan holds and re-detections),
[text-scan.md](text-scan.md).

## Tabs

A tab says whether a flag is applied; a chip on the row says what found it.

| Tab | Path | What is in it | Decisions |
|-----|------|---------------|-----------|
| Appeals | `/models/flags/appeals` | Every pending model appeal: minor, real-person, or both | **1** reject the appeal (flag stays), **2** approve it (flag lifted); a split keeps one label and lifts the other. A reason is required. |
| Auto-flagged | `/models/flags/auto` | Flags automation applied that nobody has ruled on: hash auto-flags inside their 30-day review window and text-scan auto-flags. One row per model, carrying each waiting flag | **1** confirm, **2** revert; with two labels, a split keeps one. Text-scan flags take a reason (plus a note for Other); hash flags record none. |
| Needs review | `/models/flags/needs-review` | Leads nothing was applied for: text-scan detections the scan held (chip "text scan · first detection" or "text scan · re-detection") and file matches (chip "hash", explicit "minor" badge). One row per model | **1** flag, **2** don't flag (a match-only row: dismiss match). Detections take a reason; file matches record none. |

Notes on the tabs:

- Same-uploader file matches are flagged automatically at scan time, so they appear in Auto-flagged, not in
  Needs review. A hash flag can only be ruled as `minor`; the action refuses any other label. A hash flag past
  its 30-day window leaves the list but is still found by searching its model id, with the chip "review window
  closed".
- A text-scan row in Auto-flagged is a label whose scan flag has no ruling: the entry has a workflow, no upheld
  or granted ruling and no held detection, and the live `minor`/`poi` column is still on. It has no review
  window. Applying it snapshots the model with source `text-scan`; a minor flag whose snapshot has any other
  source (`auto`, `manual`) belongs to the hash sweep or a moderator and is listed once, as the hash flag (or
  not at all once confirmed or aged out). Confirm or revert posts to
  `minor-flag/rule` with the text hash the moderator was shown and a `flagReview` reason; the main app refuses a
  stale hash.
- Needs review rules a held detection through `resolve-redetection` and a file match through `set-minor` or
  `dismiss`. A model with both is one row; the detection is ruled first, then the match. Flagging both keeps the
  detection only: its minor flag (snapshotted with source `text-scan`) settles the match, and the model leaves
  the queue as minor; `set-minor` again would re-run its side effects as a second, moderator-sourced flag. "Flag
  as minor" on a match whose model is already minor for another reason is refused. A row's time is when the
  scan held the detection or, for a match, when the shared file was uploaded (no match timestamp is stored), and
  the list sorts oldest first.
- Needs review also lists, above its merged leads, models the text scan rated NSFW while their owner had them
  marked minor, a real person or SFW-only ("Scan rated NSFW on a restricted model"), from the server-owned
  `meta.restrictedNsfwVerdict` lead: minor first, then real person, then SFW-only. A lead held as minor stays
  minor in that order after the owner unticks the flag.
  - On a minor, real-person or Private model, or one a moderator locked SFW-only, the scan records the lead and
    leaves the rating alone. It applies, as on any other model and recorded on the lead, when an owner's save
    clears minor and real person, or when the model leaves Private (publishing it, or a moderator changing its
    availability), in the same write. On a public SFW-only model the scan applies the rating at once, clearing
    SFW-only, and records the lead with what it replaced. An owner who ticks minor or real person over a rating the scan set
    clears that rating, and the same save records the scan's verdict as a lead.
  - Ruled under `modelFlags.detections.decide` through `model/resolve-restricted-nsfw-verdict`: **Keep owner's
    rating** (nsfw off, SFW-only restored where the scan cleared it, and the scan's own lock for the lead
    lifted; a moderator's or a later scan's lock stands; on a model still minor or a real person the verdict is
    kept, server-owned, and applies if the owner later clears the flag; Keep and Dismiss also settle the
    owner's flag record, so a later lift of the flag does not restore the scan's rating), **Dismiss** (a minor lead needs a
    reason; refused while the model is NSFW and SFW-only, which its owner cannot save, or NSFW and minor or a
    real person) or **Rate NSFW** (refused
    while the model is minor, a real person or Private; a lead held as minor needs a reason).
  - Each ruling, and each rating the scan applies itself, logs a ModActivity row and keeps the values it
    replaced in `meta.restrictedNsfwVerdictRulings`. The block shows how many leads wait when it lists fewer.
    The sidebar's Needs review badge adds these leads to the held-detection count; a model with both counts
    twice.
- Each row and detail header says which other tabs the model waits in ("also in Appeals", "also in
  Auto-flagged", "also in Needs review"). In the header the chip links to the model in that tab when the viewer
  holds it. With an open appeal, confirming an applied flag is disabled (the main app refuses it) while reverting
  proceeds and closes the appeal; a held detection under appeal is locked both ways.
- Appeals filter by flag (All, Minor, Real person) and source (Hash, Text scan, Moderator). An appeal whose
  model is no longer flagged, or whose flag has no recorded source, has no chip of its own: it lists under All
  and its row says "no longer flagged" or "no flag record". Old `?flag=unflagged` and `?source=none` links open
  All.
- Search takes a model id, a user id, a username or part of a model name, and runs 300 ms after typing stops
  (Enter runs it at once). Selection is mirrored in `?item=`.
- Writes go through the main app's `/api/mod/minor-flag/*` endpoints (`confirm`, `revert`, `set-minor`,
  `dismiss`, `resolve-appeal`, `resolve-redetection`, `rule`); the spoke reads the queues itself. The set-minor,
  dismiss, confirm and revert endpoints take a model id only.

The preview (`ModelPreview`, shared with the model report queue) is one horizontally scrolling row of
the model's images. A video is a still poster frame with a play icon. Each tile carries its
browsing-level badge, and a "minor" or "acceptable minor" badge when the image scan tagged it.
`/api/model-preview/[modelId]` serves it to `/reports/model` and the three Model Flags tabs.

The file-match card is titled by what the match can show: "Same file as a flagged model" when a
moderator-flagged model still shares the file (with what became of that model: unpublished, deleted,
drafted), "Flagged by a moderator" for a manual minor flag, and "Hash match can't be verified" when
no flagged model shares the file any more. The sweep records no seed, so the match is resolved live.

## Keyboard

| Key | Action |
|-----|--------|
| `J` / `K` | Next / previous item |
| `1` / `2` | The first / second decision of the open item, as listed above |

Keys are ignored while typing in a field and when a decision is disabled. A key presses its decision
button: it submits with the reason already in the bar, or says what is missing; rows that record no reason
submit immediately.

## Grants and routes

- Each tab is its own `AppPageAccess` row: `/models/flags/appeals`, `/models/flags/auto`,
  `/models/flags/needs-review`, shown as three grantable rows under Models on `/admin`. Tabs only render for
  holders, and a direct URL to an ungranted tab is a 403.
- Needs review lists, and its action rules, only the kinds of lead the viewer holds a permission for:
  `modelFlags.detections.decide` (held detections) and `modelFlags.fileMatches.decide` (file matches). Both are
  ticked on `/admin` beside the other permissions. A viewer holding the tab but neither permission sees an
  empty list that says so.
- `/models/flags` has no page of its own; it redirects to the first tab the user holds.
- The sidebar shows one "Model Flags" entry whose count sums the held tabs, each counted in models. A model
  waiting in two tabs counts in both. Needs review's badge counts only the kinds the viewer may rule, and a
  model with a detection and a file match once.
- The grants are copied from the three old pages by a **hand-applied** migration,
  `packages/civitai-db-schema/prisma/migrations/20261101120000_moderator_model_flags_pages/`: Appeals from Model
  Flag Appeals; Auto-flagged, Needs review and the detections permission from Held Detections plus Minor Hash
  Matches; the file-matches permission from Minor Hash Matches. Apply it before the release that ships the
  section; it is idempotent (`ON CONFLICT DO NOTHING`) and leaves the old rows in place for rollback. An
  earlier draft of it (tabs `review` and `matches`) was applied on dev only; re-running the current file there
  copies those rows forward and deletes them.
- `20261101130000_model_text_scan_flagged_idx` is a hand-applied partial index on
  `Model (id) WHERE meta->'textScanFlags'->'minor' ? 'workflowId' OR meta->'textScanFlags'->'poi' ? 'workflowId'`
  for Auto-flagged's text-scan flags. The queries repeat its predicate; until it is applied they scan
  `"Model"` (about 0.5 s on dev), so the sidebar count stays bounded.

## Old URLs

Spoke (query string carried over):

| Old | New |
|-----|-----|
| `/models/minor-hash-matches` | `/models/flags/needs-review?source=hash` |
| `/models/minor-hash-matches?tab=appeals` | `/models/flags/appeals` |
| `/models/minor-hash-matches?tab=auto` | `/models/flags/auto?source=hash` |
| `/models/flag-appeals` | `/models/flags/appeals` |
| `/models/flag-appeals?view=redetected` or `/models/held-detections` | `/models/flags/needs-review?source=text-scan` |
| `/models/flags/review` | `/models/flags/auto` (`?source=redetected`: `/models/flags/needs-review?source=text-scan`) |
| `/models/flags/matches` | `/models/flags/needs-review?source=hash` |

Main app (`src/shared/constants/migrated-moderator-routes.ts`; its catchall drops the query string, so each
tab is its own key):

| Old | New |
|-----|-----|
| `/moderator/minor-hash-matches` | `/models/flags/needs-review?source=hash` (a bare `?tab=` bookmark also lands here) |
| `/moderator/minor-hash-matches/appeals` | `/models/flags/appeals` |
| `/moderator/minor-hash-matches/auto` | `/models/flags/auto?source=hash` |

## Not yet built

- Reasons on the set-minor, dismiss, confirm and revert endpoints.
