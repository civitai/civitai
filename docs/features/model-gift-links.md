# Model gift links (draft plan)

Status: **plan, not built.** Decisions still open are marked `@ai:`.

A creator who gates a model version (permanent paid access or a timed early-access window) can hand out
access to that version for free. The creator does this with a gift link or with single-use codes. A
signed-in recipient claims one and gets the same access a buyer gets. No Buzz moves.

## Scope

- **Gift link.** One code, shareable, with an optional expiry and an optional cap on redemptions.
- **Bulk single-use codes.** The creator's API token mints N codes for one gated version, each claimable
  once. This is for creators who hand out codes from their own tooling (Patreon, Discord bots).
- **Claim.** Done on the site (tRPC) or over REST with the recipient's API token. Either way the claim
  grants access through the existing `EntityAccess` grant path.
- **Revoke.** The creator, or a moderator, revokes a link or a code batch. A revoked code cannot be claimed.

Out of scope: gifting free versions, gifting comics (`PaidAccessEntityType.ComicChapter`), buying a gift
for someone else with Buzz (that is a purchase and goes through the money path), and transferring a claim.

## How access is granted today (what this reuses)

- `PaidAccess` (config side): a row means the version is gated. `isPaidAccessActive` decides whether the
  gate is live. `terms` says what is sold (download and/or generation).
- `EntityAccess` (grant side): one row per `(accessToId, accessToType, accessorId, accessorType)`, with a
  `permissions` bitmask (`EntityAccessPermission.EarlyAccessGeneration` / `EarlyAccessDownload`) and a
  `meta` json. `hasEntityAccess` (`src/server/services/common.service.ts`) reads it.
- The only model-version writer is `earlyAccessPurchase` (`src/server/services/model-version.service.ts`).
  It charges Buzz, upserts the `EntityAccess` row with `meta.{download,generation}-buzzTransactionId`,
  then runs `bustMvCache(versionId, modelId, userId)`.

**Reuse:** move the upsert and the cache bust out of `earlyAccessPurchase` into one helper,
`grantModelVersionAccess({ userId, modelVersionId, permissions, meta, addedById, tx? })`. The purchase
calls it as it does today, with no behaviour change. The gift claim calls it with
`meta.giftLinkId` and no transaction id. That keeps one place that writes a model-version grant.

Why a gift grant needs no special-casing elsewhere:

- `model-early-access-refund.service.ts` refunds only rows that carry a `*-buzzTransactionId`. A gift row
  carries none, so it is never refunded. It is also never deleted by the refund loop, which deletes only
  the buyers it refunded.
- Nothing else in `src/server` reads `"EntityAccess"` as a sales count. A gift therefore does not show up
  as a sale, does not feed a donation goal, and does not set `meta.hadEarlyAccessPurchase`.

`RedeemableCode` (`redeemableCode.service.ts`) was considered and rejected. Its codes are Buzz/membership
value stored in plaintext as the primary key, consumed once, with no per-entity target or cap. Bending it
to fit would change a money table's semantics.

## Schema

One migration, `packages/civitai-db-schema/prisma/migrations/<ts>_model_version_gift_link/migration.sql`,
mirrored in `schema.full.prisma`, then `pnpm run db:generate`.

```prisma
model ModelVersionGiftLink {
  id              Int       @id @default(autoincrement())
  modelVersionId  Int
  modelVersion    ModelVersion @relation(fields: [modelVersionId], references: [id], onDelete: Cascade)
  createdById     Int
  createdBy       User      @relation(fields: [createdById], references: [id], onDelete: Cascade)
  codeHash        String    @unique          // hash of the code; the code itself is never stored
  codeHint        String                     // last 4 chars, so the creator can tell links apart
  label           String?                    // creator's note ("Patreon tier 2")
  batchId         String?                    // set on bulk-minted single-use codes
  maxRedemptions  Int?                       // null = uncapped; 1 for bulk codes
  redemptionCount Int       @default(0)
  expiresAt       DateTime?
  revokedAt       DateTime?
  revokedById     Int?
  createdAt       DateTime  @default(now())
  redemptions     ModelVersionGiftRedemption[]

  @@index([modelVersionId, createdAt(sort: Desc)])
  @@index([batchId])
}

model ModelVersionGiftRedemption {
  giftLinkId Int
  giftLink   ModelVersionGiftLink @relation(fields: [giftLinkId], references: [id], onDelete: Cascade)
  userId     Int
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  claimedAt  DateTime @default(now())

  @@id([giftLinkId, userId])
  @@index([userId])
}
```

A `CHECK ("maxRedemptions" IS NULL OR "maxRedemptions" > 0)` and a
`CHECK ("maxRedemptions" IS NULL OR "redemptionCount" <= "maxRedemptions")` go in the migration SQL only.
The second is a backstop: the claim's conditional update is what enforces the cap, and the check turns
any bug in it into a failed claim rather than an overshoot.

`@ai:` Should deleting a version cascade its gift links (as above), or keep them for audit? `EntityAccess`
is polymorphic and the version delete already cleans it by hand (`model-version.service.ts`, the
"EntityAccess and PaidAccess are polymorphic" block). Gift links have a real FK, so cascade is the simple
default.

No new enum values, so there is no deploy-before-migrate ordering.

**Applying (by hand, per writable environment).** Never `prisma migrate deploy`.

1. Dry run: run the migration inside `BEGIN; … ROLLBACK;` against the target.
2. Apply it.
3. Scoped drift check, read-only:
   `DATABASE_URL=<target, read-only role> pnpm --filter @civitai/db-schema drift --migration prisma/migrations/<dir>/migration.sql`.
4. Clean, or fix it. The drift check does not cover indexes or check constraints, so confirm the two
   `CHECK`s and both indexes directly with `\d "ModelVersionGiftLink"`.

The migration must be applied before the code that reads the tables deploys.

## Codes

- The server generates the code from a CSPRNG with enough entropy that guessing is not practical. It stores
  only `codeHash` (a SHA-256 of the code). A random, high-entropy code needs no slow hash, and a plain
  digest keeps lookup a single unique-index hit. The plaintext is returned once, in the create/mint
  response, and is never readable again. A lost link is revoked and re-minted.
- Link URL: `https://civitai.com/gift/<code>`. That page claims on click once the user signs in. The code
  sits in the path, not the query string, and the page sets `Referrer-Policy: no-referrer`.
- `@ai:` Code format. Proposal: a prefix such as `cvg_` plus base32 without ambiguous characters, so a code
  pasted into the API is easy to recognise and a leaked code is easy to find in a secret scanner.

## Services (`src/server/services/model-version-gift.service.ts`)

- `createGiftLink({ userId, modelVersionId, maxRedemptions?, expiresAt?, label? })` returns `{ id, code }`.
- `mintGiftCodes({ userId, modelVersionId, count, expiresAt?, label? })` returns `{ batchId, codes[] }`.
  It inserts `count` rows with `maxRedemptions = 1` in one `createMany`, with a per-call cap on `count`.
  `@ai:` Proposal: 500 per call, plus a ceiling on the live unredeemed codes per version, so one leaked
  token cannot mint without bound.
- `listGiftLinks({ userId, modelVersionId })`: hint, label, counts, expiry, revoked state. Never the code.
- `revokeGiftLink({ userId, id })` and `revokeGiftBatch({ userId, batchId })` set `revokedAt`. The update is
  scoped `WHERE id = ? AND "createdById" = ?` (moderators bypass the owner clause), and 0 rows is an error.
- `claimGift({ userId, code })` returns `{ modelVersionId, modelId, alreadyHadAccess }`.

**Who may create or mint.** The model's owner (the same check `assertMonetizationWrite` makes), and only
while `PaidAccess` for the version is active. A version that is not gated has nothing to gift.

**Claim, in order:**

1. Hash the code and look the row up. If there is no row, or it is revoked or expired, return one generic
   "invalid or expired gift" error. The response does not say which case applied.
2. Load the version and its `PaidAccess`. Refuse when the claimer owns the model. Refuse when the version
   is not `Published`. `@ai:` Allow claims on a scheduled or unpublished version, so a creator can seed
   testers before launch? The grant would sit unused until publish, so the default is to refuse.
3. If the gate is no longer active (a timed window lapsed), return `alreadyHadAccess: true` and **consume
   nothing**. The version is free now.
4. If the claimer already has the permissions the gift would grant (a buyer, or an earlier gift), return
   `alreadyHadAccess: true` and **consume nothing**. A cap is not spent on someone who gains nothing.
5. In one `dbWrite.$transaction`, with database work only (per `no-io-in-transaction`):
   - `INSERT INTO "ModelVersionGiftRedemption" … ON CONFLICT DO NOTHING RETURNING 1`. If no row comes back,
     this user already claimed this link, and the transaction stops without incrementing.
   - The cap and liveness check is a single conditional update:
     ```sql
     UPDATE "ModelVersionGiftLink"
        SET "redemptionCount" = "redemptionCount" + 1
      WHERE id = $1
        AND "revokedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > now())
        AND ("maxRedemptions" IS NULL OR "redemptionCount" < "maxRedemptions")
     RETURNING id
     ```
     If no row comes back, throw, which rolls back the redemption insert. Postgres re-evaluates the `WHERE`
     on the row lock, so two concurrent claims on the last slot serialise: one gets the row, and the other
     sees the incremented count and gets 0 rows. That makes the cap atomic without `SERIALIZABLE`.
   - `grantModelVersionAccess({ tx, permissions, meta: { giftLinkId }, addedById: link.createdById })`.
6. After commit, bust the caches (`bustMvCache`) and fire the recipient notification, both outside the
   transaction.

**Permissions granted.** Whatever the version sells: `EarlyAccessGeneration + EarlyAccessDownload` when
`terms.download` is set, `EarlyAccessGeneration` alone for a generation-only gate. An existing row is
merged with `Math.max`, as the purchase does, so a gift never downgrades a buyer.
`@ai:` Should a creator be able to gift generation-only on a version that sells download? That would add a
`permissions` column to the link. Left out until someone asks for it.

**Interaction with purchase.** `earlyAccessPurchase`'s "already purchased" check looks for a
`*-buzzTransactionId`. A gift row has none, so a gifted user is not blocked from buying. The buy button
is already hidden on `hasAccess`, so this is reachable only by calling the API directly, and it would
charge someone for access they already hold. Plan: extend that check to refuse when the existing
permissions already cover the requested type, whatever the source.

## Revocation semantics

Revoking stops new claims immediately. That holds even for a claim in flight, because the conditional
update re-reads `revokedAt` under the row lock.

**Access already granted is kept.** A recipient who claimed in good faith keeps what they claimed, the same
way a buyer keeps a purchase. The `EntityAccess` row carries `meta.giftLinkId`, so revoking a link's
grants could be added later as a separate, explicit, moderator-visible action.

`@ai:` **Justin's call.** Is "keep granted access" the product rule? The alternative is
revoke-and-remove: delete the `EntityAccess` rows whose `meta.giftLinkId` matches, but only when they
carry no transaction id, so a buyer who also claimed a gift is not stripped.

## Surfaces

### tRPC (`model-version.router.ts`, or a small `model-version-gift.router.ts`)

| Procedure                         | Kind                                             | Meta                                               |
| --------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `giftLink.create`                 | `protectedProcedure` mutation                    | `requiredScope: ModelsWrite`, `blockApiKeys: true` |
| `giftLink.list`                   | `protectedProcedure` query                       | `requiredScope: ModelsRead`                        |
| `giftLink.revoke` / `revokeBatch` | `protectedProcedure` mutation                    | `requiredScope: ModelsWrite`                       |
| `giftLink.claim`                  | `protectedProcedure` mutation + `rateLimit(...)` | `requiredScope: ModelsWrite`, `blockApiKeys: true` |

`create` and the site claim are session-only (`blockApiKeys`). Token callers use the REST routes below,
which keeps the scope decision for token callers in one place per action.

### REST (`src/pages/api/v1/model-versions/gifts/`)

- `POST /api/v1/model-versions/gifts/claim` with body `{ code }`. The caller is the recipient's API token.
- `POST /api/v1/model-versions/[id]/gifts` with body `{ count, expiresAt?, label? }` bulk-mints single-use
  codes. The caller is the creator's API token.
- `GET /api/v1/model-versions/[id]/gifts` lists links (never codes). `DELETE …/gifts/[giftId]` and
  `DELETE …/gifts/batch/[batchId]` revoke.

`AuthedEndpoint` checks no scope by itself. Each handler calls `matchedScope` from
`src/server/services/oauth/enforce-token-scope.ts`, the same way `src/pages/api/v1/me/limits.ts` does, and
returns 403 before any read. A cookie session and a full-scope key pass.
`@ai:` Which scope? `ModelsWrite` fits both: a claim changes what the recipient can do with a model, and a
mint changes the creator's model. A dedicated scope bit would be cleaner for creators handing a
mint-only key to a bot, but adding a `TokenScope` bit touches `packages/civitai-auth`, the consent screen
and the developer docs. Proposal: `ModelsWrite` now, and a dedicated bit if creators ask.

These are public endpoints. Per `.claude/rules/public-api.md`, each one gets a page in the developer-docs
repo, opened as a PR alongside this one and merged only after release.

### Creator Studio (`apps/creator-studio`)

Creator Studio writes paid access through the main app (`$lib/server/main-app.ts` `callMainApp`, which
forwards the creator's session cookie) rather than through Kysely, because the write's side effects live
in the main app. Gift links follow the same route: the REST routes above, called with the cookie session.

- A "Gift links" panel on the version's monetization editor, next to the paid-access settings in
  `src/routes/(app)/models/`. It is a sibling component of the page, per `docs/svelte-app-standard.md`.
- The `load` reads the list. Form `actions` handle create, mint and revoke, each validated with zod. A
  newly created code is shown once in the action result, with a copy button and a "you won't see this
  again" note. It is never put in page data that survives a reload.
- Mint offers a CSV download of the codes from the same action result.
- `@ai:` Should the panel also show who claimed each link, by username? It is useful for creators, but it
  exposes recipients' identities to the creator. The default is to show counts only.

### Site (`src/`)

- `src/pages/gift/[code].tsx` is the claim page. Signed out, it sends the user to sign in and back.
  Signed in, it shows the model card and a Claim button (an explicit click, not an auto-claim on load), then
  links to the model.
- `@ai:` The model page could also get a "Gift links" entry in the owner's version menu, linking to Creator
  Studio. Is it needed at launch?

## Rate limiting

- Site claim: the tRPC `rateLimit` middleware, keyed per user.
- REST claim and mint: a per-user bucket from `src/server/utils/rate-limit-bucket.ts`, plus the per-call
  mint count cap above.
- The numbers live in code, not in this doc. Failed claims count against the limit as well as successful
  ones, so guessing gets slower with each attempt.

## Tests that must fail if the guard breaks

Each test below names what it catches. Each needs a positive control: revert the guard, run the test, and
quote the failure.

1. **Cap overshoot, concurrent** (`model-version-gift.claim.pg.test.ts`, against real Postgres, not
   mocks). A mock cannot race. It follows the `doc-store.pg.test.ts` pattern: a throwaway Postgres
   provided by the unit CI job, and a test that **fails** when the URL is unset, so a skipped run cannot
   read as a pass. A link with `maxRedemptions = 3`, and 10 distinct users claiming at once through
   `Promise.all` on separate connections. Assert exactly 3 grants, `redemptionCount === 3`, and 7
   refusals. Control: drop the `"redemptionCount" < "maxRedemptions"` clause, and the count should come
   back above 3. `@ai:` This needs the gift tables created in that throwaway database (a fixture
   migration), and a new environment variable in `lint.yml`'s unit job.
2. **Same user, double claim, concurrent.** One user, 5 parallel claims on an uncapped link. Assert 1
   redemption row and `redemptionCount === 1`.
3. **Revoked or expired, mid-flight.** Revoke between lookup and update (inject the revoke through a
   transaction hook). The claim fails and no `EntityAccess` row exists.
4. **No consume when already entitled.** A buyer claims a capped link, and `redemptionCount` stays 0.
5. **Scope bypass, REST.** For each new `/api/v1` route, a token without `ModelsWrite` gets 403 and no
   database write happens. A `ModelsWrite` token and a cookie session pass. Control: remove the
   `matchedScope` call, and the 403 test should fail on the status, naming 200.
6. **Scope, tRPC.** `giftLink.create` and `giftLink.claim` refuse an API key (`blockApiKeys`), and `list`
   refuses a token without `ModelsRead`.
7. **Ownership.** A non-owner cannot create, mint, list or revoke (403 or 404), and revoking someone
   else's link affects 0 rows and errors.
8. **Plaintext never stored.** After create, no column of the row contains the returned code.
9. **Purchase unchanged.** The existing `earlyAccessPurchase` tests still pass through the extracted
   `grantModelVersionAccess`, plus one new case: a gifted user's purchase call is refused before any
   charge.
10. **Refund unaffected.** The refund service, run over a version that has a gift grant, refunds nothing
    for that user and leaves the row in place.

## Rollout

Behind a Flipt flag (`model-gift-links`) on the tRPC, REST and Creator Studio surfaces until the proof
in the task holds on prod: a second account claims a link, an API claim works, and a revoke stops new
claims.
