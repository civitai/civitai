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
 * Ownership is canonically `OauthClient.userId`, reached as `AppBlock.app.userId`.
 * `AppListing.userId` is a DENORMALIZED COPY. A collaborator seat (`AppCollaborator`)
 * is keyed to the `AppBlock`, so this module resolves listing-shaped questions by
 * walking back to the AppBlock.
 *
 *   role 'owner'  → the OauthClient owner. Everything an editor can do, PLUS managing
 *                   collaborators and initiating an ownership transfer.
 *   role 'editor' → an ACCEPTED `AppCollaborator`. Listing content + media + submit a
 *                   new version + app-scoped analytics AND earnings. Effectively a
 *                   co-owner minus the two owner-only actions above.
 *   role null     → no access. This INCLUDES a `pending` and a `rejected` seat:
 *                   🔴 an unaccepted invite must confer ZERO capability, or anyone
 *                   could attach a stranger's identity to their app by inviting them.
 *
 * Moderator status is deliberately NOT folded in here. It is an orthogonal axis and
 * the existing sites disagree about it (see the ledger); each call site keeps its own
 * `user.isModerator` handling exactly as before, so this consolidation cannot silently
 * grant or revoke a mod bypass anywhere.
 *
 * ## INERT UNTIL THE MIGRATION IS APPLIED
 *
 * 🔴 The `app_collaborators` table is MANUAL-APPLY (datapacket-talos DB rule #8) — no
 * deploy path runs `prisma migrate deploy`. Every read of it therefore goes through
 * {@link safeCollaboratorQuery}, which catches "relation does not exist" and degrades
 * to "no collaborators". With the table absent, `resolveAppAccess` returns exactly
 * `owner`/`null` — byte-identical to the pre-change owner-only behaviour — instead of
 * 500ing every app page. The WRITE paths do not swallow it (an invite that silently
 * did nothing would be worse than an error).
 */

/** The two capability roles. `null` (no access) is modelled as the absence of one. */
export type AppRole = 'owner' | 'editor';

export type AppAccess = {
  appBlockId: string;
  /** The canonical owner (`OauthClient.userId`). */
  ownerUserId: number;
  /** `null` = the caller has NO access (stranger, or a pending/rejected invite). */
  role: AppRole | null;
};

export type ListingAccess = {
  appListingId: string;
  /** The listing's denormalized owner column. */
  ownerUserId: number;
  /**
   * The AppBlock a collaborator seat could be keyed to. `null` for a natively-created
   * OFFSITE listing (it has no backing AppBlock at all), in which case only the owner
   * has access — there is nothing to collaborate on.
   */
  appBlockId: string | null;
  role: AppRole | null;
};

/** The one status that confers capability. Nothing else does. */
export const ACCEPTED = 'accepted' as const;

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
 * Is `userId` an ACCEPTED collaborator on `appBlockId`?
 *
 * The `status: ACCEPTED` filter is the consent gate and is NOT optional — see the
 * module header. Callers must never widen this to "a row exists".
 */
async function hasAcceptedSeat(
  appBlockId: string,
  userId: number,
  db: AccessDb = dbRead
): Promise<boolean> {
  const row = await safeCollaboratorQuery(
    () =>
      db.appCollaborator.findFirst({
        where: { appBlockId, userId, status: ACCEPTED },
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
 */
export async function resolveAppAccess(
  appBlockId: string,
  userId: number | null | undefined
): Promise<AppAccess | null> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { id: true, app: { select: { userId: true } } },
  });
  if (!block?.app) return null;
  const ownerUserId = block.app.userId;
  if (typeof userId !== 'number') {
    return { appBlockId: block.id, ownerUserId, role: null };
  }
  if (ownerUserId === userId) {
    return { appBlockId: block.id, ownerUserId, role: 'owner' };
  }
  const editor = await hasAcceptedSeat(block.id, userId);
  return { appBlockId: block.id, ownerUserId, role: editor ? 'editor' : null };
}

/**
 * Resolve the caller's role on an App LISTING.
 *
 * 🔴 SHADOW-AWARE. A shadow revision (`revisionOfId != null`) carries
 * `appBlockId: null` by construction — `appBlockId` is `@unique` and stays on the
 * parent. So resolving a shadow's collaborator seat MUST walk to its parent, or every
 * editor would lose access the moment their first media edit minted the shadow. That
 * is one hop only: `beginListingRevision` refuses to open a revision of a revision.
 *
 * A natively-created offsite listing (no backing AppBlock anywhere in the chain)
 * resolves `appBlockId: null` and therefore only ever `owner`/`null`.
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
      appBlockId: true,
      revisionOfId: true,
      revisionOf: { select: { appBlockId: true } },
    },
  });
  if (!listing) return null;
  // A shadow's seat lives on its PARENT's AppBlock (see the note above).
  const appBlockId = listing.appBlockId ?? listing.revisionOf?.appBlockId ?? null;
  const base = { appListingId: listing.id, ownerUserId: listing.userId, appBlockId };
  if (typeof userId !== 'number') return { ...base, role: null };
  if (listing.userId === userId) return { ...base, role: 'owner' };
  if (!appBlockId) return { ...base, role: null };
  const editor = await hasAcceptedSeat(appBlockId, userId, db);
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
  // Not the owner — the only remaining route in is an ACCEPTED seat. Costs one query,
  // and ONLY on the non-owner path, so the common case is unchanged.
  if (!(await hasAcceptedSeat(args.appBlockId, args.userId))) deny();
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
 */
export async function resolveAccessibleAppBlockIds(userId: number): Promise<AccessibleAppBlocks> {
  const [owned, seats] = await Promise.all([
    dbRead.appBlock.findMany({ where: { app: { userId } }, select: { id: true } }),
    safeCollaboratorQuery(
      () =>
        dbRead.appCollaborator.findMany({
          where: { userId, status: ACCEPTED },
          select: { appBlockId: true },
        }),
      [] as { appBlockId: string }[]
    ),
  ]);
  const ownedIds = owned.map((b: { id: string }) => b.id);
  const ownedSet = new Set(ownedIds);
  // Disjoint by construction: an owner who somehow also holds a seat on their own app
  // counts once, as an owner. (The invite path refuses to seat the owner, so this is
  // defence against a hand-written row, not an expected state.)
  const editorIds = seats
    .map((s: { appBlockId: string }) => s.appBlockId)
    .filter((id: string) => !ownedSet.has(id));
  return { ownedIds, editorIds, allIds: [...ownedIds, ...editorIds] };
}

/**
 * The PUBLIC byline set for an app: the user ids of its ACCEPTED **and** `displayed`
 * collaborators.
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
export async function listDisplayedCollaboratorUserIds(appBlockId: string): Promise<number[]> {
  const rows = await safeCollaboratorQuery(
    () =>
      dbRead.appCollaborator.findMany({
        where: { appBlockId, status: ACCEPTED, displayed: true },
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
 * 🔴 `displayed` is deliberately NOT filtered here, and the asymmetry with
 * {@link listDisplayedCollaboratorUserIds} is the whole point: `displayed` is a
 * PUBLIC-CREDIT preference, not a capability. An editor who opted out of the byline is
 * still an insider, so they still must not be able to 5-star the app they can edit.
 * Filtering on `displayed` here would make "hide my name" a self-review bypass.
 */
export async function listAppInsiderUserIds(appBlockId: string): Promise<number[]> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { app: { select: { userId: true } } },
  });
  if (!block?.app) return [];
  const seats = await safeCollaboratorQuery(
    () =>
      dbRead.appCollaborator.findMany({
        where: { appBlockId, status: ACCEPTED },
        select: { userId: true },
      }),
    [] as { userId: number }[]
  );
  const ids = new Set<number>([block.app.userId]);
  for (const s of seats) ids.add(s.userId);
  return [...ids];
}
