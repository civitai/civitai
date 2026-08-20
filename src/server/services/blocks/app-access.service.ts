import { TRPCError } from '@trpc/server';

import { dbRead } from '~/server/db/client';
import { listingCoverUrl, listingIconUrl } from '~/server/services/blocks/listing-media-url';
import type { ListingProblem } from '~/server/services/blocks/listing-problems';
import { computeListingProblems } from '~/server/services/blocks/listing-problems';
import type {
  AppRole,
  ListingCapability,
  ListingKind,
} from '~/shared/constants/app-capabilities.constants';
import {
  AUTHORABLE_LISTING_STATUSES,
  CAPABILITIES_BY_KIND,
  capabilitiesForKind,
  isAuthorableListingStatus,
  listingKindSupports,
} from '~/shared/constants/app-capabilities.constants';

/**
 * App Listing COLLABORATORS — THE consolidated app-access predicate.
 *
 * ## Why this module exists
 *
 * Before it, "does this caller control this app?" was open-coded at ~14 production
 * sites in four different shapes:
 *
 *   - `block.app?.userId !== ctx.user!.id`            (blocks.router, ×4, hard throw)
 *   - `listing.userId !== user.id && !user.isModerator` (app-listing-assets, mod bypass)
 *   - `listing.userId !== userId`                      (offsite-listing, NO mod bypass)
 *   - `where: { app: { userId } }`                     (analytics/nav, silent empty)
 *
 * Consolidating them surfaced real disagreements between those sites — they are
 * catalogued in `app-access.call-site-ledger.test.ts` (which also FAILS when the set
 * of owner-gated sites grows or shrinks) rather than silently normalised here.
 *
 * ## The model
 *
 * 🔴 A SEAT IS KEYED TO THE **APP LISTING**, not to the AppBlock. `AppBlock` is the
 * ON-SITE runtime record; an OFF-SITE listing (external-link / OAuth-connect) has no
 * AppBlock at all, so a block-keyed seat was structurally unable to exist for one of
 * the store's two kinds. `AppListing` is the store-facing parent of BOTH.
 *
 * Ownership is a SEPARATE question from the seat key, and that distinction is
 * load-bearing: for an ON-SITE listing ownership is canonically `OauthClient.userId`
 * (reached as `AppBlock.app.userId`) and `AppListing.userId` is a denormalized copy;
 * for an OFF-SITE listing `AppListing.userId` IS the owner (there is no OauthClient in
 * the ownership chain — a connect client is a linked credential, not the owner).
 *
 *   role 'owner'  → the listing owner. Everything an editor can do, PLUS managing
 *                   collaborators and initiating an ownership transfer.
 *   role 'editor' → an ACCEPTED `AppCollaborator`. What that unlocks is DERIVED from
 *                   the listing's KIND — see {@link capabilitiesForKind}. It is never
 *                   configured per seat, so there is no new surface to get wrong.
 *   role null     → no access. This INCLUDES a `pending` and a `rejected` seat:
 *                   🔴 an unaccepted invite must confer ZERO capability, or anyone
 *                   could attach a stranger's identity to their app by inviting them.
 *
 * Moderator status is deliberately NOT folded in here. It is an orthogonal axis and
 * the existing sites disagree about it (see the ledger); each call site keeps its own
 * `user.isModerator` handling exactly as before, so this consolidation cannot silently
 * grant or revoke a mod bypass anywhere.
 *
 * ## 🔴 SHADOW REVISIONS: the resolve-to-parent hop is THE single path
 *
 * `applyApprovedRevision` DELETES the shadow on approve and the seat FK CASCADEs, so a
 * seat that landed on a shadow (`revisionOfId != null`) would vanish silently the
 * moment a moderator approved the revision. A SQL CHECK cannot express "parent only"
 * (a row-level CHECK cannot see another row), so the invariant is held in code, from
 * both ends:
 *   - {@link resolveListingAccess} resolves a shadow to its PARENT before any seat
 *     lookup — the only place a seat is ever read by listing id; and
 *   - `inviteCollaborator` REFUSES to create a seat on a shadow.
 * `app-collaborator.shadow-hazard.test.ts` pins both directions.
 *
 * ## INERT WHILE THE COLLABORATOR TABLES ARE ABSENT — AND THE MIGRATION IS SPLIT IN TWO
 *   SO THAT "ABSENT" IS THE ONLY STATE THE DEPLOY WINDOW CAN BE IN
 *
 * 🔴 THE SAFETY NET IS KEYED TO **42P01 ONLY**, so it is a claim about a MISSING TABLE
 * and NOT about a mismatched one. {@link safeCollaboratorQuery} degrades to "no
 * collaborators" when the table does not exist (P2021 / 42P01); {@link
 * isMissingTableError} deliberately REFUSES a column error (42703), because a
 * half-applied schema must surface rather than become a permanent silent zero. A 42703
 * therefore PROPAGATES — through `getListingDetail` → `loadDisplayedCollaboratorChips`,
 * which has no try/catch above it — and 500s the public listing-detail read.
 *
 * 🔴 SO THE RE-KEY IS APPLIED AS TWO MIGRATIONS, AND THE ORDER IS LOAD-BEARING:
 *
 *   1. `20260811160000_rekey_app_collaborators_step_a_drop_block_keyed` — apply BEFORE
 *      the deploy. Drops the block-keyed tables. The code that is live at that moment
 *      then reads a table that is GONE → 42P01 → swallowed → owner-only. No error.
 *   2. the code deploy — this code, still with no tables → 42P01 → swallowed. Inert.
 *   3. `20260811170000_rekey_app_collaborators_step_b_create_listing_keyed` — apply
 *      AFTER the deploy. Creates the listing-keyed tables; the feature turns on.
 *
 * Every intermediate state is a MISSING-TABLE state, which is the state this module's
 * fallback actually covers. There is no instant at which any deployed code reads a
 * table whose KEY COLUMN it disagrees about, which is the 42703 case — the one the
 * single DROP+CREATE migration created, in BOTH orderings.
 *
 * The WRITE paths do not swallow the missing table at all (an invite that silently did
 * nothing would be worse than an error).
 */

/**
 * 🔴 THE CAPABILITY MODEL IS DEFINED IN `~/shared/constants/app-capabilities.constants`
 * AND RE-EXPORTED HERE, so every pre-existing `from '~/server/services/blocks/
 * app-access.service'` import site is untouched while CLIENT code can reach the same
 * table without pulling this module's `~/server/db/client` import into the browser
 * bundle. There is still exactly one definition — see that file's header for why the
 * move was structural rather than cosmetic.
 */
export type { AppRole, ListingKind, ListingCapability };
export { CAPABILITIES_BY_KIND, capabilitiesForKind, listingKindSupports };
export { AUTHORABLE_LISTING_STATUSES, isAuthorableListingStatus };

export type AppAccess = {
  appBlockId: string;
  /**
   * The `AppListing` that backs this block and therefore holds its seats. `null` when
   * the block has no listing yet (a first-version app pending approval), in which case
   * only the owner has access — there is nothing to seat anyone on.
   */
  appListingId: string | null;
  /** The canonical owner (`OauthClient.userId`). */
  ownerUserId: number;
  /** `null` = the caller has NO access (stranger, or a pending/rejected invite). */
  role: AppRole | null;
};

export type ListingAccess = {
  /** The listing id that was ASKED about. May be a shadow revision. */
  appListingId: string;
  /**
   * The PARENT listing that actually holds the seats. Equals `appListingId` for a
   * top-level listing; for a shadow it is `revisionOfId`. 🔴 This is the ONLY id a
   * seat is ever read or written under.
   */
  seatListingId: string;
  /**
   * The SEAT (parent) listing's slug.
   *
   * 🔴 CARRIED BECAUSE IT IS THE ONLY JOIN LEFT WHEN A BLOCK FK IS NULL.
   * `app_block_publish_requests.app_block_id` is NULL until approve, so an app's first
   * pending/rejected/withdrawn version cannot be found by block id at all — `slug` is what
   * carries identity across that lifecycle. Taken from the PARENT for the same reason
   * `kind` and `appBlockId` are: a shadow revision has a synthetic `rev-<ulid>` slug.
   * Read by {@link blockRequestWhereForListing}.
   */
  slug: string;
  /**
   * 🔴 THE CANONICAL OWNER, resolved KIND-AWARE — **not** `AppListing.userId`.
   *
   * For an ON-SITE listing ownership lives on `OauthClient.userId`, reached as
   * `AppListing.appBlock.app.userId`; `AppListing.userId` is a DENORMALIZED COPY that
   * this feature's own code can leave stale — see {@link resolveListingAccess} for the
   * mechanism that actually does it (a SHADOW REVISION freezes the column at clone
   * time and no ownership write ever revisits it). Reading the copy would hand the
   * roster — including `displayed:false` seats, `invitedBy` and the timestamps — to
   * whoever the stale row names, while refusing the REAL owner `NOT_OWNER` on their own
   * app. For an OFF-SITE listing there is no OauthClient in the ownership chain, so the
   * column IS the owner — which is why the resolution BRANCHES on `kind` rather than
   * merely falling back to the column when no block happens to be present.
   *
   * 🔴 THE BRANCH ON `kind` IS THE WHOLE POINT, and it used to be missing (issue #3844,
   * fixed here). The implementation was BLOCK-FIRST (`appBlock.app.userId ?? listing
   * .userId`) with no branch at all, which READ as kind-aware only because an ordinary
   * off-site listing has no block, so the fallback was the only branch reached. On an
   * OFF-SITE listing that DOES carry one — `mapAppBlockToListing` mints exactly that shape
   * from an `AppBlock` with an `externalUrl` — the block decided, while BOTH off-site
   * ownership writers move only the column:
   *   - `app-ownership-transfer.service::acceptTransfer` — its `OauthClient` step is
   *     `if (isOnsite)`-guarded, so the offsite path writes `AppListing.userId` alone; and
   *   - `offsite-moderation.service::claimListing` — the mod IMPERSONATION REMEDY
   *     (report → delist → claim → ban), which refuses a non-offsite listing outright.
   * So the resolver kept naming the OLD owner: the ex-owner — or the impersonator the
   * claim exists to dispossess — retained edit access while the rightful owner was
   * refused. Both directions are pinned in `app-access.kind-aware-owner.test.ts`.
   *
   * 🔴 AND FOR AN OFF-SITE LISTING THE CANONICAL COLUMN IS THE **PARENT'S**, never a
   * shadow's own. `beginListingRevision` clones with `userId: parent.userId` and nothing
   * revisits the clone, so a shadow that outlives an off-site ownership move carries the
   * OLD owner frozen. Reading the shadow's copy re-opened the same inversion on the one
   * shape that needs no unmintable block — see {@link resolveCanonicalListingOwner}.
   *
   * The same resolution is written in `app-collaborator.service::toSeatListing` and in
   * `app-ownership-transfer.service::loadOwnedListing`, the two WRITE-side seat/transfer
   * loaders — both now delegate to {@link resolveCanonicalListingOwner} rather than
   * re-spelling it; every other consumer delegates to THIS function.
   *
   * 🔴 WHAT THE LEDGER ACTUALLY PINS, stated exactly, because two earlier versions of
   * this paragraph overstated it. The ledger enumerates the POPULATION of gate sites, and
   * it separately RECORDS a class of gate that reads the denormalized column directly.
   * That class is now empty for every collaborator-reachable gate. But its
   * `DENORM_OWNER_RE` assertion is a **naming-convention lint, not a structural guard**:
   * it is anchored on the receiver name (`*listing` / `*shadow` / `<x>.appListing`), so
   * it catches a reintroduction written in this feature's idiom — in either operand
   * order, with optional chaining, with `!=` — and is BLIND to the same gate written
   * against a hoisted local, a destructure, or any other variable name. Its own KNOWN
   * EVASIONS test pins that limit as a measured fact. It also fails if the three recorded
   * holdouts are fixed without updating the record. The claim that no gate anywhere reads
   * the column is NOT what it holds; the behaviour is held instead by
   * `app-access.denormalized-owner-drift.test.ts` (spelling-blind by construction) and
   * the transfer/seat suites.
   */
  ownerUserId: number;
  /** The PARENT's kind — what the caller may do is derived from it, never from a seat. */
  kind: ListingKind;
  /**
   * The PARENT's backing AppBlock, or `null` for an off-site listing. The two
   * BLOCK-ONLY capabilities (earnings, submit-version/git) key on this and must refuse
   * cleanly — not error confusingly — when it is null.
   */
  appBlockId: string | null;
  role: AppRole | null;
};

/** The one status that confers capability. Nothing else does. */
export const ACCEPTED = 'accepted' as const;

/**
 * 🔴 THE CANONICAL OWNER OF AN APP LISTING — the ONE place the kind branch is written.
 *
 * Ownership is not one column. It depends on the listing's KIND, and the two kinds have
 * genuinely different ownership chains:
 *
 *   - `onsite`  → the owner is `OauthClient.userId`, reached as `AppBlock.app.userId`.
 *                 `AppListing.userId` is a DENORMALIZED COPY there and is stale-able (a
 *                 shadow revision freezes it at clone time). The copy is still the
 *                 fallback, and it is the only owner signal left when a block carries a
 *                 dangling `app_id` — an app nobody owns is worse than a stale name.
 *   - `offsite` → there is no `OauthClient` in the chain at all (a connect client is a
 *                 linked CREDENTIAL, not an owner), so `AppListing.userId` IS the owner —
 *                 UNCONDITIONALLY, ignoring any backing `AppBlock`.
 *
 * 🔴 THE `offsite` BRANCH IS NOT DEAD CODE, AND ITS ABSENCE WAS ISSUE #3844.
 * `mapAppBlockToListing` mints `kind:'offsite'` WITH a non-null `appBlockId` for any
 * `AppBlock` that carries an `externalUrl` (reachable through `publish-request.service`'s
 * approve path and the mod proc `backfillAppListings`). On that shape a block-first
 * resolution lets the BLOCK decide — while both off-site ownership writers
 * (`acceptTransfer`'s offsite path, and `claimListing`, the impersonation remedy) move
 * only `AppListing.userId`. The result is a two-sided authorization inversion: the
 * previous owner keeps edit access and the rightful owner is refused.
 *
 * 🔴 AN UNKNOWN KIND FALLS THROUGH TO THE COLUMN, deliberately, matching
 * {@link capabilitiesForKind}'s fail-closed fallback to the narrower (offsite) row. A
 * kind this code does not recognise must not be handed the block's owner.
 *
 * 🔴 `listingUserId` MUST BE THE PARENT LISTING'S COLUMN when the row asked about is a
 * shadow revision. `beginListingRevision` clones the parent with `userId: parent.userId`
 * and `appBlockId: null`, and no ownership write ever revisits the clone
 * (`claimListing` and `acceptTransfer` both write `where: { id: <the parent> }`), so a
 * shadow that outlives an OFF-SITE ownership move names the OLD owner forever. For
 * `onsite` the block covers that; for `offsite` the column IS the answer, so passing the
 * shadow's own copy would reproduce #3844 on a shape that needs no unmintable block at
 * all. {@link resolveListingAccess} resolves the column from the PARENT for exactly this
 * reason — the same row it already takes `kind` and `appBlockId` from.
 *
 * Pure: no IO, no db. Callers that already hold the row (the write-side seat and transfer
 * loaders) call it directly rather than paying a second read.
 */
export function resolveCanonicalListingOwner(args: {
  /** The PARENT listing's kind. */
  kind: string;
  /** `AppBlock.app.userId`, or null/undefined when there is no block (or no app). */
  blockOwnerUserId: number | null | undefined;
  /** The PARENT listing's `userId` column. */
  listingUserId: number;
}): number {
  if (args.kind === 'onsite') return args.blockOwnerUserId ?? args.listingUserId;
  return args.listingUserId;
}

/**
 * {@link resolveCanonicalListingOwner} expressed as a Prisma `OR`, for the two SET reads
 * that enumerate "listings this user owns" without resolving them one at a time.
 *
 * 🔴 IT MUST STAY EQUIVALENT TO THE FUNCTION, branch for branch. A set that disagreed
 * with the per-listing resolver would hand a user an entry point that then 403s — or,
 * worse, hide a listing they do own. The three branches are the function's two arms:
 *
 *   1. onsite + a block   → the block's `OauthClient.userId`;
 *   2. onsite + no block  → the column (the `?? ` fallback);
 *   3. NOT onsite         → the column, unconditionally — the #3844 branch. An offsite
 *                           listing that HAS a block is matched HERE and by nothing else,
 *                           which is exactly the shape a block-first predicate got wrong.
 *
 * Branch 2 is spelled `appBlock: { is: null }` rather than a third
 * `{ appBlock: { app: { is: null } } }` because `AppBlock.appId` is a REQUIRED FK with
 * `onDelete: Cascade` (schema.full.prisma) — a block with a dangling `app_id` cannot
 * exist in the database, so the fallback is reachable only when there is no block at all.
 * (`resolveAppAccess`'s `!block?.app` guard defends a narrow SELECT / a test fixture, not
 * a DB state.) A `{ app: { is: null } }` branch would additionally be a Prisma
 * *validation error* on a required to-one.
 *
 * 🔴 CALLERS MUST STILL ADD `revisionOfId: null` themselves — a shadow revision is an
 * internal draft with no authoring surface, and this helper deliberately answers only the
 * ownership question so the two concerns stay separable.
 */
export function canonicalOwnerWhereBranches(userId: number): Array<Record<string, unknown>> {
  return [
    { kind: 'onsite', appBlock: { app: { userId } } },
    { kind: 'onsite', appBlock: { is: null }, userId },
    { kind: { not: 'onsite' }, userId },
  ];
}

// ---------------------------------------------------------------------------
// CAPABILITIES — derived from the listing KIND. No per-seat configuration.
//
// 🔴 THE TABLE ITSELF NOW LIVES IN `~/shared/constants/app-capabilities.constants`
// and is re-exported at the top of this file. An editor gets their declared role ∩
// what the listing’s KIND supports; there is no third input, and deliberately no
// stored per-seat capability set — a config surface here would be a new thing to get
// wrong on every invite, and would drift from what the kind can physically do.
// ---------------------------------------------------------------------------

/**
 * Postgres/Prisma "the table isn't there yet" signals.
 *
 * P2021 is Prisma's typed code; 42P01 is the raw PG SQLSTATE that surfaces through
 * `$queryRaw` and through some driver paths where Prisma has not classified the error.
 * Matching BOTH matters: a check on P2021 alone let a raw-path failure through in
 * local testing.
 *
 * 🔴 THE MESSAGE BRANCH IS DELIBERATELY NARROWER THAN "does not exist". That substring
 * also appears in `column "displayed" does not exist` and in
 * `column "x" of relation "y" does not exist` (SQLSTATE 42703) — which is EXACTLY what a
 * HALF-APPLIED manual migration produces, and this repo applies migrations by hand
 * (datapacket-talos DB rule #8). Swallowing a column error would degrade a genuinely
 * broken schema to a permanent silent "no collaborators" instead of surfacing it. So the
 * message branch requires the missing object to be named as a RELATION or TABLE, and
 * refuses anything that mentions a column at all. `app-access.service.test.ts` pins both
 * directions, including the "broadened back to `does not exist` / `not found`" mutants.
 */
function isMissingTableError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'P2021' || code === '42P01') return true;
  // Prisma wraps the driver error; the SQLSTATE is only in the message on some paths.
  const message = (err as { message?: unknown })?.message;
  if (typeof message !== 'string') return false;
  // A column/attribute error is a HALF-APPLIED migration, not an absent table.
  if (/\bcolumns?\b/i.test(message)) return false;
  return /\b42P01\b/.test(message) || /\b(?:relation|table)\s+\S+\s+does not exist/i.test(message);
}

/**
 * Run a collaborator-table READ, degrading to `fallback` when the manual-apply
 * migration has not landed yet.
 *
 * 🔴 Deliberately narrow: it swallows ONLY the missing-table error. A genuine query
 * bug, a connection failure or a constraint error still propagates — otherwise this
 * would be a permanent silent-zero generator, which is exactly the failure mode the
 * repo keeps paying for elsewhere.
 */
export async function safeCollaboratorQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingTableError(err)) return fallback;
    throw err;
  }
}

/**
 * The Prisma pool a resolve should read through.
 *
 * Defaults to the replica. Callers pass `dbWrite` when the rows in question may have
 * been INSERTed milliseconds ago — see {@link resolveListingAccess}.
 */
export type AccessDb = typeof dbRead;

/**
 * Is `userId` an ACCEPTED collaborator on `appListingId`?
 *
 * 🔴 `appListingId` MUST already be a PARENT listing id. Every caller reaches this
 * through {@link resolveListingAccess}'s shadow→parent hop or through an explicit
 * block→listing hop; nothing looks a seat up under a shadow id, because no seat can
 * exist there (see the module header).
 *
 * The `status: ACCEPTED` filter is the consent gate and is NOT optional — see the
 * module header. Callers must never widen this to "a row exists".
 */
async function hasAcceptedSeat(
  appListingId: string,
  userId: number,
  db: AccessDb = dbRead
): Promise<boolean> {
  const row = await safeCollaboratorQuery(
    () =>
      db.appCollaborator.findFirst({
        where: { appListingId, userId, status: ACCEPTED },
        select: { userId: true },
      }),
    null
  );
  return !!row;
}

/**
 * Resolve the caller's role on an App Block.
 *
 * Returns `null` when the AppBlock does not exist, or when it has no resolvable owner
 * (a dangling `app_id`) — an app nobody owns is an app nobody may edit, which is the
 * fail-closed reading.
 *
 * 🔴 THE SEAT LIVES ON THE BLOCK'S LISTING, so this hops `AppBlock → AppListing`
 * (1:1 via the UNIQUE `app_block_id`). A block with no listing yet resolves
 * `appListingId: null` and therefore only ever `owner`/`null` — correct, because there
 * is nothing to seat anyone on. The hop costs one query and is paid ONLY on the
 * non-owner path.
 */
export async function resolveAppAccess(
  appBlockId: string,
  userId: number | null | undefined
): Promise<AppAccess | null> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { id: true, app: { select: { userId: true } }, appListing: { select: { id: true } } },
  });
  if (!block?.app) return null;
  const ownerUserId = block.app.userId;
  const appListingId = block.appListing?.id ?? null;
  const base = { appBlockId: block.id, appListingId, ownerUserId };
  if (typeof userId !== 'number') return { ...base, role: null };
  if (ownerUserId === userId) return { ...base, role: 'owner' };
  if (!appListingId) return { ...base, role: null };
  const editor = await hasAcceptedSeat(appListingId, userId);
  return { ...base, role: editor ? 'editor' : null };
}

/**
 * Resolve the caller's role on an App LISTING. 🔴 THE primary resolver — every
 * listing-shaped gate in the feature goes through here.
 *
 * 🔴 SHADOW-AWARE, and that hop is a SAFETY invariant rather than an ergonomic. A
 * shadow revision's seats do not exist (nothing may create one — see the module
 * header), so resolving a shadow MUST walk to its parent or every editor would lose
 * access the moment their first media edit minted the shadow. That is one hop only:
 * `beginListingRevision` refuses to open a revision of a revision.
 *
 * `kind` and `appBlockId` are taken from the PARENT for the same reason — a shadow
 * carries `appBlockId: null` by construction (the column is `@unique` and stays on the
 * parent), so reading them off the shadow would make every editor's in-flight revision
 * look like an off-site listing and silently strip the block-only capabilities.
 *
 * 🔴 `db` IS LOAD-BEARING, NOT AN ERGONOMIC. The asset gates in
 * `app-listing-assets.service.ts` already carry a `dbWrite` pool override so the OWNER's
 * FIRST edit does not 404 off a lagging replica (the shadow was INSERTed milliseconds
 * ago). An EDITOR never takes the owner short-circuit at all — a shadow's `userId` is
 * the PARENT OWNER's — so the collaborator fallback is the ONE path that always reaches
 * this function, and reading the replica here would turn that same lag into a 403 on an
 * editor's first media edit. The override must therefore be threaded all the way down to
 * the seat lookup, not just to the listing lookup.
 */
export async function resolveListingAccess(
  appListingId: string,
  userId: number | null | undefined,
  db: AccessDb = dbRead
): Promise<ListingAccess | null> {
  const listing = await db.appListing.findUnique({
    where: { id: appListingId },
    select: {
      id: true,
      userId: true,
      slug: true,
      kind: true,
      appBlockId: true,
      revisionOfId: true,
      // 🔴 The CANONICAL onsite owner. See {@link ListingAccess.ownerUserId}: the
      // listing's own `userId` is a denormalized copy for onsite and must not be the
      // authority here.
      appBlock: { select: { app: { select: { userId: true } } } },
      revisionOf: {
        select: {
          id: true,
          // The PUBLIC slug. A shadow's own slug is the synthetic `rev-<ulid>`, which
          // matches no publish request, so the parent's is the one that can join.
          slug: true,
          // 🔴 THE PARENT'S OWNER COLUMN, and it is NOT redundant with the shadow's own.
          // The shadow froze a copy of it at clone time; for an OFF-SITE listing that
          // column IS the owner, so reading the frozen one keeps naming whoever owned the
          // listing when the revision was opened. See {@link resolveCanonicalListingOwner}.
          userId: true,
          kind: true,
          appBlockId: true,
          appBlock: { select: { app: { select: { userId: true } } } },
        },
      },
    },
  });
  if (!listing) return null;
  // A shadow's seat lives on its PARENT (see the note above), and so do the kind, the
  // backing block and the canonical owner. `revisionOfId` is the authoritative "am I a
  // shadow" signal; the `revisionOf` relation may be absent from a narrow fixture, so
  // fall back to the id — never to the shadow's own (always-null) appBlockId.
  const parent = listing.revisionOfId ? listing.revisionOf : null;
  const seatListingId = listing.revisionOfId ?? listing.id;
  const kind = ((listing.revisionOfId ? parent?.kind : listing.kind) ??
    listing.kind) as ListingKind;
  const appBlockId = (listing.revisionOfId ? parent?.appBlockId : listing.appBlockId) ?? null;
  // 🔴 KIND-AWARE, via the ONE helper — see {@link resolveCanonicalListingOwner} for why
  // a block-first resolution inverted every gate on an OFFSITE-listing-that-has-a-block
  // (issue #3844). The same helper backs `toSeatListing` and the transfer service's
  // `loadOwnedListing`, so the read side and the write side cannot disagree about who the
  // owner is.
  //
  // 🔴 EVERY INPUT COMES FROM THE **PARENT** ROW — the column included, not just the
  // block. A shadow's `userId` is a frozen clone of the parent's, and for `offsite` that
  // column IS the owner, so taking the shadow's copy would hand an ex-owner (or an
  // impersonator a moderator just dispossessed via `claimListing`) their old listing's
  // in-flight revision. `?? listing.userId` keeps a narrow fixture that omits the
  // `revisionOf` relation working, exactly as `kind` and `appBlockId` above do.
  const columnUserId = (listing.revisionOfId ? parent?.userId : listing.userId) ?? listing.userId;
  const blockOwnerUserId = listing.revisionOfId
    ? parent?.appBlock?.app?.userId
    : listing.appBlock?.app?.userId;
  const ownerUserId = resolveCanonicalListingOwner({
    kind,
    blockOwnerUserId,
    listingUserId: columnUserId,
  });
  const base = {
    appListingId: listing.id,
    seatListingId,
    ownerUserId,
    kind,
    appBlockId,
    // 🔴 THE PARENT'S slug, on the same `?? listing.slug` fallback as `kind`/`appBlockId`
    // above — a shadow carries the synthetic `rev-<ulid>`, which joins to nothing.
    slug: ((listing.revisionOfId ? parent?.slug : listing.slug) ?? listing.slug) as string,
  };
  if (typeof userId !== 'number') return { ...base, role: null };
  if (ownerUserId === userId) return { ...base, role: 'owner' };
  const editor = await hasAcceptedSeat(seatListingId, userId, db);
  return { ...base, role: editor ? 'editor' : null };
}

/**
 * THE app-authoring gate for `blocks.router`'s four owner-scoped procs
 * (`getMyAppRepo`, `getMyAppManifest`, `updateManifest`, `getMyForgejoCloneInfo`).
 *
 * Replaces four byte-identical open-codings of `block.app?.userId !== ctx.user!.id`.
 * Lives HERE rather than in the router so it has exactly one home AND is directly
 * unit-testable — importing the 7.9k-line router into a test to exercise one guard
 * would drag in a module graph that has nothing to do with access.
 *
 * 🔴 NO MODERATOR BYPASS — deliberately preserved. All four gates were strict before
 * collaborators: a moderator who does not personally own the app was refused, unlike
 * the App Listing asset gates which do bypass. That divergence is PRE-EXISTING and is
 * recorded in `app-access.call-site-ledger.test.ts` rather than silently changed here.
 *
 * 🔴 These four are BLOCK-ONLY procs by construction (a repo, a manifest, a clone URL),
 * so they are unreachable for an off-site listing — there is no AppBlock to name. The
 * `submitVersion` capability's `false` cell for offsite is therefore enforced by the
 * shape of the surface, not by a runtime branch here.
 *
 * The message is `'Not the app owner'` VERBATIM — it is what callers see today, and the
 * mutation checks assert this exact string so a mutant that breaks this guard dies to
 * THIS error rather than to a neighbouring one.
 */
export async function assertAppEditAccess(args: {
  appBlockId: string;
  /**
   * The owner the CALLER already loaded (`block.app?.userId`).
   *
   * 🔴 Passed in rather than re-read. All four call sites have just selected the
   * AppBlock with its `app: { select: { userId } }`, so re-resolving it here would be a
   * second identical round trip on every one of those procs — and it would make the
   * gate's answer depend on a row read at a DIFFERENT instant than the one the proc
   * goes on to use. `undefined`/`null` (a missing app or a dangling `app_id`) is
   * refused: an app with no resolvable owner is an app nobody may edit.
   */
  ownerUserId: number | null | undefined;
  userId: number;
}): Promise<void> {
  const deny = () => {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Not the app owner' });
  };
  if (typeof args.ownerUserId !== 'number') deny();
  if (args.ownerUserId === args.userId) return;
  // Not the owner — the only remaining route in is an ACCEPTED seat on the block's
  // LISTING. Costs two queries, and ONLY on the non-owner path, so the common case is
  // unchanged. A block with no listing has no seats and falls straight through to deny.
  const listing = await dbRead.appListing.findUnique({
    where: { appBlockId: args.appBlockId },
    select: { id: true },
  });
  const seated = listing ? await hasAcceptedSeat(listing.id, args.userId) : false;
  if (!seated) deny();
}

export type AccessibleAppBlocks = {
  /** AppBlock ids the caller OWNS (via `OauthClient.userId`). */
  ownedIds: string[];
  /** AppBlock ids the caller holds an ACCEPTED editor seat on. Disjoint from owned. */
  editorIds: string[];
  /** The union, de-duplicated. The scope every app-scoped read must filter by. */
  allIds: string[];
};

/**
 * Enumerate every AppBlock the caller may act on, split by how.
 *
 * 🔴 THIS IS THE ONLY SAFE INPUT TO AN EARNINGS OR ANALYTICS QUERY FOR A NON-OWNER.
 * The pre-existing earnings reads (`getRevenueForOwner`,
 * `getRecentAttributionsForOwner`, `getMyApps`' lifetime groupBy) key on
 * `BlockBuzzAttribution.appOwnerUserId` — a USER-WIDE filter. "Widening" one of those
 * for an editor by passing the OWNER's id would hand the editor the owner's ENTIRE
 * PORTFOLIO, including apps they were never invited to. Every collaborator-reachable
 * money/analytics read must instead filter `appBlockId IN allIds`. See
 * `app-collaborator-earnings.service.ts`, and the regression test
 * `app-collaborator-earnings.service.test.ts`, which fixtures an owner with 2 apps and
 * an editor on 1 and asserts the second never appears.
 *
 * 🔴 SEATS ARE LISTING-KEYED, SO OFF-SITE SEATS DROP OUT HERE — AND THE DISCRIMINATOR IS
 * `kind`, NEVER `appBlockId IS NULL`. Those two are not the same predicate:
 * `mapAppBlockToListing` mints `kind:'offsite'` WITH a non-null `appBlockId` whenever the
 * source AppBlock carries an `externalUrl` (reachable through the mod proc
 * `backfillAppListings`), and `schema.full.prisma` says in as many words to discriminate
 * on `kind` and never on `appBlockId` nullness. Filtering on nullness alone would let
 * such a row's seat contribute a REAL block id to this set — and this set is the input to
 * `getMyAppsEarnings`, which has no kind gate of its own, so a seat-only holder would be
 * handed real `lifetimeShareCents` on a listing whose kind declares `earnings: false`.
 * The count of such rows is 0 in production today (measured 2026-08-11: offsite 5 rows,
 * 0 with a block), so this gate is PREVENTION — but it guards a money read, which is not
 * where a latent hazard is worth leaving open.
 *
 * The `earnings: false` cell of {@link CAPABILITIES_BY_KIND} is the declared form of the
 * same rule; this is it expressed as a query predicate.
 *
 * 🔴 IT IS NOT ONLY THE MONEY PATH, AND THE JUSTIFICATION ABOVE DOES NOT COVER THE OTHER
 * CONSUMER ON ITS OWN. `app-analytics.service::getOwnedAppBlocks` reads the SAME set, and
 * `CAPABILITIES_BY_KIND.offsite.analytics` is `true` — so read naively, `kind: 'onsite'`
 * narrows a capability the table grants. It does not, for two independent reasons, and
 * BOTH are needed:
 *   1. This set is a set of APP BLOCK ids, and every downstream analytics aggregate is
 *      `appBlockId IN thatSet` over block-scoped series (`AppBlockView`, install counts,
 *      the manifest). An OFFSITE listing's analytics surface is `AppListingMetric` —
 *      connect/visit counters on the LISTING — which this set does not address at all.
 *      An ordinary offsite listing has no block, so it contributes nothing here whatever
 *      the kind clause says; the `analytics: true` cell is honoured on a different read.
 *   2. The only shape the clause actually removes is the odd one: an OFFSITE listing that
 *      HAS a backing block (`mapAppBlockToListing` + `externalUrl`). Its block-scoped
 *      series belong to a block whose listing declares itself off-site; feeding it here
 *      would report app-block analytics for a listing the store presents as external.
 *      0 rows of that shape in production (same measurement as above).
 * DECISION: the predicate is left as-is and this comment is widened to cover both
 * consumers, rather than splitting the resolver into a money set and an analytics set.
 * Splitting would add a second decayable set and change a live read to fix a case with
 * no rows, no user-visible difference (see 1), and no capability actually withheld.
 */
export async function resolveAccessibleAppBlockIds(userId: number): Promise<AccessibleAppBlocks> {
  const [owned, seats] = await Promise.all([
    dbRead.appBlock.findMany({ where: { app: { userId } }, select: { id: true } }),
    safeCollaboratorQuery(
      () =>
        dbRead.appCollaborator.findMany({
          where: { userId, status: ACCEPTED },
          select: { appListingId: true },
        }),
      [] as { appListingId: string }[]
    ),
  ]);
  const ownedIds = owned.map((b: { id: string }) => b.id);
  const ownedSet = new Set(ownedIds);

  // Seated LISTINGS → their backing blocks. BOTH predicates, and they are not
  // redundant (see the note above): `kind: 'onsite'` is the authoritative capability
  // discriminator, `appBlockId: { not: null }` is the physical one. An OFFSITE row that
  // carries a block is exactly the case where they disagree, and it must drop out.
  const seatListingIds = seats.map((s: { appListingId: string }) => s.appListingId);
  const seatBlocks = seatListingIds.length
    ? await dbRead.appListing.findMany({
        where: { id: { in: seatListingIds }, kind: 'onsite', appBlockId: { not: null } },
        select: { appBlockId: true },
      })
    : [];

  // Disjoint by construction: an owner who somehow also holds a seat on their own app
  // counts once, as an owner. (The invite path refuses to seat the owner, so this is
  // defence against a hand-written row, not an expected state.)
  const editorIds = [
    ...new Set(
      seatBlocks
        .map((l: { appBlockId: string | null }) => l.appBlockId)
        .filter((id: string | null): id is string => !!id && !ownedSet.has(id))
    ),
  ];
  return { ownedIds, editorIds, allIds: [...ownedIds, ...editorIds] };
}

/**
 * The `AppListing` id backing an AppBlock, or `null` when the block has no listing yet
 * (a first-version app still pending approval).
 *
 * Exists for the LEGACY block-keyed routes' SSR hop to the canonical listing-keyed
 * authoring URL. 🔴 It is deliberately NOT access-gated and must NOT be treated as one:
 * it maps one opaque id to another and nothing else, and every destination resolves the
 * caller's role for itself. Gating it here would mean an SSR redirect had to load a
 * session it does not otherwise need, and would turn "no access" into "no such page",
 * which is a worse answer than the destination's own 403.
 */
export async function listingIdForAppBlock(appBlockId: string): Promise<string | null> {
  const row = await dbRead.appListing.findUnique({
    where: { appBlockId },
    select: { id: true },
  });
  return row?.id ?? null;
}

export type AccessibleListings = {
  /** `AppListing` ids the caller OWNS, resolved canonically (see below). */
  ownedIds: string[];
  /** `AppListing` ids the caller holds an ACCEPTED editor seat on. Disjoint from owned. */
  editorIds: string[];
  /** The union, de-duplicated, owned first. */
  allIds: string[];
};

/**
 * Enumerate every APP LISTING the caller may act on, split by how — the LISTING-keyed
 * sibling of {@link resolveAccessibleAppBlockIds}, and the read the schema's
 * `app_collaborators_user_status_idx` comment already names.
 *
 * 🔴 WHY IT HAD TO EXIST AS A SEPARATE FUNCTION. `resolveAccessibleAppBlockIds` returns
 * APP BLOCK ids, so an OFF-SITE listing — which has no AppBlock — is structurally
 * unrepresentable in its result. Every "the apps I can work on" surface needs the
 * listing set, because the store's two kinds are both listings and only one of them is
 * ever a block.
 *
 * 🔴 IT IS ALSO NOT `listMySubmissions`. That read is scoped to a publish request's
 * `submittedByUserId`, which answers "what did I submit", not "what do I own" and not
 * "what do I hold a seat on": a listing acquired by ownership TRANSFER or by a moderator
 * `claimListing` carries someone else's `submittedByUserId` forever, so it is invisible
 * there to its actual owner. Do not substitute one for the other.
 *
 * 🔴 OWNERSHIP IS RESOLVED THE SAME WAY {@link resolveListingAccess} RESOLVES IT —
 * KIND-AWARE — expressed as a query predicate by {@link canonicalOwnerWhereBranches},
 * which is the ONE place that decomposition is written (this read and
 * {@link resolveAppsNavAccess} share it, so the tab and the page it opens cannot
 * disagree). Read that helper for what each branch is for.
 *
 * The set and the per-listing resolver MUST agree: a set that disagreed would hand a user
 * an entry point that then 403s, or hide a listing they do own. Before issue #3844 both
 * were block-first, so they agreed on being WRONG on an offsite-listing-that-has-a-block;
 * they now agree on being right, and `app-access.kind-aware-owner.test.ts` asserts the
 * agreement on that exact shape rather than trusting that two edits stayed in step.
 *
 * 🔴 SHADOWS ARE EXCLUDED (`revisionOfId: null`). A shadow revision is an internal draft
 * that holds no seats (see the module header) and has no authoring surface of its own;
 * surfacing one as "an app you can edit" would offer a route every editing proc refuses
 * (`INVALID_REVISION`).
 *
 * 🔴 NO KIND FILTER, and the asymmetry with `resolveAccessibleAppBlockIds` is deliberate.
 * That function filters `kind: 'onsite'` because its result feeds a BLOCK-scoped MONEY
 * read (`getMyAppsEarnings`) where an offsite row's block id would be attributed real
 * cents. This set feeds authoring/navigation surfaces whose capabilities are derived
 * per-listing from {@link capabilitiesForKind} at the point of use, so narrowing here
 * would drop exactly the off-site listings the re-key exists to serve.
 */
export async function resolveAccessibleListingIds(userId: number): Promise<AccessibleListings> {
  const [owned, seats] = await Promise.all([
    dbRead.appListing.findMany({
      where: { revisionOfId: null, OR: canonicalOwnerWhereBranches(userId) },
      select: { id: true },
    }),
    safeCollaboratorQuery(
      () =>
        dbRead.appCollaborator.findMany({
          where: { userId, status: ACCEPTED },
          select: { appListingId: true },
        }),
      [] as { appListingId: string }[]
    ),
  ]);
  const ownedIds = owned.map((l: { id: string }) => l.id);
  const ownedSet = new Set(ownedIds);
  // Disjoint by construction, and de-duplicated: the invite path refuses to seat the
  // owner, so an overlap means a hand-written row — it counts once, as ownership.
  const editorIds = [
    ...new Set(
      seats
        .map((s: { appListingId: string }) => s.appListingId)
        .filter((id: string) => !ownedSet.has(id))
    ),
  ];
  return { ownedIds, editorIds, allIds: [...ownedIds, ...editorIds] };
}

/**
 * One row of "the apps I can work on" — a listing the caller owns or holds an ACCEPTED
 * seat on, carrying everything a nav/entry-point surface needs and nothing it does not.
 */
export type MyAppListing = {
  appListingId: string;
  slug: string;
  name: string;
  /** `draft|pending|approved|rejected|removed`. */
  status: string;
  kind: ListingKind;
  /** `null` for an off-site listing — legitimately absent, not missing. */
  appBlockId: string | null;
  role: AppRole;
  /**
   * 🔴 DERIVED FROM THE KIND, at the same seam every gate derives it — never stored, and
   * never widened per row. A surface that renders an action for a `false` capability is
   * rendering a guaranteed 403.
   */
  capabilities: Readonly<Record<ListingCapability, boolean>>;
  /**
   * The listing's ICON as a CDN URL, or `null` when it has none.
   *
   * 🔴 CARRIED BECAUSE THE CONSUMER IS THE ROW ITSELF, which is the bar the
   * `connectClientId` note below sets. `/apps/mine` is now the one author-facing table for
   * every listing, on-site and off-site, and a table of apps that cannot show the apps is
   * not the surface. It is a MEDIA URL derived from `Image.url` — the same string the
   * PUBLIC store card already serves for an approved listing — so it discloses nothing to
   * a seated editor that the store does not, and for a `draft` it discloses that editor's
   * own collaborators' work, which the seat is exactly consent for.
   *
   * `null` is a REAL STATE, not an error: measured on production 2026-08-19, all 11
   * `removed` listings have `cover_id IS NULL`, so the placeholder path is the main render
   * path for the Inactive table rather than an edge case.
   */
  iconUrl: string | null;
  /**
   * The listing's COVER as a CDN URL, or `null`.
   *
   * 🔴 NO SCREENSHOT FALLBACK HERE, unlike the public store card — see
   * {@link listingCoverUrl}. A missing cover is the fact its author needs to see.
   */
  coverUrl: string | null;
  /**
   * Last write to the listing row. Drives the table's default "recently updated first"
   * order, computed client-side so the server's `serialId` keyset (which is what makes
   * `take: limit` deterministic) is untouched.
   */
  updatedAt: Date;
  /**
   * The listing-completeness ADVISORY — missing icon / cover / screenshots / description
   * / tagline / category, from {@link computeListingProblems}.
   *
   * 🔴 CARRIED BECAUSE `/apps/mine` IS NOW ITS ONLY POSSIBLE HOME. The advisory rendered
   * on the two `/apps/my-submissions` tables; that page merged into this one, so without
   * this field the warning has no surface at all and an author simply stops being told
   * their listing is incomplete. It is also what makes {@link listingCoverUrl}'s "no
   * screenshot fallback, the author must see the gap" argument true rather than merely
   * asserted — that rationale cites this warning by name.
   *
   * Empty array = nothing to flag. Never `undefined`.
   */
  problems: ListingProblem[];
};

/**
 * The SINGLE-LISTING authoring read's row — {@link MyAppListing} plus the one extra fact
 * the authoring page needs. Returned by {@link getAppListingAuthoringContext}.
 *
 * 🔴 A SEPARATE TYPE RATHER THAN A WIDER `MyAppListing`, and the distinction is a
 * disclosure boundary rather than tidiness. `connectClientId` was first added to
 * `MyAppListing` itself, which silently widened `listMine` — a LIST read over every
 * listing the caller can touch — for no consumer at all. Both reads are reachable by an
 * accepted EDITOR, not just the owner, so that would have handed a seated collaborator the
 * client_id of every listing they hold a seat on, including `draft` ones the public read
 * does not expose yet. Harmless in itself (it is the public client_id, never the secret)
 * and bought nothing, which is precisely why it should not be paid.
 *
 * So the field is carried ONLY on the read that has a consumer. If a list surface ever
 * needs it, widen `MyAppListing` then — with the consumer, and a test that pins it. (That
 * is precisely what happened for `iconUrl`/`coverUrl`/`updatedAt`: the merged `/apps/mine`
 * table is the consumer, and `app-access.my-app-listings-media.test.ts` pins them.)
 *
 * 🔴 AND THE SAME RULE RUNS THE OTHER WAY, which is why this is an `Omit` and not a bare
 * `&`. The authoring page reads `kind`/`appBlockId`/`role`/`capabilities`/`name` and
 * nothing else; it has no consumer for the three LIST-only fields, and inheriting them
 * would oblige `getAppListingAuthoringContext` to join `Image` twice per page load to
 * populate columns nobody renders. Narrowing here keeps each read carrying exactly what
 * its own surface uses.
 */
export type AppListingAuthoringContext = Omit<
  MyAppListing,
  'iconUrl' | 'coverUrl' | 'updatedAt' | 'problems'
> & {
  /**
   * The listing's linked OAuth `client_id`, or `null`. PUBLIC, not a secret — the same
   * column the public listing-detail read already exposes (`ListingDetailKindData`).
   *
   * 🔴 CARRIED SO THE AUTHORING SURFACE CAN REACH THE TRANSFER VERDICT UP FRONT. A
   * connect-linked off-site listing can never be transferred
   * ({@link refusesTransferForConnectClient}), and without this field the Collaborators
   * tab could not know that until the mutation came back refused — so it rendered an
   * enabled recipient picker and the owner only found out after choosing someone.
   * A field is not a guard, though: the branch that reads it lives in
   * `AppCollaboratorsPanelView`, and the server gate is unchanged and still authoritative.
   */
  connectClientId: string | null;
};

/** Hydrate {@link resolveAccessibleListingIds} into rows, newest listing first. */
async function hydrateMyAppListings(
  ids: AccessibleListings,
  limit: number
): Promise<MyAppListing[]> {
  if (ids.allIds.length === 0) return [];
  const rows = await dbRead.appListing.findMany({
    where: { id: { in: ids.allIds } },
    // 🔴 NO `connectClientId` HERE, deliberately — see {@link AppListingAuthoringContext}.
    // This is a LIST read reachable by an accepted editor; only the single-listing
    // authoring read has a consumer for that column.
    //
    // 🔴 `icon`/`cover` ARE NESTED RELATION SELECTS ON THE SAME `findMany`, not a second
    // query. `app_listings.icon_id`/`cover_id` are integer FKs to `Image`, so the URL is
    // one join away; doing it here keeps this read at ONE hydrate query, which
    // `app-access.accessible-listings.test.ts` pins by call count.
    //
    // 🔴 `iconId`/`coverId`/`description`/`tagline`/`category` + the FILTERED screenshot
    // COUNT are the exact inputs of {@link computeListingProblems} — the listing-
    // completeness advisory. They are selected HERE rather than fetched by a second
    // surface because `/apps/mine` is now the ONLY place that advisory can render: it used
    // to hang off the two `/apps/my-submissions` tables, and those lost their importer
    // when that page merged into this one. Deriving "the cover is missing" from
    // `coverUrl == null` would cover one of six problems and silently drop the other five.
    //
    // The screenshot count is `_count` with the SAME `imageId: { not: null }` filter the
    // authoritative asset gate uses (`buildAssetStatus`) — a screenshot whose Image was
    // deleted has nothing to display, so counting it would make `no-screenshots` a
    // false negative.
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      kind: true,
      appBlockId: true,
      updatedAt: true,
      icon: { select: { url: true } },
      cover: { select: { url: true } },
      iconId: true,
      coverId: true,
      description: true,
      tagline: true,
      category: true,
      _count: { select: { screenshots: { where: { imageId: { not: null } } } } },
    },
    orderBy: { serialId: 'desc' },
    take: limit,
  });
  const ownedSet = new Set(ids.ownedIds);
  return rows.map(
    (r: {
      id: string;
      slug: string;
      name: string;
      status: string;
      kind: string;
      appBlockId: string | null;
      updatedAt?: Date | null;
      icon?: { url: string | null } | null;
      cover?: { url: string | null } | null;
      iconId?: number | null;
      coverId?: number | null;
      description?: string | null;
      tagline?: string | null;
      category?: string | null;
      _count?: { screenshots: number } | null;
    }) => {
      const kind = r.kind as ListingKind;
      return {
        appListingId: r.id,
        slug: r.slug,
        name: r.name,
        status: r.status,
        kind,
        appBlockId: r.appBlockId,
        role: (ownedSet.has(r.id) ? 'owner' : 'editor') as AppRole,
        capabilities: capabilitiesForKind(kind),
        iconUrl: listingIconUrl(r.icon),
        // 🔴 `null`, NOT a screenshot — see {@link listingCoverUrl}. The author must be
        // able to see that their own cover is missing. That is only true as long as the
        // advisory below actually renders somewhere; `problems` is what makes it true.
        coverUrl: listingCoverUrl(r.cover, null),
        // A narrow test fake that ignores `select` yields `undefined` here; the epoch
        // keeps the row sortable rather than producing an `Invalid Date` that poisons
        // every comparison it takes part in.
        updatedAt: r.updatedAt ?? new Date(0),
        // 🔴 NO `assetScans` PASSED, so no scan-state problems are computed here. That
        // input needs each asset's `ingestion` state, which is a per-listing fan-out this
        // LIST read deliberately does not do — the same reasoning as the omitted
        // `connectClientId`. The scan problems remain on the single-listing surfaces.
        problems: computeListingProblems({
          iconId: r.iconId ?? null,
          coverId: r.coverId ?? null,
          screenshotCount: r._count?.screenshots ?? 0,
          description: r.description ?? null,
          tagline: r.tagline ?? null,
          category: r.category ?? null,
        }).problems,
      };
    }
  );
}

/** The two booleans the `/apps/*` sub-nav needs in order to offer a route at all. */
export type AppsNavAccess = {
  /**
   * ≥1 listing OWNED or held via an ACCEPTED seat → the "My apps" route is non-empty.
   *
   * 🔴 A PENDING OWNERSHIP TRANSFER DELIBERATELY DOES **NOT** COUNT HERE. It confers ZERO
   * capability until accepted — the same consent principle as a pending seat invite, and
   * `app-ownership-transfer.service` states it in as many words. Lighting "My apps" for an
   * offer would advertise a page the recipient's every child query refuses.
   */
  hasEditableApps: boolean;
  /**
   * ≥1 pending item ADDRESSED TO the caller → the "Invites" route is non-empty.
   *
   * 🔴 TWO KINDS OF PENDING ITEM, and the second used to be missing. `/apps/invites` is
   * where BOTH a pending seat invite and an inbound ownership-transfer OFFER render, but
   * this predicate knew only about seats — so a user with an offer and no seat invite got
   * no tab at all, i.e. no route to the only page that shows the offer. The name is kept
   * (it gates the "Invites" tab, and the tab covers both) but the meaning is now
   * "anything pending for you", not "a seat invite".
   */
  hasPendingInvites: boolean;
};

/**
 * The sub-nav's collaborator-aware visibility probe. EXISTENCE ONLY — four `findFirst`s,
 * no rows, matching `getNavSummary`'s existing shape.
 *
 * 🔴 IT LIVES HERE RATHER THAN IN `blocks.router` FOR A MEASURED REASON. Writing the two
 * seat probes inline in the router put a THIRD open-coding of `status: 'accepted'` into
 * the codebase, and `app-access.call-site-ledger.test.ts` failed on the growth — which is
 * exactly what that ledger is for. The consent filter has one home; a second site is a
 * site that can forget it, and a seat query missing `status: 'accepted'` would let a
 * PENDING invite light up a nav route (and, by the same drift elsewhere, confer access).
 *
 * 🔴 The ownership half re-uses the SAME {@link canonicalOwnerWhereBranches} as
 * {@link resolveAccessibleListingIds} — literally the same function call, not a second
 * copy of the branches — so the tab cannot appear for a set the page then renders empty,
 * or stay hidden over a set the page would fill.
 *
 * 🔴 ALL THREE MANUAL-APPLY PROBES DEGRADE to `false` while their tables are absent: an
 * un-degraded read here would 500 the sub-nav, i.e. every `/apps` page's chrome, for the
 * whole window between the code deploy and a human applying the migration. That includes
 * the TRANSFER probe — `app_ownership_transfers` is created by the very same manual-apply
 * migration as `app_collaborators` (`20260811170000_rekey_app_collaborators_step_b_…`),
 * and that migration's own rollback note says dropping them must return the deployed code
 * to the 42P01 path, "inert-and-owner-only, NOT broken". An unwrapped transfer read would
 * break exactly that promise. A 42703 (half-applied schema) still propagates, by design.
 *
 * 🔴 QUERY COST, stated rather than left to be discovered: this is now FOUR existence
 * probes instead of three. They run inside the SAME `Promise.all`, so the added serial
 * latency is zero, but it is one more concurrent round trip (and one more pool slot) per
 * `getNavSummary` — which the `/apps` chrome renders on every page load. It cannot be
 * folded into an existing query: the four probes hit three different tables, and unioning
 * across them would mean hand-written SQL. The probe itself is as cheap as it gets — a
 * `findFirst` selecting one column, narrowed on the indexed `(to_user_id, status)` pair
 * (`app_ownership_transfers_to_status_idx`) with `expires_at` as a residual filter over
 * the handful of rows that pair can return.
 */
export async function resolveAppsNavAccess(
  userId: number,
  /**
   * Injected so the EXPIRY BOUNDARY is testable at an exact instant rather than raced
   * against wall-clock. Mirrors `app-ownership-transfer.service`'s convention, where every
   * lifecycle function threads a `now`.
   */
  now: Date = new Date()
): Promise<AppsNavAccess> {
  const [ownedListing, seat, invite, transferOffer] = await Promise.all([
    dbRead.appListing.findFirst({
      where: { revisionOfId: null, OR: canonicalOwnerWhereBranches(userId) },
      select: { id: true },
    }),
    safeCollaboratorQuery(
      () =>
        dbRead.appCollaborator.findFirst({
          where: { userId, status: ACCEPTED },
          select: { appListingId: true },
        }),
      null
    ),
    safeCollaboratorQuery(
      () =>
        dbRead.appCollaborator.findFirst({
          where: { userId, status: 'pending' },
          select: { appListingId: true },
        }),
      null
    ),
    // 🔴 AN INBOUND OWNERSHIP OFFER LIGHTS THE SAME TAB — see {@link
    // AppsNavAccess.hasPendingInvites}. `toUserId` is the ADDRESSEE, so this can never be
    // lit by an offer the caller SENT, only by one they received.
    //
    // 🔴 `expiresAt: { gt: now }` IS NOT OPTIONAL, and it is the half a naive
    // `status: 'pending'` check gets wrong. Expiry here is a READ-TIME PREDICATE with no
    // sweeper behind it (schema.full.prisma says so on the column, and the migration
    // repeats it), so a long-dead offer keeps `status = 'pending'` forever. Without this
    // clause the tab would latch on permanently for anyone who was ever offered an app.
    // STRICT `>` matches `app-ownership-transfer.service::isLive` exactly — an offer AT
    // its expiry instant is already dead — so the tab and the page cannot disagree about
    // the boundary.
    safeCollaboratorQuery(
      () =>
        dbRead.appOwnershipTransfer.findFirst({
          where: { toUserId: userId, status: 'pending', expiresAt: { gt: now } },
          select: { id: true },
        }),
      null
    ),
  ]);
  return {
    // 🔴 `transferOffer` is deliberately ABSENT from this disjunct. See the type.
    hasEditableApps: ownedListing !== null || seat !== null,
    hasPendingInvites: invite !== null || transferOffer !== null,
  };
}

/** Hard ceiling on {@link listMyAppListings}. Well above the per-owner app cap. */
export const MY_APP_LISTINGS_LIMIT = 200;

/**
 * "Every app I own or hold a seat on." THE entry-point read for the authoring surfaces.
 *
 * Returns owner rows and editor rows in one list, each carrying its `role` and its
 * kind-derived `capabilities`, so a caller never has to re-derive either — and cannot
 * derive them differently.
 */
export async function listMyAppListings(opts: {
  userId: number;
  limit?: number;
}): Promise<MyAppListing[]> {
  const limit = Math.min(Math.max(opts.limit ?? MY_APP_LISTINGS_LIMIT, 1), MY_APP_LISTINGS_LIMIT);
  return hydrateMyAppListings(await resolveAccessibleListingIds(opts.userId), limit);
}

/**
 * The single-listing form of {@link MyAppListing}, for the canonical authoring page.
 *
 * 🔴 THROWS rather than returning a role-less row. A page that renders its chrome for a
 * caller with no role would then 403 on every child query; refusing here means the tab
 * set is only ever computed for someone who actually holds one.
 *
 * 🔴 RESOLVES A SHADOW TO ITS PARENT, via `resolveListingAccess`. `appListingId` in the
 * result is therefore the SEAT (parent) listing — the id every collaborator proc wants —
 * even when the caller arrived with a shadow id in the URL.
 */
export async function getAppListingAuthoringContext(opts: {
  appListingId: string;
  userId: number;
}): Promise<AppListingAuthoringContext> {
  const access = await resolveListingAccess(opts.appListingId, opts.userId);
  if (!access) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'App listing not found' });
  }
  if (!access.role) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this app' });
  }
  const row = await dbRead.appListing.findUnique({
    where: { id: access.seatListingId },
    // 🔴 `connectClientId` IS READ FROM THE SEAT (PARENT) ROW, which is the same row
    // `app-ownership-transfer::loadOwnedListing` reads — so the tab's up-front verdict and
    // the server's refusal are looking at one column on one row. Reading it off a SHADOW
    // would be the `kind`/`appBlockId` trap below in a new place.
    select: { id: true, slug: true, name: true, status: true, connectClientId: true },
  });
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'App listing not found' });
  }
  // 🔴 STATUS GATE — see {@link AUTHORABLE_LISTING_STATUSES}. A moderator-removed listing
  // must not open the authoring page at all; leaving it open left a live Collaborators tab
  // on a delisted app, where accepting an invite still mints repo write.
  if (!isAuthorableListingStatus(row.status)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This listing can no longer be edited',
    });
  }
  return {
    appListingId: access.seatListingId,
    slug: row.slug,
    name: row.name,
    status: row.status,
    // 🔴 KIND AND BLOCK COME FROM `access` (the PARENT), never from the row asked for —
    // a shadow carries `appBlockId: null` by construction, so reading them off it would
    // make an in-flight revision look off-site and silently strip the block-only tabs.
    kind: access.kind,
    appBlockId: access.appBlockId,
    connectClientId: row.connectClientId,
    role: access.role,
    capabilities: capabilitiesForKind(access.kind),
  };
}

/**
 * The PUBLIC byline set for a LISTING: the user ids of its ACCEPTED **and** `displayed`
 * collaborators.
 *
 * 🔴 Takes the PARENT listing id. Works identically for both kinds — this is the read
 * the re-key exists to make possible for off-site listings.
 *
 * 🔴 BOTH predicates are load-bearing and neither may be dropped:
 *   - `status = accepted` is CONSENT (a pending invitee never appears publicly, so an
 *     app cannot borrow a stranger's name), and
 *   - `displayed = true` is the byline OPT-OUT (an accepted editor who does not want
 *     public credit).
 * `app-access.service.test.ts` ("the PUBLIC byline is accepted AND displayed only")
 * asserts a pending, a rejected and an accepted-but-undisplayed row are all absent from
 * this set. The DTO half — that the projection adds nothing to what it is handed — is
 * pinned separately in `app-collaborator.public-projection.test.ts`.
 */
export async function listDisplayedCollaboratorUserIds(appListingId: string): Promise<number[]> {
  const rows = await safeCollaboratorQuery(
    () =>
      dbRead.appCollaborator.findMany({
        where: { appListingId, status: ACCEPTED, displayed: true },
        select: { userId: true },
        orderBy: { createdAt: 'asc' },
      }),
    [] as { userId: number }[]
  );
  return rows.map((r: { userId: number }) => r.userId);
}

/**
 * The user ids that must be treated as "the app's own people" for ANTI-ABUSE
 * purposes — the owner plus every ACCEPTED collaborator, REGARDLESS of `displayed`.
 *
 * Keyed on the APP BLOCK because its only caller is the `AppBlockReview` self-review
 * gate, which is block-scoped; the seats are reached via the block's listing.
 *
 * 🔴 `displayed` is deliberately NOT filtered here, and the asymmetry with
 * {@link listDisplayedCollaboratorUserIds} is the whole point: `displayed` is a
 * PUBLIC-CREDIT preference, not a capability. An editor who opted out of the byline is
 * still an insider, so they still must not be able to 5-star the app they can edit.
 * Filtering on `displayed` here would make "hide my name" a self-review bypass.
 */
export async function listAppInsiderUserIds(appBlockId: string): Promise<number[]> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { app: { select: { userId: true } }, appListing: { select: { id: true } } },
  });
  if (!block?.app) return [];
  const ids = new Set<number>([block.app.userId]);
  const appListingId = block.appListing?.id;
  if (!appListingId) return [...ids];
  const seats = await safeCollaboratorQuery(
    () =>
      dbRead.appCollaborator.findMany({
        where: { appListingId, status: ACCEPTED },
        select: { userId: true },
      }),
    [] as { userId: number }[]
  );
  for (const s of seats) ids.add(s.userId);
  return [...ids];
}
