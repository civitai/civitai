# Daily Challenge — Participation Reconciliation + Pending-Review Badge

> Spec. Bug: [ClickUp 868hva8p7](https://app.clickup.com/t/868hva8p7) — "Daily Challenge entries still under review".
> Author: AI (verified against live prod data 2026-06-23). Reviewer: @manuel

## 1. Problem

Daily-challenge **participation prizes** are awarded only to users whose entries reach
`CollectionItem.status = 'ACCEPTED'`. An entry only becomes `ACCEPTED` when the challenge
review step runs over it — and that step **skips images whose NSFW level has not been
assigned yet** (`Image."nsfwLevel" = 0`, i.e. still in the moderation Review Queue):

`src/server/jobs/daily-challenge-processing.ts:636-662` (review promotion):
```sql
WHERE ci."collectionId" = ${collectionId}
  AND ci.status = 'REVIEW'
  AND i."nsfwLevel" != 0      -- ⟵ unscanned entries are skipped
```

The participation prize (both the hourly path `…:940-1007` and the final path
`…:1219-1267`) gates on `ci.status = 'ACCEPTED'`. The hourly review job
(`reviewEntries`, cron `*/10 * * * *`) only processes **Active** challenges. So the failure is a race:

1. User submits entries; images enter the Review Queue (`nsfwLevel = 0`).
2. Challenge ends → status `Completed`. Final prize distribution runs on whatever is
   already `ACCEPTED`.
3. Image scanning finishes **after** completion → `nsfwLevel` is set, but the challenge is
   no longer Active, so nothing ever promotes those `REVIEW` items to `ACCEPTED`.
4. The user met the requirement on paper, but the late-scanned entries never counted →
   **no participation prize, permanently.**

### Evidence (live prod, 2026-06-23)

Challenge 306 ("Unleash Your Inner Cyber Artist!", ended 2026-06-23 04:00:13):
- 182 `CollectionItem`s stuck in `REVIEW`. **All 180 of the scanned-but-stuck ones have
  `reviewedAt IS NULL`** — the review step never touched them.
- Those images were scanned **05:10–06:09**, i.e. 1–2h *after* completion.

Across the last 20 days of completed challenges, **15 of ~19** had 1–20 users each who
would have qualified for the participation prize had their stuck `REVIEW` entries counted
(`accepted < requirement` AND `accepted + review >= requirement`). Requirement is uniformly
10 accepted entries. Total ≈ 71 affected user-instances.

Scan-lag distribution (last 10 days, 21,595 challenge entries, `scannedAt − createdAt`):

| p50 | p90 | p95 | p99 | max | >1h | >2h |
|-----|-----|-----|-----|-----|-----|-----|
| 0.6 min | 4.7 min | 30 min | **606 min (~10h)** | 1277 min (~21h) | 1023 (4.7%) | 967 (4.5%) |

Fat-tailed: 90% scan in <5 min, but ~4.5% take >2h (up to 21h). No fixed grace window
covers the tail, which is why we reconcile *after* completion instead of delaying it.

## 2. Goals / Non-Goals

**Goals**
- G1 — Back-pay the participation prize to users whose entries become eligible **after** a
  challenge completes, **once those entries are actually rated and accepted** (never pay for
  unrated/rejected entries).
- G2 — Let challenges close exactly on schedule (do not delay winner announcement or the
  next challenge start).
- G3 — Show the entry owner (and only the owner) a "Pending review" indicator on their own
  challenge entries that are still under review, to set expectations about judging eligibility.

**Non-Goals**
- NG1 — **Do not** re-pick or re-judge winners after completion. Winner selection stays on
  the on-time snapshot. (Late entries can still miss *winning*; they will not miss
  *participation*.)
- NG2 — **Do not** count `REVIEW` entries as if accepted for prize purposes. Eligibility
  always requires a real `ACCEPTED` state produced by the normal review rules
  (safe NSFW level, matching resource, recent).
- NG3 — Not fixing the underlying scan-pipeline latency (the fat tail). Tracked separately —
  see §7.

## 3. Design

Two independent workstreams. They share no state and can ship separately.

### Workstream A — Post-completion reconciliation (the fix)

Add a reconciliation pass to the existing hourly `challenge-completion` job
(`src/server/jobs/challenge-completion.ts`, cron `0 * * * *`). After the normal
"complete ended challenges" loop, it sweeps **recently-completed** challenges that still
have un-promoted `REVIEW` entries and:

1. **Re-runs the existing review promotion** over the challenge's collection. This moves
   now-scanned `REVIEW` items to `ACCEPTED` or `REJECTED` using the *same* safe/resource/recent
   rules as the live job. Unscanned (`nsfwLevel = 0`) items remain `REVIEW` and are simply
   retried next hour. **Only genuinely accepted entries ever count** (satisfies NG2).
2. **Re-evaluates participation eligibility** (`status = 'ACCEPTED'` count ≥
   `entryPrizeRequirement`), excluding challenge winners and anyone already paid.
3. **Pays the newly-eligible users** via Buzz, idempotently, and notifies them.

**Selection window.** Reconcile challenges with `status = 'Completed'` and
`"endsAt" > now() - interval '48 hours'` that still have at least one `REVIEW`
`CollectionItem`. The 48h window comfortably covers the observed p99 (~10h) / max (~21h)
scan lag. Past the window, any remaining `REVIEW` items are assumed to be permanently
unscannable (deleted/errored images) and are abandoned — logged, not paid.

**Idempotency (no double-pay).**
- Buzz: reuse the existing per-(challenge,user) key
  `challenge-entry-prize-${challengeId}-${userId}`. `createBuzzTransactionMany` forwards
  `externalTransactionId` to the Buzz API, which rejects duplicates — so a repeated pay is a
  no-op (`buzz.service.ts:474`).
- Bookkeeping: persist the set of paid user IDs in `Challenge.metadata.reconciliation.paidUserIds`.
  The final distribution path also records its paid users there, so reconciliation never
  re-pays or re-notifies a user who was already handled at completion time.

**Notifications (no clobber, no duplicates).** `createNotification` upserts a
`PendingNotification` row keyed by `key`, **replacing** its `users` array. Two reconcile
runs sharing one static key could clobber each other's pending recipients. So reconcile uses
an hour-bucketed key: `challenge-participation:${challengeId}:reconcile:${YYYY-MM-DD-HH}`
(the job runs at minute 0, so the bucket is stable within a run). Combined with the
`paidUserIds` delta, each user is notified exactly once.

**Winners exclusion.** Winners receive the winner prize, not participation. Reconciliation
loads winner user IDs from `ChallengeWinner` (`WHERE "challengeId" = …`) and excludes them,
matching the final path's `entryPrizeUsers = earned.filter(!winner)` logic.

**Refactor required (no behavior change).** The review-promotion SQL and the section-6
participation logic are currently inline. Extract each into a reusable helper so the
reconciliation pass and the existing live paths call the *same* code:
- `promoteChallengeEntries(...)` ← `daily-challenge-processing.ts:636-662`
- `distributeParticipationPrizes(...)` ← `daily-challenge-processing.ts:1219-1267`

**Failure isolation.** Per-challenge try/catch + `logToAxiom`, exactly like the existing
completion loop. One challenge failing must not block others.

#### Why not "delay completion until the queue drains"?
Considered and rejected: the scan tail reaches 10–21h, so a grace window long enough to be
correct would delay winner announcements and the next challenge by most of a day, and would
still need a hard cap (some images never scan). Reconciliation decouples correctness from
timing and handles arbitrary lag. Accepted tradeoff: the participation prize lands hours
late for affected users — strictly better than never.

### Workstream B — Owner-only "Pending review" badge

Show a `Pending review` badge on a challenge entry card **iff** the viewer owns the image
**and** the entry's `CollectionItem.status = 'REVIEW'`.

**Why `status = 'REVIEW'` and not `nsfwLevel = 0`?** `REVIEW` is the true "under review"
state. An entry can be `REVIEW` with `nsfwLevel != 0` for up to ~10 min between scan and the
next hourly promotion; keying on status badges it correctly during that window too.

**Data gap.** The feed query `getAllImages` does **not** currently expose
`CollectionItem.status` to the client (it only returns `collectionItemNote`). The owner
*can* already see their own `REVIEW` items (server filter `displayOwnedItems`,
`image.service.ts:1341` / `:1582-1587`), so only the field needs surfacing:
- Add `ci."status"` to the `ct` CTE (`image.service.ts:1569-1603`).
- Select `ct.status as "collectionItemStatus"` when `collectionId` is set
  (`image.service.ts:1832`).
- Add `collectionItemStatus?: CollectionItemStatus | null` to the raw-row type
  (`image.service.ts:1140-1167`). It flows into `ImagesInfiniteModel` automatically via the
  `...i` spread at `image.service.ts:2046`.

**Render.** In `ImagesCard.tsx` (`src/components/Image/Infinite/ImagesCard.tsx`), add the
badge to the existing top-left badge cluster (`:150-172`, next to the POI/JudgeScore
badges), gated by a small pure helper `shouldShowPendingReviewBadge(image, currentUser?.id)`.
Owner check: `currentUser?.id === image.userId` (`userId` is already on the model).

**Scope note.** `collectionItemStatus` is only populated on collection-filtered feed queries.
The challenge entries view filters by `collectionId`
(`src/pages/challenges/[id]/[[...slug]].tsx:1598`), so the badge appears there. It will also
appear for an owner's own `REVIEW` items in any other reviewed-collection view — acceptable
and consistent. Non-collection feeds leave the field `undefined` → no badge. The
search/Meili feed path (`image.service.ts:2870`) does not set the field; the challenge view
uses the raw-SQL path, so this is fine — **verify during implementation** that the challenge
entries grid hits the raw path, not search.

## 4. Data / Schema changes

- `Challenge.metadata` (JSON, no migration): extend the Zod `challengeMetadataSchema`
  (`src/server/schema/challenge.schema.ts:90-105`) with:
  ```ts
  reconciliation: z
    .object({
      paidUserIds: z.array(z.number()).optional(),
      lastRunAt: z.string().optional(),  // ISO
      done: z.boolean().optional(),       // true once no REVIEW items remain
    })
    .optional(),
  ```
- No SQL migration. No new tables/columns. `collectionItemStatus` is a query-only addition.

## 5. Idempotency & correctness summary

| Concern | Mechanism |
|---|---|
| Double Buzz pay | `externalTransactionId = challenge-entry-prize-{challengeId}-{userId}` (Buzz API dedup) + `metadata.reconciliation.paidUserIds` |
| Pay for unrated entry | Impossible — only `status = 'ACCEPTED'` counts; promotion still skips `nsfwLevel = 0` |
| Pay a winner | Excluded via `ChallengeWinner` lookup |
| Duplicate notification | Hour-bucketed reconcile key + `paidUserIds` delta |
| Concurrent job runs | Single hourly cron; reconciliation is idempotent regardless |
| Never-scanning images | 48h window bound; abandoned + logged after |

## 6. Testing strategy

- **Pure unit tests (Vitest)** for the decision logic, where the real correctness lives:
  - `selectPayableUsers(qualifierIds, excludeUserIds)` — set difference (winners ∪ already-paid).
  - `shouldShowPendingReviewBadge(image, currentUserId)` — owner + `REVIEW`.
  - `parseChallengeMetadata` round-trips the new `reconciliation` field.
- **Integration / manual** for the SQL + job wiring (these jobs have no DB unit harness):
  add a guarded debug endpoint `src/pages/api/testing/challenge-reconcile.ts`
  (`WebhookEndpoint`, scoped to a single `challengeId` per call) that runs
  `reconcileCompletedChallenge` and returns counts (promoted, qualified, paid, skipped).
  Verify against a recently-completed challenge on preview (e.g. 306-class) and confirm:
  promoted > 0, paid = newly-eligible non-winners, a second call pays 0 (idempotent).
- **Visual** for the badge: component-preview / Ladle story, owner vs non-owner, dark+light.

## 7. Rollout & follow-ups

- Gate the reconciliation pass behind the existing `CHALLENGE_PLATFORM_ENABLED` Flipt flag
  (the completion job already checks it). No separate flag needed; the pass is additive and
  idempotent.
- One-time backfill: after deploy, run the debug endpoint over the last ~20 days of
  completed challenges (the ~71 historical affected users) to pay out the backlog.
- **Follow-up (separate ticket):** scan-pipeline fat tail — ~1000 entries/10d take >1h,
  p99 ≈ 10h, max ≈ 21h. Independent of challenges; worth its own investigation (queue
  backlog? a specific scan stage stalling?).

## 8. Open questions

- @manuel: 48h reconciliation window OK, or prefer tighter/looser?
- @manuel: badge copy — "Pending review" vs "Under review" vs "Awaiting rating"? Tooltip
  wording (suggest: "Still being reviewed — not yet eligible for judging").
- @manuel: should the badge be restricted to *challenge* collections only, or is showing it
  on any owner-visible `REVIEW` collection item acceptable (current plan)?
