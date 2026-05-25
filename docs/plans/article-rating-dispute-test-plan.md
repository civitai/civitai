# Article Rating Dispute — Manual Test Checklist

Test articles (user 1290051, status=Published, ingestion=Scanned):

| ID | System | Owner | URL |
|---|---|---|---|
| 30471 | 4 (R) | 1 (PG) | `/articles/30471` |
| 30472 | 8 (X) | 2 (PG-13) | `/articles/30472` |
| 30473 | 16 (XXX) | 4 (R) | `/articles/30473` |

Flag: `article-rating-dispute` (Flipt). Enable for user 1290051 + a mod account before testing.

---

## Owner — Article detail page

- [ ] Logged in as **user 1290051**, visit `/articles/30471`
- [ ] "Rating: R" chip visible near article header
- [ ] "Request rating review" button visible + enabled
- [ ] Logged out: chip + button NOT visible
- [ ] Logged in as a **different user** (not owner): chip + button NOT visible
- [ ] Logged in as **moderator** who is ALSO the owner: chip + button NOT visible (mod controls take precedence)

## Owner — Submit dispute modal

- [ ] Click "Request rating review" → modal opens
- [ ] Modal shows current system level chip
- [ ] Level Select shows PG / PG-13 / R / X / XXX (real labels, none empty)
- [ ] Default selection is one level below current (R article → PG-13 default)
- [ ] Comment textarea: 500-char counter increments + caps at 500
- [ ] Link to education.civitai.com guideline page opens in new tab
- [ ] Submit with empty comment → succeeds
- [ ] Submit with comment → succeeds; modal closes; success toast shows
- [ ] Button now reads "Review pending" + disabled
- [ ] Hover the disabled button → tooltip shows "Submitted <time ago>"

## Owner — Rate limit + duplicate guards

- [ ] Submit on #30472, then #30473 — both succeed (count = 2)
- [ ] Submit a 4th dispute (manually create + delete one) → 429 "You can only submit 3 rating reviews per day"
- [ ] On article with a Pending review, try API call again → 400 "A review is already pending for this article"
- [ ] Wait until tomorrow OR clear Redis key `article:rating-review-rate-limit:1290051` to reset

## Mod dashboard — `/moderator/article-rating-review`

- [ ] Visit page logged out → redirects (middleware guard)
- [ ] Visit as non-mod → redirects
- [ ] Visit as mod → page renders
- [ ] Three pending review cards visible (one per article submitted above)
- [ ] Each card shows: cover image, article title (link), owner username (link), 3 level chips (System / Owner suggested / Mod applied)
- [ ] Owner comment visible if provided (collapsed UI if Spoiler used)
- [ ] Limit dropdown: change 50 → 25 — list re-fetches, no stale rows from previous page count
- [ ] Status filter: change to Actioned — empty list; back to Pending — 3 rows return
- [ ] "Require reason" toggle: ON → Dismiss button disabled when comment empty; tooltip fires on hover of disabled state
- [ ] Click article title → opens `/articles/<id>` in new tab

## Mod dashboard — Approve flow

- [ ] On a card, SegmentedControl defaults to owner's suggested level
- [ ] Change applied level
- [ ] Optionally type a mod comment
- [ ] Click Approve → row disappears from list (no full-list refetch flash)
- [ ] Open `/articles/<id>` in new tab → `nsfwLevel` reflects mod's chosen level
- [ ] Run SQL to verify state:
  ```sql
  SELECT id, "nsfwLevel", "userNsfwLevel", "moderatorNsfwLevel", "lockedProperties"
    FROM "Article" WHERE id = 30471;
  ```
- [ ] `moderatorNsfwLevel` = applied level, `nsfwLevel` = applied level, `'userNsfwLevel'` in `lockedProperties`
- [ ] Owner gets `article-rating-review-approved` notification — title + level labels + mod comment if set
- [ ] Notification link goes to `/articles/<id>`

## Mod dashboard — Dismiss flow

- [ ] On another card, type a mod comment, click Dismiss
- [ ] Row disappears from list
- [ ] Verify article unchanged:
  ```sql
  SELECT "nsfwLevel", "moderatorNsfwLevel" FROM "Article" WHERE id = 30472;
  ```
- [ ] `moderatorNsfwLevel` still NULL, `nsfwLevel` unchanged from system
- [ ] Owner gets `article-rating-review-rejected` notification — reason field present if comment was set
- [ ] Filter dashboard to Status: Unactioned → dismissed row appears, action controls hidden (greyed out)

## Owner — Post-resolution state

- [ ] As owner, revisit `/articles/<approved-id>`
- [ ] Button now reads "Last review approved on <date>" + disabled
- [ ] If mod left a comment, hover → tooltip shows it
- [ ] Same for dismissed article: "Last review declined on <date>"
- [ ] Notifications panel shows both approved + rejected entries

## Owner — Re-edit gate

- [ ] As owner, edit a previously-resolved article (any field, save)
- [ ] On save: confirm modal "A moderator previously set this article's rating manually..." appears (only if `moderatorNsfwLevel != null`, i.e. on the approved one)
- [ ] Cancel → save aborts
- [ ] Confirm → save proceeds + triggers rescan
- [ ] After save, button on detail page returns to "Request rating review" + enabled (canResubmit flipped server-side)
- [ ] Verify SQL:
  ```sql
  SELECT id, "updatedAt", "contentScannedAt" FROM "Article" WHERE id = <approved-id>;
  ```
- [ ] `updatedAt` is newer than the review's `resolvedAt`

## Race / concurrency

- [ ] Open two mod-tabs on the same pending review
- [ ] Approve from tab A
- [ ] In tab B, click Approve (or Dismiss) → 404 error "Review already resolved" (no double-notification, no double Article update)
- [ ] Check owner's notification count: exactly ONE for that review

## Flipt flag

- [ ] Disable `article-rating-dispute` flag in Flipt for user 1290051
- [ ] Click "Request rating review" → 403 from `createRatingReview` proc
- [ ] Disable flag for the mod account → `/moderator/article-rating-review` page query returns 403 (page shows empty/error state)
- [ ] Re-enable to continue testing

## ClickHouse events

- [ ] Submit one dispute → query CH:
  ```sql
  SELECT * FROM articleRatingReviews
   WHERE articleId = 30471
   ORDER BY time DESC LIMIT 1;
  ```
  Row exists w/ `fromLevel`, `toLevel`, `hasComment` populated
- [ ] Resolve one dispute → query CH:
  ```sql
  SELECT * FROM articleRatingReviewsResolved
   WHERE articleId = 30471
   ORDER BY time DESC LIMIT 1;
  ```
  Row exists w/ `status`, `appliedLevel` (NULL for Unactioned), `moderatorId`
- [ ] If CH tables don't exist yet, errors only appear in server logs (catch-swallowed) — verify no user-facing failures

## Cleanup

When done:

```sql
DELETE FROM "ArticleRatingReview" WHERE "articleId" IN (30471, 30472, 30473);
DELETE FROM "Article" WHERE id IN (30471, 30472, 30473);
-- Or keep them around if you want to re-test
```

Clear Redis rate-limit key if you want to reset count between sessions:
```
DEL article:rating-review-rate-limit:1290051
```
