# Rating disputes

How an owner contests the NSFW rating of something they published, and how a moderator (or the system) resolves it.

## Why it exists

A rated entity's `nsfwLevel` is derived: from its images and from a floor that the text scan of its text sets. A technical guide with a PG cover but a couple of R demo images, or a post whose caption the text scan read as mature, can land above what the owner intended. The dispute flow lets the owner ask for a different level, routes the request to one moderator queue, and auto-approves the cases the content itself already settles.

## Entity types

Six, spelled as `EntityModeration.entityType` spells them, from `@civitai/shared/rating-review` (`RATING_REVIEW_ENTITY_TYPES`): `Article`, `Model`, `Post`, `Bounty`, `BountyEntry`, `Challenge`. The same module holds the level options per entity, their labels, the entity page paths, the scan-reason reader and the notification builder, so both apps render the same thing.

Collections have no rating dispute: the text scan does not cover them in v1.

A Model's rating is its `nsfw` flag rather than a level. It is shown as SFW/NSFW and stored as PG (`nsfw = false`) or R (`nsfw = true`).

Feature flags: `articleRatingDispute` (Flipt `article-rating-dispute`) for Article, `ratingDispute` (Flipt `rating-dispute`) for the other five.

## Data model

`RatingReview` is the dispute row, one per submission:

| Column | Meaning |
|---|---|
| `entityType`, `entityId` | The disputed entity. `entityType` is `TEXT`: the `EntityType` enum has no `Challenge`. |
| `userId` | The owner who filed it. |
| `currentLevel` | The rating when filed: the highest set bit of `nsfwLevel` (Model: from `nsfw`). |
| `suggestedLevel` | What the owner asked for. |
| `appliedLevel` | What the resolution set; null until resolved, and null when the entity was gone. |
| `userComment`, `modComment` | Free text from each side. |
| `status` | `ReportStatus`: `Pending`, then `Actioned` (the suggestion was applied) or `Unactioned` (a different level was). |
| `resolvedBy`, `resolvedAt` | The moderator, or `constants.system.user.id` for an auto-approval. |
| `resolvedTextHash` | The hash of the text the last completed scan read, at resolve time (`result.textHash` on the `EntityModeration` row). |

A partial unique index `RatingReview_pending_per_entity` on `(entityType, entityId) WHERE status = 'Pending'` allows one open dispute per entity and serializes concurrent filings.

`ArticleRatingReview` is frozen history. The `RatingReview` migration copies its rows in (with new ids) and is re-runnable for the release cutover.

## Filing (main app)

`src/server/services/rating-review.service.ts` (`createRatingReview`, `getRatingReviewForOwner`), router `ratingReview.create` / `ratingReview.getMine`, and one `OwnerRatingControls` component on each of the six entity pages.

- **Owner only**, checked in the service.
- **One Pending per entity** (the partial unique index).
- **3 per 24h per user, shared across types**; moderators bypass. Redis key `rating-review:rate:<userId>`.
- **Eligibility.** Article is always disputable, including unrated. The others need the live `EntityModeration` row to be a text-scan raise (`result.version` set and a level above PG; Model R or above — `isTextScanRaised` from `@civitai/shared/rated-entity-sql`) or a prior resolved review. Non-Article unrated is refused.
- **Re-filing** after a resolution needs the scanned text to have changed: the live `result.textHash` differs from the last review's `resolvedTextHash`. An edit with no new completed scan cannot re-file until it is scanned. A copied row with no hash falls back to "the entity was edited after the resolution".

## Overrides and auto-approve

Article, Post, Bounty, BountyEntry and Challenge carry the override pair `moderatorNsfwLevel` + `moderatorNsfwLevelBasis`, always written and cleared together. The override wins over the derived level; the basis is the content-derived level when the override was written. Model has no override column: its resolution is the `nsfw` flag plus an `nsfw` lock.

When the content has since dropped below the basis, the owner sees a stale-override notice, and a dispute down to the content's level can auto-approve.

- **Article** keeps its own gate (`article-rating-review.helpers.ts`): down-direction, an active non-Blocked override, a clean scan, published, the derived level at or below the suggestion, and the derived level below the basis.
- **Post, Bounty, BountyEntry** use the generalized gate in `rating-review.derived.ts`: the same direction, override, no-scan-in-flight, settled-images and derived-below-basis conditions. Approval clears the pair, recomputes `nsfwLevel` in the same transaction, and queues the cascade. A Bounty approval also writes and locks `nsfw`.
- **Challenge** never auto-approves: lowering one also narrows its allowed mask and collection gate, which only the moderator resolve writes.

A Pending dispute blocked only by a scan in flight is re-evaluated when the scan completes (`maybeAutoResolveDisputeAfterScan` for Article, `maybeAutoResolveRatingDisputeAfterScan` for the others).

## Resolving (`apps/moderator`, `/ratings`)

`apps/moderator/src/lib/server/rating-reviews.service.ts` reads the queue and resolves; `rating-review-actions.ts` runs the side effects after commit. The page filters by status and by entity type, and shows the owner's comment and the scan's reason. `/articles/ratings` redirects to `/ratings?type=Article`.

A moderator applies a level; the review reads `Actioned` when it matches the suggestion and `Unactioned` otherwise. One transaction, every read that feeds a write on its connection:

1. Claim the Pending review with the status, `appliedLevel` and `resolvedTextHash`. A lost race reads "Review already resolved" and writes nothing.
2. If the entity is gone, close the review `Unactioned` with no other write.
3. Otherwise write the entity; an update that matches no row throws and the claim rolls back:
   - **Article, Post, BountyEntry:** the override pair and `nsfwLevel`; Article also locks `userNsfwLevel`.
   - **Bounty:** as above, plus `nsfw` from the applied level, locked.
   - **Model:** `nsfw`, keeping its lock. Marking a model NSFW is refused while it is flagged POI, minor or SFW-only, by the `UPDATE`'s own condition.
   - **Challenge:** lower-only, judged against the live level read under a row lock. The allowed mask is narrowed to the applied level, its collection's `forcedBrowsingLevel` follows, and the basis is the narrowed mask's level.
4. Queue `JobQueue(UpdateNsfwLevel)` for Post, Bounty, BountyEntry and Model, so the main app's crons run the connected-entity cascade.

The basis comes from the shared derivation (`computeRatedEntityDerivedNsfwLevel` in both apps) and is content only: it never reads the Bounty `nsfw` flag the resolve writes.

After commit: search-index sync for Article, Bounty and Model; for a Model, `/api/v1/model-versions/bust-cache` for its versions, since resource data carries `Model.nsfw`; the owner notification; a `ModActivity` row; and, for Article only, the `articleRatingReviewsResolved` ClickHouse event.

## Notifications

`rating-review-approved` and `rating-review-rejected`, `NotificationCategory.System`, built by `buildRatingReviewNotification` and linking to the entity page. Auto-approvals use the approved type. `article-rating-review-*` stays registered only to render historical notifications.

## Known follow-ups

- `ModActivity` rows for Post, Bounty, BountyEntry and Challenge show on the moderation board but not on the owner's User Lookup activity, which joins only image, model and article.
