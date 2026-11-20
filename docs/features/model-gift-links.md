# Model gift links

A creator who gates a model version (permanent paid access or a timed early-access window) can hand
out access to it for free. They do this with a shareable gift link or with bulk single-use codes. A
signed-in recipient claims one and gets the same access a buyer gets. No Buzz moves.

Behind the `modelGiftLinks` feature flag (Flipt key `model-gift-links`). It is dark by default and
fails closed, in the main app and in Creator Studio alike.

The key is evaluated for whoever is viewing, and it gates the recipient's claim page and claim
endpoints too. **It must be on for every viewer for gifts to be redeemable.** A rollout limited to some
creators leaves their recipients with a 404. A creator-only pilot needs a separate gate on the creator
surfaces.

## What it does

- **Gift link:** one code, with an optional expiry and a cap on claims of 1 to
  `GIFT_LINK_MAX_REDEMPTIONS` (100). A request that names no cap gets `GIFT_LINK_DEFAULT_REDEMPTIONS`
  (10); an explicit `null` (uncapped) is refused with 400. Links made before the cap keep their own.
- **Single-use codes:** up to `GIFT_MINT_MAX_PER_CALL` (500) per call, minted from Creator Studio or the
  API. A version can hold at most `GIFT_LIVE_CODES_MAX_PER_VERSION` (5000) live, unclaimed codes
  (`src/server/services/model-version-gift.constants.ts`). The count and the insert run under one
  per-version advisory lock, so concurrent mints cannot pass it.
- **Who mints:** the creator only. Moderators can list and revoke a version's gifts but not mint them.
- **Claim:** done on the site (`/gift/<code>`, or a code pasted on `/gift`; an explicit click) or over the API with the recipient's
  token.
- **Monthly allowance:** each claimer can make a set number of new claims per UTC calendar month, by
  membership tier: free 3, Founder 15, Bronze 15, Silver 30, Gold 60. It is the usage-limit registry
  entry `gifts.monthly` (`src/shared/constants/usage-limits.ts`), so the `usage-limits` KeyValue row can
  override or disable it. Every claim recorded that month counts, including one later removed. A claim
  that records nothing (the claimer already had the access, or claimed the same link before) costs
  nothing. Past the allowance the claim gets a 429 that tells the claimer to reach out to the person
  who gave them the link, with product rate-limit metadata (`id`, `limit`, `used`, `remaining`, and
  `resetAt` at the start of the next UTC month). `/api/v1/me/limits` lists the same count as a
  `gifts.monthly` row, only to users the gift feature is released to.
- **Revoke:** done by the creator or a moderator, for a link or a whole batch. Revoking stops new claims
  immediately, including a claim already in flight. **People who already claimed keep their access.**
  Who claimed which link is `ModelVersionGiftRedemption`; a grant's `meta.giftLinkId` holds only the most
  recent link that user claimed.
- **Claimers:** the creator or a moderator can list who claimed a link or a batch (username, claim
  time and, for a removed claim, when it was removed; newest first). The claim page tells the recipient
  the creator can see that they claimed and can remove gifted access. The same sentence
  (`GIFT_CLAIM_NOTICE`) is returned with every recorded claim as `notice`. Claims made before `GIFT_CLAIMER_NAMES_VISIBLE_SINCE`, when that notice did not
  exist, are only counted (`hiddenCount`, on the first page only), never named. That moment must be
  later than the production deploy of the notice.
- **Remove one claim:** the creator or a moderator can take back what one claim granted
  (`removeGiftClaim`). The claim's slot stays used, so a capped link cannot be recycled, and the
  claimer cannot claim that link again (another link still works). The claimer is not notified. A claim
  made before `GIFT_CLAIMER_NAMES_VISIBLE_SINCE` cannot be removed: it is answered like a missing one,
  so a removal cannot confirm who claimed. Removals are rate limited per caller.

Out of scope:

- Gifting free versions or comics.
- Gifting generation only on a version that sells download.
- Buying a gift for someone else.
- An owner-menu entry on the model page (a follow-up).

## How access is granted

`EntityAccess` holds a user's grant on a version: a `permissions` bitmask
(`EntityAccessPermission.EarlyAccessGeneration` / `EarlyAccessDownload`) and a `meta` json.
`grantModelVersionAccess` (`src/server/services/model-version-access.service.ts`) is the one writer,
used by both the purchase (`earlyAccessPurchase`) and the gift claim. It is a single upsert that ORs
permissions and merges `meta` keys inside the database. A purchase's `*-buzzTransactionId`, which the
early-access refund reads, therefore survives a gift claim on the same row, and the other way round.

A gift grants what a buyer of the version would get: download plus generation when the version sells
download, and generation alone for a generation-only gate. A gift row carries no transaction id, so the
early-access refund never refunds it or deletes it. The refund window runs from `addedAt`, so the first purchase on a row a gift
created restarts it.

A user who already holds access is not charged again.

Removing a claim (`revokeGiftRedemption`) runs one transaction: mark the redemption revoked (only if it
belongs to a link of that version), lock the claimer's `EntityAccess` row, and then:

- If another of the claimer's claims on the version stands, change nothing.
- Otherwise clear the gift's bits, except those a recorded purchase pays for. The gift's bits are
  `meta["gift-permissions"]`, or all bits on a gift row without it, as the early-access refund reads them.
  Drop the `giftLinkId` and `gift-permissions` keys, and delete the row if it ends with no permissions
  and no purchase.

The row is locked before the check for other claims, so a claim on another link that commits during the
removal either shows up in the check or re-grants after it. A repeat claim of the removed redemption
waits for the removal and is refused.

**Limit:** only purchases are told apart. A gift bit that was also written to the row some other way
than a purchase or a gift claim (a legacy row, or one edited by hand) is cleared too.

## Schema

The migrations are `packages/civitai-db-schema/prisma/migrations/20261229120000_model_version_gift_link/`
and `20261231000100_model_version_gift_redemption_revoked/`.

- `ModelVersionGiftLink`: `codeHash` (unique), `codeHint` (last 4 characters), `label`, `batchId` (bulk
  codes), `maxRedemptions` (1 for bulk codes; null = uncapped, only on links made before the cap), `redemptionCount`, `expiresAt`,
  `revokedAt`/`revokedById`. It cascades from the version and from the creator.
- `ModelVersionGiftRedemption`: primary key `(giftLinkId, userId)`, so a user takes at most one slot of a
  link. `revokedAt`/`revokedById` mark a removed claim.
- Two `CHECK`s live only in the migration SQL: `maxRedemptions > 0`, and `redemptionCount <=
maxRedemptions`. The second is a backstop behind the claim's conditional update.

**Applying them.** They are hand-applied, never `prisma migrate deploy`. For each writable environment,
apply each before the code that reads it deploys:

1. Dry run: run the file inside `BEGIN; … ROLLBACK;`.
2. Apply it.
3. Run the scoped drift check, read-only:
   `DATABASE_URL=<target, read-only role> pnpm --filter @civitai/db-schema drift --migration prisma/migrations/<dir>/migration.sql`.
4. The drift check covers neither `CHECK`s nor indexes. Confirm them with `\d "ModelVersionGiftLink"`.

## Codes

A code is `cvg_` followed by 26 Crockford base32 characters from a CSPRNG, which is 130 bits of
entropy. Only a SHA-256 of the normalised code is stored. The plaintext is returned once, by the create
or mint call. Input is normalised before hashing: case-insensitive, hyphens ignored, and `I`/`L` read as
`1`, `O` as `0`.

`/gift/<code>` never renders: it moves the code into a short-lived, `HttpOnly` cookie on `Path=/`
and redirects to a bare `/gift`, so the code is not in any URL that page scripts or analytics record. The
cookie is cleared when the signed-in page reads it, so it cannot prefill the next account on that browser. Ads
are off on the claim page, and Faro's URL redaction (`src/utils/faro/redact.ts`) blanks a `/gift/<code>`
path segment, which a client-side navigation still puts in the Next data fetch.

## Claim

`claimGift` (`src/server/services/model-version-gift.service.ts`) runs these steps in order:

1. A per-user rate limit, applied before the lookup.
2. Hash the code and look it up. An unknown, revoked or expired code gets the same message.
3. Refuse the model's owner. Refuse a version or model that is not `Published`.
4. If the gate has ended, or the claimer already holds what the gift grants, return
   `alreadyHadAccess: true` and spend no claim.
5. `redeemGiftLink` runs one transaction: insert the redemption (`ON CONFLICT DO NOTHING`), then a
   conditional `UPDATE … SET "redemptionCount" + 1 WHERE` not revoked, not expired and under the cap,
   then the grant. If the update takes no row, the transaction rolls back. Postgres re-checks the
   `WHERE` on the row it locks, so racing claims for the last slot serialise.
   A new redemption first counts against the monthly allowance: under a per-claimer advisory lock, the
   claimer's redemptions in the current UTC month are counted, and past the limit the transaction
   rolls back (no slot, no grant). The lock makes two new claims at the last allowance serialise, and
   the second counts the first.
   A repeat claim by the same user takes no slot: while the link is live and the claim not removed it
   grants again, since the first grant can be gone (the early-access refund deletes the whole
   `EntityAccess` row).
6. Bust the claimer's generator model cache. Access is read from `EntityAccess` per request, so no
   version-wide cache needs refreshing.

## Surfaces

- **tRPC** (`modelVersionGift`): `list`, `create`, `revoke` and `claim`. `create` and `claim` are
  session-only (`blockApiKeys`).
- **REST**, under `/api/v1/model-versions`. Every route goes through `GiftEndpoint`
  (`src/server/utils/model-gift-endpoint.ts`), which requires `ModelsWrite` (a cookie session or a
  full-access key also passes), answers 404 while the flag is off, sends `private, no-store`, and gives
  every write the same onboarded, not-muted and email-verified gates as the tRPC writes.
  - `POST gifts/claim` with `{ code }`.
  - `GET gifts?limit=&cursor=` returns `{ items, nextCursor }`: the caller's own links and batches across
    every version of every model they own, newest first, at most `GIFT_INDEX_PAGE_MAX` (100) per page.
    Owner only; a moderator manages another creator's gifts per version.
  - `GET [id]/gifts` returns `{ links, batches }`: links, and one summary row per bulk batch (total,
    claimed, still live). Live ones sort first and are all listed; never codes.
  - `POST [id]/gifts` with `{ count, expiresAt?, label? }` mints single-use codes.
  - `POST [id]/gifts/link` with `{ maxRedemptions?, expiresAt?, label? }` creates a gift link.
    `maxRedemptions` is 1 to 100, 10 when omitted; `null` gets 400.
  - `DELETE [id]/gifts/[giftId]` and `DELETE [id]/gifts/batch/[batchId]` revoke.
  - `GET [id]/gifts/[giftId]/claims` and `GET [id]/gifts/batch/[batchId]/claims` return `{ claims,
    nextCursor, hiddenCount }`: `{ giftLinkId, userId, username, claimedAt, revokedAt }`, newest first,
    at most `GIFT_CLAIMS_PAGE_MAX` (100) per page. Owner or moderator, read from the replica.
  - `DELETE [id]/gifts/[giftId]/claims/[userId]` removes that claim (for a batch code, `giftId` is the
    claim's `giftLinkId`). Returns `{ removed: true }`; whether another claim kept the access is not
    said, since that claim can be one whose claimer is not named. A missing, already removed or
    pre-cutoff claim gets 404.
- **Creator Studio:** `/models/gifts` lists every link and batch across the creator's versions, with
  revoke, and links to `/models/gifts/[versionId]`. The version page is linked from a gated version's row
  on `/models`. Both call the REST routes with the creator's session. Codes appear once, in the action
  result, with copy and CSV download. A mature model's link points at civitai.red. A claimed link or
  batch row on the version page expands to its claimers, through `/models/gifts/[versionId]/claims`;
  each standing claim has Remove (with "frees no slot"), behind a confirm.
  The link form's Max claims is required, 1 to 100, and starts at 10.

## Tests

- `src/server/services/__tests__/model-version-gift.claim.pg.test.ts` runs the claim's SQL on a real
  Postgres (`APPDATA_TEST_DATABASE_URL`, the unit CI job's throwaway server; the suite fails in CI without it):
  - 10 concurrent claims on a 3-claim link grant exactly 3.
  - One user's 5 concurrent claims count once.
  - A revoked link leaves no grant.
  - A gift merges into a buyer's row without dropping the transaction id.
  - Removing a claim: gift-only access goes, purchased bits stay, another standing claim keeps access,
    the removed claim cannot be re-claimed, and the two races above (a repeat claim, a claim on another
    link) end correctly. The races hold a second connection's transaction open, so they are
    deterministic.
  - Monthly allowance: a claim past it takes no slot or grant; only claims in the month count,
    removed ones included; a repeat claim is free; one user's 10 racing claims grant exactly the
    limit; a new claim waits for one in flight and counts it; the `/me/limits` counter reports the
    same count.
- `src/server/__tests__/api-v1-model-version-gifts.test.ts` checks every REST route: a token without
  `ModelsWrite` gets 403 before the service runs, and the flag gates every route. It also covers the
  link cap and default, and the claim's 429 with `Retry-After` and `rateLimit`.
- `src/server/services/__tests__/model-version-gift.service.test.ts` covers codes, ownership, mint caps,
  no-spend claims, uniform refusals, the rate limit, and the monthly allowance per tier with its
  refusal metadata.
