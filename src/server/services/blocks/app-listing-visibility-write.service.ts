/**
 * App Store Listings — setting a listing's per-listing VISIBILITY LEVEL.
 *
 * 🔴 SEPARATE MODULE FROM THE GUARDED READER (`app-listing-visibility.service.ts`), and
 * the split is structural rather than stylistic. That module is imported by
 * `app-listing.service.ts`, which is the public `/apps` store read path; this one pulls
 * `dbWrite` and the role resolver. Putting the write beside the read would drag both into
 * the hot read path's module graph.
 *
 * ✅ BOTH PATHS LIVE HERE NOW: {@link setListingVisibilityAsOwner} and
 * {@link setListingVisibilityAsModerator}. They share {@link applyVisibility}, which is
 * where D1, the review ceiling, the shadow refusal and the compare-and-set live; what
 * differs is the gate (a resolved role vs `moderatorProcedure` at the router) and the audit
 * event, which only the moderator path writes.
 *
 * ⚠️ THIS PARAGRAPH SAID "THE OWNER PATH IS THE ONLY ONE HERE" UNTIL ROUND 2 OF THE AUDIT,
 * AND IT IS THE MOST-READ SITE IN THE FILE. The moderator path landed ~350 lines below while
 * this header still told a reader it had been deferred — and, worse, told them the
 * moderation-action CHECK widen was deliberately NOT needed, when the moderator path's
 * shipping depends on it (`20261004120000_app_listing_mod_action_set_visibility`). A round of
 * this ladder corrected four other sites making the same claim and did not sweep upward
 * within its own file. Recorded rather than quietly rewritten: a retraction is a tree-wide
 * sweep, and the site a reader meets FIRST is the one that matters most.
 *
 * 🔴 WHAT HAPPENS WITHOUT THAT WIDEN IS A CLEAN REFUSAL, NOT AN ORPHANED LEVEL CHANGE, AND
 * THIS PARAGRAPH ASSERTED THE OPPOSITE UNTIL ROUND 4 ("the first live use changes a level and
 * then fails with 23514"). That WAS the behaviour before round 1, when the level write and
 * its event were two separate round trips — and it is the sentence the `$transaction`
 * docblock inside {@link setListingVisibilityAsModerator} already contradicts in as many
 * words ("Now a rejected event rolls the level back with it"). Both halves of
 * {@link setListingVisibilityAsModerator} now run on ONE interactive transaction, so a 23514
 * on the event insert aborts that transaction and the `UPDATE` goes with it: every moderator
 * visibility change 500s and NOTHING is written — no level change, no audit row. It matters
 * which one you believe, because the false version inverts the remediation: a maintainer who
 * deployed without the DDL would plan a data reconciliation over `app_listings.visibility`
 * for orphaned level changes that cannot exist. The OWNER path writes no event and is
 * unaffected either way.
 *
 * ⚠️ AND IT IS NOT "THE ONE MANUAL DDL" EITHER, which this paragraph also used to claim. The
 * `visibility` COLUMN is manual-apply too (`20261001170000_app_listing_visibility`). The
 * distinction worth drawing is not how they are applied but whether their absence is
 * HANDLED: a missing column is a designed refusal (`readListingVisibility` → 42703 →
 * `assertVisibilityWritable` → VISIBILITY_UNAVAILABLE_MESSAGE), while a missing action CHECK
 * is an unhandled 23514 surfacing as a 500.
 *
 * ⚠️ THE CODE IS 42703, AND THIS SENTENCE SAID `P2022` UNTIL ROUND 5. `readListingVisibility`
 * reads EXCLUSIVELY through `$queryRaw`, and the raw path surfaces the Postgres
 * `undefined_column` 42703 — which is what the column's own migration, the sibling
 * `app-listing-source-repo.service.ts` and the `$transaction` docblock below all say.
 * `P2022` is the DELEGATE-path spelling, and no delegate can name this column at all (it is
 * `// @no-type`). Harmless only because `isMissingColumnError` matches BOTH codes (verified
 * at `app-listing-source-repo.service.ts`, which returns true for `P2022` and `42703`, on
 * `code` or `meta.code`); the hazard is someone narrowing that predicate while trusting this
 * line as the authority for the write path, dropping the 42703 arm and turning the designed
 * refusal into an unhandled 500 in exactly the un-migrated environment it exists for.
 *
 * 🔴 EACH IS ITS OWN EXPORTED FUNCTION — never an `asModerator` flag
 * on this one. A boolean that selects between "resolve the caller's role" and "trust the
 * caller" is an authorization decision the CALLER makes, and every call site then has to be
 * audited to see which it passed. Separate symbols make the gate a property of which one
 * you imported: this path cannot skip the role resolve, and a moderator path would have no
 * role resolve to be handed a wrong argument for.
 *
 * 🔴 THE STATUS GATE IS ENFORCED HERE, NOT INFERRED FROM THE ROLE RESOLVER.
 * `resolveListingAccess` applies NO status filter — its own header says so in as many
 * words, and a caller that needs a status must read it itself. So D1 ("levels apply to
 * non-suspended listings only") is a check in {@link applyVisibility} against
 * `VISIBILITY_ELIGIBLE_LISTING_STATUSES`, plus the backing block's own suspension.
 */

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { dbWrite } from '~/server/db/client';
import {
  assertVisibilityWritable,
  readListingVisibility,
} from '~/server/services/blocks/app-listing-visibility.service';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';
import type { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';
import {
  isVisibilityEligibleListingStatus,
  listingVisibilityRank,
  maxVisibilityForStatus,
  VISIBILITY_ELIGIBLE_LISTING_STATUSES,
} from '~/shared/utils/app-listing-visibility';

/** What a level change reports back. `changed: false` is a successful no-op, not a
 *  failure — the caller asked for a state the listing is already in. */
export type SetListingVisibilityResult = {
  appListingId: string;
  visibility: AppListingVisibility;
  changed: boolean;
};

/**
 * The refusal an INELIGIBLE listing status produces.
 *
 * ⚠️ AND THE SHADOW-REVISION REFUSAL, WHICH IS A SECOND PRODUCER AND NOT A STATUS PROBLEM
 * AT ALL — this docblock described only the status cause until round 4 of the audit. A
 * shadow is `status: 'draft'`, which IS level-eligible, so the row this message refuses may
 * be in a perfectly eligible state; what disqualifies it is `revisionOfId != null` (see the
 * refusal in {@link applyVisibility}). The message is deliberately SHARED rather than split:
 * the no-detail posture below applies to both, and a distinct shadow message would be a
 * second place to leak which id class a caller supplied.
 *
 * 🔴 IT DOES NOT NAME THE STATUS, AND THAT IS DELIBERATE on the moderator path as well as
 * the owner path. The owner already knows their listing is down; a moderator reads the
 * status from the row they are looking at. Naming it here would make this message the one
 * place in the feature that distinguishes "removed" from "rejected" to whoever can reach
 * the proc, and a refusal message is the easiest surface to forget when the audience of a
 * proc widens later.
 */
export const VISIBILITY_STATUS_INELIGIBLE_MESSAGE =
  'This listing is not in a state where its visibility can be changed.';

/** The refusal a SUSPENDED backing block produces. Same no-detail posture as above. */
export const VISIBILITY_BLOCK_SUSPENDED_MESSAGE =
  'This app is suspended, so its listing visibility cannot be changed.';

/** The refusal a caller with no role on the listing produces. */
export const VISIBILITY_NOT_OWNED_MESSAGE = 'You can only change your own listings.';

/**
 * The moderation-event `action` this module writes.
 *
 * 🔴 A NAMED CONSTANT, NOT AN INLINE LITERAL, AND THE LITERAL IS WHY THIS EXISTS. Shipped as
 * `action: 'set-visibility'` at the create site, it was in NO registry: absent from
 * {@link APP_LISTING_MODERATION_ACTIONS}, unclassified in the state-changing/neutral
 * partition, and absent from every action-CHECK migration. All three of this repo's gates
 * for that class fire on REGISTERING an action, so an unregistered one is invisible to all
 * of them and `pnpm typecheck` was clean. Prod rejected the insert with 23514. Deriving the
 * value from the taxonomy makes the tuple the single source and the agreement test the gate.
 */
export const SET_VISIBILITY_ACTION =
  'set-visibility' satisfies (typeof APP_LISTING_MODERATION_ACTIONS)[number];

/**
 * A client that can perform the visibility write — `dbWrite` or an interactive transaction.
 *
 * 🔴 PRISMA'S OWN `TransactionClient`, NOT A HAND-ROLLED STRUCTURAL TYPE, and the structural
 * one is why this comment exists. {@link VisibilityReadClient} can be structural because it
 * needs ONE loosely-typed method (`$queryRaw`); this client also needs `appListing.findUnique`,
 * whose generic signature carries the `select` inference. A hand-written
 * `findUnique: (args: unknown) => Promise<unknown>` type-checked at the declaration and then
 * collapsed every projected row to `{}` — six errors downstream, each one a real field the
 * code reads (`status`, `appBlock`, `slug`). `TransactionClient` is `Omit<PrismaClient, …>`,
 * so the full client satisfies it and an interactive tx client IS it.
 */
type VisibilityWriteClient = Prisma.TransactionClient;

/**
 * The refusal a level WIDER than the listing's review state allows produces.
 *
 * 🔴 THIS GUARD CLOSES A MODERATOR-REVIEW BYPASS. Without it an owner could set
 * `visibility='public'` on a `draft` — a listing whose name, description, external URL and
 * content rating no moderator has ever seen — and the anon-capable public catalog endpoints
 * would serve it. The level can only ever be as wide as the review state permits; see
 * `maxVisibilityForStatus`. Unlike the two D1 refusals this one NAMES the ceiling, because
 * the caller can act on it (submit for review, or pick a narrower level) — it is not a
 * statement about a moderation outcome.
 */
export const VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE =
  'This listing has not been approved yet, so it can only be made visible to moderators. Submit it for review to widen its audience.';

/**
 * The core: gate on D1 and the review ceiling, then write.
 *
 * 🔴 THE WRITE IS A COMPARE-AND-SET, NOT A BARE `update`. It re-asserts the eligible
 * status set in the `where` clause, so a concurrent delist landing between the read above
 * and this write cannot be overtaken — `updateMany` matching zero rows is the signal, and
 * it is turned into the same refusal the pre-read produces rather than reported as
 * success. This is the shape `delistListing` uses for every status transition in
 * `offsite-moderation.service.ts`, and the reason is identical: a read-then-write on a row
 * a moderator may be acting on at the same moment is a race, and the race's losing side
 * must not be silent.
 *
 * 🔴 `changed: false` IS DISTINGUISHED FROM `count === 0`. A level that is already the
 * requested one is an idempotent success (the `setReviewExclude` precedent); zero matched
 * rows after a status re-check is a REFUSAL. Collapsing the two would report success for a
 * listing that was taken down a millisecond ago.
 */
async function applyVisibility(
  args: {
    appListingId: string;
    visibility: AppListingVisibility;
  },
  /**
   * The write client. `dbWrite` for the owner path; an INTERACTIVE TRANSACTION client for
   * the moderator path, so the level write and its audit event commit or roll back together.
   *
   * 🔴 THE MODERATOR PATH MUST PASS A TX, AND THE REASON IS MEASURED. With two separate
   * round trips the level write commits first; if the event insert then fails, the listing's
   * discoverability has changed with NO audit row — and the retry short-circuits
   * `changed: false` and returns 200, reporting success over a still-unrecorded act. That is
   * exactly what happened: `set-visibility` was unregistered, so prod rejected the insert
   * with 23514 after the level had already changed. Every sibling mod proc in
   * `offsite-moderation.service.ts` wraps mutation + event in one `$transaction` for this
   * reason, and that file's summary states it as an invariant.
   */
  db: VisibilityWriteClient
): Promise<SetListingVisibilityResult & { slug: string; before: AppListingVisibility | null }> {
  const { appListingId, visibility } = args;

  // 🔴 THE PRIMARY, NOT THE REPLICA. A freshly-delisted or freshly-relisted row read
  // through a replication-lag window would be gated on a stale status — in both
  // directions. Same argument `resolvePrivateRunAccess` makes for threading its pool.
  //
  // ⚠️ THIS SELECT DOES NOT CARRY THE LEVEL, AND THIS COMMENT CLAIMED IT DID UNTIL ROUND 5
  // ("`columnAvailable` carries the manual-apply answer out of the SAME read, so the level
  // needs no separate lookup"). There is no such field here and there cannot be: the
  // `visibility` column is `// @no-type`, so it is absent from the generated client and this
  // delegate cannot name it. The level and its availability come from the SEPARATE raw read
  // below (`readListingVisibility`) — that lookup is required, not redundant, and a reader
  // who believed this comment would delete it.
  const listing = await db.appListing.findUnique({
    where: { id: appListingId },
    select: {
      id: true,
      slug: true,
      status: true,
      // 🔴 THE SHADOW DISCRIMINATOR. See the refusal below.
      revisionOfId: true,
      // The backing block's own suspension. Null for an offsite listing, which has no
      // block and therefore no block-level suspension to respect.
      appBlock: { select: { status: true } },
    },
  });
  if (!listing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Listing not found' });

  /**
   * 🔴 A SHADOW REVISION IS REFUSED HERE, AT THE ONE SITE THAT COVERS BOTH PATHS.
   *
   * A shadow is created `status: 'draft'`, and `draft` IS level-eligible with a ceiling of
   * `moderators` — so every gate below passes, the CAS flips the shadow row, and the caller
   * is told `changed: true` for a write NOTHING reads: the store filters `revisionOfId: null`
   * and the approve path's scalar copy does not include `visibility`. On the moderator path
   * it is worse than a no-op, because the audit row is then filed under the shadow's id with
   * its synthetic `rev-<ulid>` slug, so the event that exists to tell an OWNER a moderator
   * changed their discoverability is invisible in the owner's own history.
   *
   * 🔴 WHY HERE AND NOT AT EACH CALLER. An earlier revision fixed only the owner path, by
   * keying it on `access.seatListingId`. That left the moderator path — the audited one —
   * still taking the caller-supplied id, i.e. the same defect on the path where it matters
   * more. One refusal in the shared core cannot be half-applied like that.
   *
   * ⚠️ WHICH PATH CAN ACTUALLY ARRIVE HERE WITH A SHADOW: ONLY THE MODERATOR ONE, and only
   * via a hand-crafted call. {@link setListingVisibilityAsModerator} passes the caller's id
   * verbatim; {@link setListingVisibilityAsOwner} passes `access.seatListingId`, which
   * `resolveListingAccess` computes as `revisionOfId ?? id` — so the owner path can only ever
   * ask about a row whose `revisionOfId` is null and is STRUCTURALLY immune, not merely
   * guarded. Nor can the moderation queue produce one: `listAllListingsForModeration` filters
   * `revisionOfId: null`. The guard stays because it pins the PLACEMENT — moving it into the
   * moderator function would be invisible to every behavioural test — and because
   * `moderatorProcedure` is the only thing between a mod-authenticated caller and this id.
   *
   * ⚠️ "The sibling mod procs also take the raw id" is NOT a defence: `delistListing`'s CAS
   * is `status IN ('approved','removed')`, which a `draft` shadow can never match, so the
   * siblings are refused by construction. This proc's eligible set INCLUDES `draft`, which is
   * what makes it the one that would succeed.
   */
  if (listing.revisionOfId != null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_STATUS_INELIGIBLE_MESSAGE });
  }

  // D1, half one: the listing's own lifecycle. `removed` and `rejected` are refused.
  if (!isVisibilityEligibleListingStatus(listing.status)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_STATUS_INELIGIBLE_MESSAGE });
  }
  // D1, half two: a suspended BLOCK. A delist flips both the listing status and the
  // backing block's, so this is normally redundant — but it is the half that holds if a
  // block is ever suspended through a path that leaves the listing row alone, and "levels
  // apply to non-suspended listings only" is a claim about the app, not only the row.
  if (listing.appBlock?.status === 'suspended') {
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_BLOCK_SUSPENDED_MESSAGE });
  }

  // 🔴 THE REVIEW CEILING. A level wider than this status permits is refused — see
  // VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE. Applies to MODERATORS too: the ceiling is a
  // property of what has been reviewed, not of who is asking, and a moderator wanting a
  // draft public approves it rather than relabelling it.
  const ceiling = maxVisibilityForStatus(listing.status);
  if (ceiling === null || listingVisibilityRank(visibility) > listingVisibilityRank(ceiling)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE,
    });
  }

  // The manual-apply column. Refuses rather than silently dropping the write — the caller
  // picked this level and expects to see it again.
  //
  // 🔴 READ THROUGH THE RAW READER, because the column is NOT on the Prisma model — it is
  // `// @no-type` in `schema.full.prisma` and stripped from the generated client, so the
  // select above cannot name it. That is deliberate: it is what makes all 17 unguarded
  // `appListing` WRITES elsewhere in the tree immune to the missing column instead of
  // 500ing on it. See the reader module's header.
  const before = await readListingVisibility(appListingId, db);
  assertVisibilityWritable(before.available);
  if (before.visibility === visibility) {
    return {
      appListingId,
      visibility,
      changed: false,
      slug: listing.slug,
      before: before.visibility,
    };
  }

  // 🔴 THE COMPARE-AND-SET, IN RAW SQL FOR THE SAME REASON — `data: { visibility }` is not
  // expressible through a delegate that has no such field. It re-asserts BOTH halves of D1
  // inside the write so a concurrent takedown wins the race: the eligible statuses (derived,
  // never a second literal, or a grown allowlist would surface as a phantom race) and the
  // backing block's suspension, which is the half the status re-check cannot catch.
  // `$executeRaw` returns the affected row count — that is the CAS signal.
  const flipped = await db.$executeRaw(
    Prisma.sql`
      UPDATE "app_listings"
         SET "visibility" = ${visibility}
       WHERE "id" = ${appListingId}
         AND "status" IN (${Prisma.join([...VISIBILITY_ELIGIBLE_LISTING_STATUSES])})
         AND (
           "app_block_id" IS NULL
           OR EXISTS (
             SELECT 1 FROM "app_blocks" ab
              WHERE ab."id" = "app_listings"."app_block_id"
                AND ab."status" <> 'suspended'
           )
         )
    `
  );
  if (flipped === 0) {
    // 🔴 A DELETION IS NOT AN INELIGIBLE STATUS. Mapping every zero-row outcome to the
    // status refusal reported a vanished listing as a lifecycle problem — a refusal naming
    // the wrong cause, in the one branch whose whole job is to be legible.
    const still = await db.appListing.findUnique({
      where: { id: appListingId },
      select: { id: true },
    });
    if (!still) throw new TRPCError({ code: 'NOT_FOUND', message: 'Listing not found' });
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_STATUS_INELIGIBLE_MESSAGE });
  }

  // 🔴 THE CACHE BUST MOVED OUT OF HERE, TO THE CALLERS, AND IT IS NOT A TIDY-UP. This
  // function can now run inside an interactive transaction, and busting the catalog cache
  // before that transaction COMMITS would advertise a change that may still roll back — the
  // cache would then serve the new audience for a write that never landed. Each caller busts
  // after its own write is durable; see {@link bustCatalogAfterVisibilityWrite}.
  return { appListingId, visibility, changed: true, slug: listing.slug, before: before.visibility };
}

/**
 * Bust the store catalog cache after a visibility write has COMMITTED.
 *
 * Fire-and-forget by this module's convention: a cache-bus outage must never fail a mutation
 * that already committed. AWAITED AND CAUGHT, matching all 21 other call sites — a bare
 * `void` would be the only unhandled one, and `bustCacheTag` can reject on a cache-bus
 * fault, which with nothing awaiting it has nowhere to go but `unhandledRejection`. A stale
 * grid for at most the TTL beats a mutation that reports failure after having committed.
 */
async function bustCatalogAfterVisibilityWrite(): Promise<void> {
  const { bustAppListingCatalogCache } = await import(
    '~/server/services/blocks/app-listing.service'
  );
  await bustAppListingCatalogCache().catch(() => undefined);
}

/**
 * OWNER path — set the level on a listing the caller holds a role on.
 *
 * Admits the OWNER **or an accepted collaborator (editor)**, because that is what
 * `resolveListingAccess` returns a non-null role for and what every other owner-side
 * listing edit in this feature already admits (`updateListing` → `loadOwnedEditableListing`
 * takes the same `role !== null` test). Narrowing to owner-only here would make this the
 * one authored field an accepted editor cannot touch, which is a separate decision from
 * the four this change implements.
 *
 * 🔴 NO MODERATOR BYPASS ON THIS PATH, deliberately — `updateListing`'s own resolver has
 * none either, and the divergence between it and `app-listing-assets.service`'s
 * mod-bypassing loader is recorded in the access call-site ledger.
 *
 * ✅ MODERATORS NOW HAVE A PATH, AND IT IS {@link setListingVisibilityAsModerator} IN THIS
 * FILE — below. This paragraph has been wrong in BOTH directions: it once pointed at a
 * moderator proc that did not exist, was corrected to "no path at all", and that correction
 * then outlived the proc landing. The claim that matters is unchanged and still true:
 * letting a moderator in through THIS function would be an unaudited write on someone
 * else's listing, which is why the moderator path is a separate export with a required
 * reason and an audited event in the same transaction — not a bypass here.
 */
export async function setListingVisibilityAsOwner(args: {
  appListingId: string;
  visibility: AppListingVisibility;
  userId: number;
}): Promise<SetListingVisibilityResult> {
  const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');
  // `dbWrite` so a seat accepted moments ago is visible — the same reason the status read
  // below uses the primary.
  // 🔴 NO CAST. `dbWrite` assigns to this parameter cleanly (`app-listing-assets.service`
  // passes it the same way), and the double cast this line used to carry would have
  // defeated the only compile-time check on a SECURITY argument — the one that says this
  // is the role resolver's db handle and not some other client.
  const access = await resolveListingAccess(args.appListingId, args.userId, dbWrite);
  // A missing row and a caller with no role produce the SAME refusal. Distinguishing them
  // would turn this proc into an existence oracle over listing ids.
  if (!access || access.role == null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: VISIBILITY_NOT_OWNED_MESSAGE });
  }
  // 🔴 `access.seatListingId`, NOT `args.appListingId` — THE PARENT. The caller may have
  // arrived with a SHADOW revision id: `resolveListingAccess` resolves the role THROUGH the
  // parent (`seatListingId = revisionOfId ?? id`) and admits it, so without this the write
  // lands on the shadow row. Nothing reads a shadow's level — the store filters
  // `revisionOfId: null` and the approve path's scalar copy does not include `visibility` —
  // so the proc returned `changed: true` for a write with no effect, and the owner's panel
  // still showed the parent's old level. The READ path documents this id class as reachable
  // and keys on the parent for the same reason; the write did not, which made the two
  // disagree about which row the feature is about.
  const result = await applyVisibility(
    { appListingId: access.seatListingId, visibility: args.visibility },
    // 🔴 EXPLICIT, because the parameter no longer has a default. It used to default to
    // `dbWrite`, which meant a future caller inside a transaction could forget the argument
    // and silently escape it — and nothing could see that: `local-rules/no-io-in-transaction`
    // is a call-NAME denylist and contains none of these functions. Required costs one token
    // here and makes that mistake a compile error. `readListingVisibility` already does this.
    dbWrite
  );
  if (result.changed) await bustCatalogAfterVisibilityWrite();
  return {
    appListingId: result.appListingId,
    visibility: result.visibility,
    changed: result.changed,
  };
}

/**
 * MODERATOR path — set the level on ANY listing, with a mandatory audited reason (D2).
 *
 * 🔴 IT DOES NOT WIDEN THE OWNER PATH, AND THAT SEPARATION IS THE WHOLE DESIGN. The
 * previous revision of this module's header recorded that letting a moderator through
 * `setListingVisibilityAsOwner` "would be an unaudited moderator write on someone else's
 * listing", and closed the gap by deferring a dedicated proc rather than relaxing the
 * resolver. This is that proc. The owner path is untouched and still has no mod bypass, so
 * the two audiences cannot be confused at a call site.
 *
 * ⚠️ AND THIS DOCBLOCK CLOSED WITH THE RETRACTED CLAIM UNTIL ROUND 6 — "a moderator write is
 * structurally incapable of happening without an event row" — which the `$transaction`
 * docblock below quotes verbatim and calls "false as written". The retraction was applied to
 * the module header and did not reach this site, which is the one a reader of THIS function
 * meets first. It survived both previous sweeps BY CONSTRUCTION: the line contains no
 * `23514`, and none of the eight claim-shape phrasings those sweeps enumerated appears in
 * it.
 *
 * 🔴 IT MATTERS EVEN THOUGH THE CONCLUSION IS TRUE TODAY, BECAUSE IT IS TRUE FOR THE WRONG
 * REASON. The sentence derives the no-orphan invariant from PATH SEPARATION — "the owner
 * path has no mod bypass, therefore every moderator write carries an event". Path separation
 * does not buy that and never did: the shipped revision had the same separation and still
 * committed a level change with no audit row. What actually provides the invariant is the
 * SINGLE INTERACTIVE TRANSACTION below, and nothing else. So a maintainer who removes the
 * `$transaction` and checks whether the audit invariant still holds reads this paragraph,
 * finds a derivation their change does not touch, and ships the two-round-trip shape back
 * in. The true statement, with its real support named: a moderator write cannot commit a
 * level change without its event row BECAUSE both run on one transaction and a rejected
 * event aborts it.
 *
 * 🔴 THE REVIEW CEILING STILL BINDS (D7). {@link applyVisibility} enforces it for every
 * caller — a moderator who wants a draft public APPROVES it rather than relabelling it,
 * because the ceiling is a property of what has been reviewed and not of who is asking.
 * Same for D1: a `removed`/`rejected` listing refuses a level for a moderator too.
 * Moderator-ness buys the right to act on someone else's listing, nothing more.
 *
 * 🔴 THE EVENT IS WRITTEN AFTER THE LEVEL, IN THE SAME TRANSACTION, AND ONLY IF THE LEVEL
 * LANDS. ⚠️ This sentence used to read "BEFORE the level", which is the reverse of its own
 * next clause and of the code — and acting on the bolded half would reintroduce the mutant
 * this module's suite specifically kills ("apply first, record second"). The order is
 * read-then-apply-then-record: `applyVisibility` throws on every refusal (D1, the
 * ceiling, an unapplied migration, a lost CAS race), so no event row is created for an act
 * that did not happen. The alternative — event first — would log moderator actions that
 * were refused, which is worse than not logging in a surface whose job is to be believed.
 *
 * 🔴 `changed: false` STILL RECORDS NOTHING. Setting the level to what it already is is an
 * idempotent success; an event row there would fill an owner's visible history with
 * no-ops, and the history is the only place the owner learns a moderator touched their
 * listing's discoverability.
 *
 * 🔴 WHY A NEW EVENT ACTION CANNOT BREAK THE OWNER'S REPUBLISH, checked rather than
 * assumed. `republishOwnListing` gates on the LAST moderation event being
 * `owner-unpublish`, so a new action kind that could land last on a `removed` listing
 * would silently convert an owner-reversible unpublish into a mod-removed dead end. This
 * one cannot: `applyVisibility` refuses every status outside
 * `VISIBILITY_ELIGIBLE_LISTING_STATUSES`, and `removed` is not in it — so a
 * `set-visibility` row can never be written to a removed listing, and therefore can never
 * be the newest event on one. (`normalizeLastModerationAction` would also collapse it to
 * `other`, which is the refusing side — the status gate is what makes it unreachable.)
 */
export async function setListingVisibilityAsModerator(args: {
  appListingId: string;
  visibility: AppListingVisibility;
  reason: string;
  moderatorUserId: number;
}): Promise<SetListingVisibilityResult> {
  /**
   * 🔴 ONE INTERACTIVE TRANSACTION FOR THE LEVEL AND ITS EVENT, and this was two round trips
   * in the revision that shipped. The module header then claimed a moderator write was
   * "structurally incapable of happening without an event row", which was false as written:
   * any failure of the `create` left a COMMITTED level change with no audit row. It was not
   * hypothetical — `set-visibility` was unregistered in the action CHECK, so prod rejected
   * the insert with 23514 *after* the level had changed, and the retry then short-circuited
   * `changed: false` and returned 200 over a still-unrecorded act. Now a rejected event rolls
   * the level back with it, which is what every sibling mod proc in
   * `offsite-moderation.service.ts` does and what that file's summary states as an invariant.
   *
   * ⚠️ WHAT THIS DOES **NOT** BUY: snapshot isolation. These transactions run at READ
   * COMMITTED (nothing sets `isolationLevel`), so the pre-state read and the CAS are still
   * two snapshots and a concurrent owner write between them is possible — the `before` in the
   * audit row is "the value this transaction last observed", not "the value the CAS
   * overwrote". The CAS itself is still safe (it re-asserts eligibility in its own `WHERE`).
   * An earlier revision of this paragraph asserted the stronger property; it was false, and
   * the fix is to state the weaker true one rather than to reach for `isolationLevel`.
   */
  const result = await dbWrite.$transaction(async (tx) => {
    /**
     * 🔴 THE PRE-STATE COMES OUT OF `applyVisibility`, NOT A SECOND READ, AND THE SECOND READ
     * WAS A REAL DEFECT RATHER THAN A REDUNDANCY.
     *
     * It ran FIRST inside the transaction and called `readListingVisibility`, which SWALLOWS
     * a missing-column 42703 and returns `VISIBILITY_UNAVAILABLE` — correct for a read, fatal
     * here: the Postgres transaction is already ABORTED, so the very next statement raises
     * `25P02 current transaction is aborted`, which nothing catches. The designed refusal
     * (`assertVisibilityWritable` → VISIBILITY_UNAVAILABLE_MESSAGE) was never reached and the
     * moderator got an opaque 500 instead. Measured by audit at two layers — raw psql and
     * this repo's own generated Prisma client — each against a no-transaction control that
     * returns the row. Prisma does not savepoint interactive-transaction statements.
     *
     * ⚠️ LATENT, NOT LIVE, and the distinction is measured rather than assumed: the column is
     * present on both the prod primary and the dev clone (re-checked 2026-10-04 with a
     * positive control). It would fire in a fresh or un-migrated environment, which is
     * exactly where a manual-apply column spends its early life.
     *
     * 🔴 AND IT ALSO FIXES A FALSE INVARIANT. The old comment claimed the `before` snapshot
     * and the write "cannot be separated by a concurrent change". Prisma's interactive
     * transactions run at READ COMMITTED here (no `isolationLevel` is set anywhere), so each
     * statement takes a FRESH snapshot: the outer read, the inner read and the CAS were three
     * of them, and an owner committing a level change between the first two would have the
     * audit row record a pre-state that was never the value overwritten. One read inside the
     * same function as the CAS is one fewer snapshot, and the honest claim is below.
     */
    const applied = await applyVisibility(
      { appListingId: args.appListingId, visibility: args.visibility },
      tx
    );

    // An idempotent no-op records nothing: an event row there would fill the owner's visible
    // history with no-ops, and that history is the only place they learn a moderator touched
    // their listing's discoverability.
    if (!applied.changed) return applied;

    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        // 🔴 `applied.appListingId`, NOT `args.appListingId` — ONE SOURCE FOR THE WHOLE ROW.
        // The two are equal by construction on this path (the moderator call passes
        // `args.appListingId` straight into `applyVisibility`, which echoes it back), so this
        // is not a live defect — it is the exact SHAPE of one that was: the previous revision
        // keyed the owner write on `args.appListingId` while the role resolve had already
        // redirected to the parent, and the write landed on the wrong row. An event whose id
        // comes from the request while its `slug`, `before` and `visibility` come from the
        // write cannot stay coherent if `applyVisibility` ever redirects for a caller, and a
        // reader has to prove the equality before trusting the row. Taking every field from
        // `applied` removes the question.
        appListingId: applied.appListingId,
        // 🔴 THE SLUG COMES OUT OF THE WRITE'S OWN READ, not a second query, and it is never
        // `''`. This column is the denormalised "the event stays self-describing after the
        // listing is purged" copy — an empty string defeats the one case it exists for, and
        // the previous revision fell back to exactly that.
        slug: applied.slug,
        action: SET_VISIBILITY_ACTION,
        actorUserId: args.moderatorUserId,
        reason: args.reason,
        // 🔴 THE LEVELS, NOT THE STATUS. This act changes neither the status nor anything
        // else, so recording `status` would describe a transition that did not happen. And
        // `null` is a REAL pre-state meaning "no choice expressed" — not the `private` level.
        before: { visibility: applied.before },
        // `applied.visibility`, for the same single-source reason as `appListingId` above —
        // `applyVisibility` echoes the requested level back, so this is the same value, and
        // a row whose every field comes from the write needs no equality argument.
        after: { visibility: applied.visibility },
      },
    });
    return applied;
  });

  // After COMMIT, never inside — see `applyVisibility`'s note.
  if (result.changed) await bustCatalogAfterVisibilityWrite();
  return {
    appListingId: result.appListingId,
    visibility: result.visibility,
    changed: result.changed,
  };
}
