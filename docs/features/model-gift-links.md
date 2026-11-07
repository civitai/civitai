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

- **Gift link:** one code, with an optional expiry and an optional cap on claims.
- **Single-use codes:** up to `GIFT_MINT_MAX_PER_CALL` (500) per call, minted from Creator Studio or the
  API. A version can hold at most `GIFT_LIVE_CODES_MAX_PER_VERSION` (5000) live, unclaimed codes
  (`src/server/services/model-version-gift.constants.ts`). The count and the insert run under one
  per-version advisory lock, so concurrent mints cannot pass it.
- **Who mints:** the creator only. Moderators can list and revoke a version's gifts but not mint them.
- **Claim:** done on the site (`/gift/<code>`, or a code pasted on `/gift`; an explicit click) or over the API with the recipient's
  token.
- **Revoke:** done by the creator or a moderator, for a link or a whole batch. Revoking stops new claims
  immediately, including a claim already in flight. **People who already claimed keep their access.**
  Who claimed which link is `ModelVersionGiftRedemption`; a grant's `meta.giftLinkId` holds only the most
  recent link that user claimed.

Out of scope:

- Gifting free versions or comics.
- Gifting generation only on a version that sells download.
- Buying a gift for someone else.
- Claimer usernames: creators see counts only.
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

## Schema

The migration is `packages/civitai-db-schema/prisma/migrations/20261229120000_model_version_gift_link/`.

- `ModelVersionGiftLink`: `codeHash` (unique), `codeHint` (last 4 characters), `label`, `batchId` (bulk
  codes), `maxRedemptions` (null = uncapped, 1 for bulk codes), `redemptionCount`, `expiresAt`,
  `revokedAt`/`revokedById`. It cascades from the version and from the creator.
- `ModelVersionGiftRedemption`: primary key `(giftLinkId, userId)`, so a user takes at most one slot of a link.
- Two `CHECK`s live only in the migration SQL: `maxRedemptions > 0`, and `redemptionCount <=
maxRedemptions`. The second is a backstop behind the claim's conditional update.

**Applying it.** It is hand-applied, never `prisma migrate deploy`. For each writable environment,
apply it before the code deploys:

1. Dry run: run the file inside `BEGIN; … ROLLBACK;`.
2. Apply it.
3. Run the scoped drift check, read-only:
   `DATABASE_URL=<target, read-only role> pnpm --filter @civitai/db-schema drift --migration prisma/migrations/20261229120000_model_version_gift_link/migration.sql`.
4. The drift check covers neither `CHECK`s nor indexes. Confirm them with `\d "ModelVersionGiftLink"`.

## Codes

A code is `cvg_` followed by 26 Crockford base32 characters from a CSPRNG, which is 130 bits of
entropy. Only a SHA-256 of the normalised code is stored. The plaintext is returned once, by the create
or mint call. Input is normalised before hashing: case-insensitive, hyphens ignored, and `I`/`L` read as
`1`, `O` as `0`.

`/gift/<code>` never renders: it moves the code into a short-lived, `HttpOnly` cookie scoped to `/gift`
and redirects to a bare `/gift`, so the code is not in any URL that page scripts or analytics record. Ads
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
   A repeat claim by the same user takes no slot: while the link is live it grants again, since the first
   grant can be gone (the early-access refund deletes the whole `EntityAccess` row).
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
  - `GET [id]/gifts` returns `{ links, batches }`: links, and one summary row per bulk batch (total,
    claimed, still live). Live ones sort first and are all listed; never codes.
  - `POST [id]/gifts` with `{ count, expiresAt?, label? }` mints single-use codes.
  - `POST [id]/gifts/link` with `{ maxRedemptions?, expiresAt?, label? }` creates a gift link.
  - `DELETE [id]/gifts/[giftId]` and `DELETE [id]/gifts/batch/[batchId]` revoke.
- **Creator Studio:** `/models/gifts/[versionId]`, linked from a gated version's row on `/models`. It
  calls the REST routes with the creator's session. Codes appear once, in the action result, with copy
  and CSV download. A mature model's link points at civitai.red.

## Tests

- `src/server/services/__tests__/model-version-gift.claim.pg.test.ts` runs the claim's SQL on a real
  Postgres (`APPDATA_TEST_DATABASE_URL`, the unit CI job's throwaway server; the suite fails in CI without it):
  - 10 concurrent claims on a 3-claim link grant exactly 3.
  - One user's 5 concurrent claims count once.
  - A revoked link leaves no grant.
  - A gift merges into a buyer's row without dropping the transaction id.
- `src/server/__tests__/api-v1-model-version-gifts.test.ts` checks every REST route: a token without
  `ModelsWrite` gets 403 before the service runs, and the flag gates every route.
- `src/server/services/__tests__/model-version-gift.service.test.ts` covers codes, ownership, mint caps,
  no-spend claims, uniform refusals and the rate limit.
