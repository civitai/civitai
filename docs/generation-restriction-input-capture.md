# Generation Restriction Review — Capturing Input/Base Images

**Status:** Implemented (pending runtime verification)
**ClickUp:** [868k7bpgt](https://app.clickup.com/t/868k7bpgt) — "Show input/base images in generation restriction review UI"
**Author:** briant (with Claude)
**Date:** 2026-07-09 (revised after design review + the `sourceImage → images` consolidation)

---

## 1. The ask

In the moderator restriction-review UI (`/moderator/generation-restrictions`), surface the
input/base image(s) a user attached to a flagged generation job, next to the prompt and output
image. Motivation: prompts often reference a base image ("use this base image and make them
nude"), and the moderator can't currently tell a **deepfake against a real person's photo** apart
from **transforming AI-generated content** — very different severity.

## 2. The real problem (broader)

We want to capture enough of the blocked generation to review it faithfully **and** be robust to
workflow variance — different workflows attach media differently. A hand-picked flat schema
(`prompt`, `negativePrompt`, `imageId`, `remixOfId`) has been chasing each new ecosystem.

**Simplification from the recent `sourceImage → images` consolidation (merged):** every v2
generation graph now exposes its input images as a single `images` array (plus `video` for
vid2vid). So the "media variance" is largely gone — we no longer need to store a whole workflow to
be shape-agnostic. A small, uniform projection off the graph output covers it.

## 3. Current architecture

Trigger data for a restriction flows through **three stores**:

1. **Redis** — `generation:blocked-prompts:{userId}` (sysRedis), 30-day TTL. A transient
   **pre-mute accumulator**: each blocked attempt pushes one `BlockedPromptEntry`; the list length
   is the strike count toward auto-mute.
2. **Postgres** — `UserRestriction.triggers` (JSON column). The **durable, moderator-facing**
   store. Written **once, on auto-mute**: `reportProhibitedRequest` reads the whole Redis list via
   `getBlockedPrompts`, snapshots it into `dbWrite.userRestriction.create({ triggers })`, then
   clears Redis. This is what the review UI reads.
3. **ClickHouse** — `prohibitedRequests`. A separate durable audit log
   (`track.prohibitedRequest`), holding `prompt, negativePrompt, source, remixOfId, userId, time`.

### The `BlockedPromptEntry` shape (Redis + snapshotted to Postgres)

```ts
interface BlockedPromptEntry {
  prompt: string;
  negativePrompt: string;
  source: string; // 'Regex' | 'External'
  category?: PromptTriggerCategory;
  matchedWord?: string;
  matchedRegex?: string; // in the type, but never written to Redis (only backfill sets it)
  imageId: number | null; // documented "source image on remix" — never populated (dead field)
  remixOfId: number | null; // set only for remixes (a Civitai Image.id)
  time: string; // ISO timestamp — natural per-attempt key
}
```

### The ClickHouse reseed invariant

The flat schema encodes an invariant: **"a Redis `BlockedPromptEntry` is reconstructable from
ClickHouse `prohibitedRequests`."** Two paths depend on it:

- **Cold-start reseed** — `seedBlockedPromptsFromClickHouse` rebuilds the Redis list from CH
  columns after a key expiry / sysRedis wipe.
- **Backfill** — `backfillTriggers` rebuilds `UserRestriction.triggers` from those same CH columns.

CH holds only the flat columns, so any field we add to the entry that is **not** in CH will be
missing on reseeded/backfilled triggers. That's acceptable for a go-forward review aid (see §7),
and optionally closeable with a single bounded CH column (§6, optional).

## 4. Live data (sysRedis `generation:blocked-prompts:*`, 30-day window)

Measured 2026-07-09:

| Metric                            | Value                                                |
| --------------------------------- | ---------------------------------------------------- |
| Keys (users)                      | 5,279 (103 marker-only → **5,176 with real blocks**) |
| **Total blocked-prompt entries**  | **15,546**                                           |
| Users at/over mute threshold (8+) | **153**                                              |
| Median blocks/user                | 2 · Max 76 · Avg entry ~1,275 bytes                  |

Field fill-rates (of 3,003 sampled entries): `prompt` 100% · `negativePrompt` 68% ·
`category`/`matchedWord` 85% · `matchedRegex` **0%** · `imageId` **0% (dead)** ·
`remixOfId` **36%** (already a renderable Civitai image for over a third of blocks).

**Implications:** `imageId` is dead; `remixOfId` already covers ~36% of cases at zero new cost; the
other ~64% (txt2img, or img2img via uploaded blobs) have no image reference today. Only ~153 of
5,176 users (≈3%) ever get muted and reviewed.

## 5. Key findings (from design review)

1. **The media URLs are already in `data` at audit time — no build, no reorder.** In
   `generateFromGraph`, `validateInput` produces `data` (the validated graph output) _before_ the
   audit throws; `data.images[].url` / `data.video.url` are right there. We do **not** need to build
   or capture the assembled workflow.
2. **The full-workflow / reorder idea was rejected.** Building the workflow before the audit (to
   capture it) is (a) an evasion vector — `createWorkflowStepsFromGraph` throws on POI/bad
   resource/missing image, so moving it ahead of the audit lets a malformed request skip
   strike-counting; and (b) pointless — the workflow just wraps the same URLs, so it buys **zero**
   durability over storing the URLs directly (the bytes live at the URL either way).
3. **Store the projection inline in `BlockedPromptEntry`, keyed by nothing.** It rides the existing
   Redis → Postgres snapshot for free and avoids a separate keyed store (a `(userId, time)` join key
   is not unique — millisecond `time` collides on parallel submits).
4. **Go-forward only.** Reseeded/backfilled triggers won't have the media unless we also add it to
   ClickHouse (§6 optional).
5. **Blob-URL expiry is inherent.** We store URLs, not bytes; a stored orchestrator/upload URL can
   404 by review time. This is true of any approach — confirm the upload bucket's retention exceeds
   mute→review latency; not a differentiator.
6. **Prior art:** the "View Generations" drawer (`generation-restrictions.tsx`,
   `UserGenerationsDrawer`) already surfaces the user's _successful_ generations. This capture only
   fills the **blocked-attempt** gap.

## 6. Plan

**Capture a compact media projection off `data`, inline in the trigger. No reorder, no new store.**

### 6a. Server capture

- Extend `BlockedPromptEntry` (and `AuditPromptOptions`) with the projection:
  ```ts
  inputImages?: string[]; // base/source image URLs attached to the job
  inputVideo?: string;    // source video URL (vid2vid)
  ```
- In `generateFromGraph`, extract from `data` and pass into `auditPromptServer`:
  `data.images?.map(i => i.url)` (+ `data.sourceImage?.url` defensively for any legacy path) and
  `data.video?.url`. `auditPromptServer` writes them onto the `blockedEntry` it already builds — so
  they ride the existing Redis push → Postgres snapshot with **no** new store and **no** change to
  the mute-counting or reseed logic.
- Footprint: a handful of URL strings (~hundreds of bytes) per entry — negligible next to the
  existing ~1.3KB, and it only lands durably for the ~153 muted users/30d via the existing snapshot.

### 6b. UI render (`generation-restrictions.tsx`)

- Add the projection fields to the local `RestrictionTrigger` type.
- In `TriggerCard`, render the input images alongside the prompt: the captured `inputImages` /
  `inputVideo` URLs directly, plus `remixOfId` (already ~36% populated) via `EdgeImage`.

### 6c. ClickHouse durability (implemented)

Mirror the media into `prohibitedRequests` so reseeded/backfilled triggers keep it after a sysRedis
wipe. `default.prohibitedRequests` is `SharedMergeTree` (ClickHouse Cloud), so a single additive
`ALTER` replicates automatically — no `ON CLUSTER` / Distributed juggling.

**Applied (2026-07-10):**

```sql
ALTER TABLE prohibitedRequests
  ADD COLUMN IF NOT EXISTS inputImages Array(String) DEFAULT [],
  ADD COLUMN IF NOT EXISTS inputVideo Nullable(String);
```

Wired through: `tracker.prohibitedRequest` writes them; `reportProhibitedRequest` forwards them;
`seedBlockedPromptsFromClickHouse` (cold-start reseed) and `backfillTriggers` (router) `SELECT` and
restore them onto the rebuilt `BlockedPromptEntry`. Existing rows read the column defaults (empty),
matching reality — historical requests have no captured media.

### 6d. Rejected

- **Capture the built workflow** — unsafe reorder (evasion) + zero durability gain (§5.2).
- **Separate `blocked-workflow:{userId}:{time}` Redis store + promote-at-mute** — unnecessary once
  the payload is just a few URLs that fit inline; the `(userId, time)` key isn't unique anyway.
- **Store the whole `data`** — carries resources/params the moderator doesn't need; the `images`
  consolidation means a projection already covers the variance.

## 7. Caveats

- **Go-forward only** — media is captured from now on; requests logged before this change have no
  media (the CH columns default to empty). §6c keeps go-forward media across a Redis reseed/backfill.
- **Blob-URL expiry** — stored URLs may 404 by review time; depends on upload-bucket retention.
- Only ~3% of blocked users are ever reviewed, but inline capture is cheap enough that per-attempt
  storage is a non-issue (unlike the rejected full-workflow approach).

## 8. Implementation checklist

- [x] `BlockedPromptEntry` + `AuditPromptOptions`: add `inputImages?: string[]`, `inputVideo?: string`
- [x] `generateFromGraph`: extract media from `data`, pass to `auditPromptServer`
- [x] `auditPromptServer`: write the projection onto `blockedEntry`
- [x] `generation-restrictions.tsx`: extend `RestrictionTrigger`, render images + `remixOfId` in `TriggerCard`
- [x] ClickHouse columns + tracker/report/reseed/backfill wiring (§6c)
- [ ] Drive the restriction UI to confirm images render (runtime verification)
