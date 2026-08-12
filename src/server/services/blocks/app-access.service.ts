import { TRPCError } from '@trpc/server';

import { dbRead } from '~/server/db/client';

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

/** The two capability roles. `null` (no access) is modelled as the absence of one. */
export type AppRole = 'owner' | 'editor';

/** The store's two listing kinds. Mirrors `AppListing.kind`'s DB CHECK. */
export type ListingKind = 'onsite' | 'offsite';

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
   * column IS the owner and the fallback is exact.
   *
   * 🔴 …WITH ONE MEASURED EXCEPTION TO "kind-aware", tracked as
   * https://github.com/civitai/civitai/issues/3844. The implementation is BLOCK-FIRST
   * (`appBlock.app.userId ?? listing.userId`) and never branches on `kind`, which reads
   * as kind-aware only because an ordinary off-site listing has no block. On an OFF-SITE
   * listing that DOES carry one, the block decides — and both off-site ownership writers
   * (`acceptTransfer`'s offsite path and `claimListing`) move only the column, so this
   * function keeps naming the OLD owner. 0 rows of that shape in production and no code
   * path can mint one today (see the issue for the measurement). Do not fix it here; the
   * behaviour is pinned in `app-access.denormalized-owner-drift.test.ts`.
   *
   * The same resolution is written in `app-collaborator.service::toSeatListing` and in
   * `app-ownership-transfer.service::loadOwnedListing`, the two WRITE-side seat/transfer
   * loaders; every other consumer delegates to THIS function rather than re-deriving it.
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

// ---------------------------------------------------------------------------
// CAPABILITIES — derived from the listing KIND. No per-seat configuration.
// ---------------------------------------------------------------------------

/**
 * What an editor seat can unlock. An editor gets their declared role ∩ what the
 * listing's KIND supports; there is no third input, and deliberately no stored
 * per-seat capability set — a config surface here would be a new thing to get wrong on
 * every invite, and would drift from what the kind can physically do.
 */
export type ListingCapability =
  /** Listing content + media (name/tagline/description/icon/cover/screenshots). */
  | 'listingContent'
  /** Submit the listing for moderator review (`AppListingPublishRequest` + changelog). */
  | 'submitForReview'
  /** Listing analytics (`AppListingMetric` connect/visit, app views). */
  | 'analytics'
  /** Buzz earnings + payout figures. */
  | 'earnings'
  /** Ship a new app VERSION: the bundle submit path and Forgejo repo write. */
  | 'submitVersion';

/**
 * 🔴 THE CAPABILITY TABLE, and the two `false` cells are STRUCTURAL, not policy:
 *
 *   - `earnings` — `BlockBuzzAttribution` is keyed on `appBlockId` + a snapshotted
 *     `appOwnerUserId`. An off-site listing has no AppBlock, so there is no row that
 *     could ever be attributed to it. Returning a zeroed summary would be a lie
 *     indistinguishable from "earned nothing"; the read refuses instead.
 *   - `submitVersion` — an off-site listing has no bundle and no Forgejo repo. There
 *     is nothing to push to and no credential to mint.
 *
 * Everything else is identical across kinds, because an off-site listing carries the
 * same content, the same review flow (`AppListingPublishRequest`) and the same metric
 * rows as an on-site one.
 */
export const CAPABILITIES_BY_KIND: Readonly<
  Record<ListingKind, Readonly<Record<ListingCapability, boolean>>>
> = Object.freeze({
  onsite: Object.freeze({
    listingContent: true,
    submitForReview: true,
    analytics: true,
    earnings: true,
    submitVersion: true,
  }),
  offsite: Object.freeze({
    listingContent: true,
    submitForReview: true,
    analytics: true,
    // Block-scoped money. No AppBlock ⇒ no attribution rows can exist.
    earnings: false,
    // No bundle, no repo.
    submitVersion: false,
  }),
});

/** The capability set a listing of this kind can support at all. */
export function capabilitiesForKind(
  kind: ListingKind
): Readonly<Record<ListingCapability, boolean>> {
  return CAPABILITIES_BY_KIND[kind] ?? CAPABILITIES_BY_KIND.offsite;
}

/**
 * Does a listing of this kind support `capability`?
 *
 * 🔴 An UNKNOWN kind falls back to the OFFSITE (narrower) row, not the onsite one —
 * fail-closed. A kind this code does not recognise must never be handed the two
 * block-only capabilities.
 */
export function listingKindSupports(kind: string, capability: ListingCapability): boolean {
  return capabilitiesForKind(kind as ListingKind)[capability] === true;
}

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
  const kind = ((listing.revisionOfId ? parent?.kind : listing.kind) ?? listing.kind) as ListingKind;
  const appBlockId = (listing.revisionOfId ? parent?.appBlockId : listing.appBlockId) ?? null;
  // 🔴 `AppBlock.app.userId` FIRST, the column only as the fallback — which is exact for
  // offsite (no OauthClient in the chain) and covers an onsite block with a dangling
  // `app_id`. Identical resolution to `toSeatListing` and `loadOwnedListing`, so the
  // read side and the write side cannot disagree about who the owner is.
  const ownerUserId =
    (listing.revisionOfId ? parent?.appBlock?.app?.userId : listing.appBlock?.app?.userId) ??
    listing.userId;
  const base = {
    appListingId: listing.id,
    seatListingId,
    ownerUserId,
    kind,
    appBlockId,
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
