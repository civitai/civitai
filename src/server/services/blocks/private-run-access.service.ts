import { dbRead, dbWrite } from '~/server/db/client';
import type { SessionUser } from '~/types/session';
import { BlockRegistry } from '~/server/services/block-registry.service';
import type { PrivateRunPageBlockResolution } from '~/server/services/block-registry.service';
// 🔴 `resolveAppAccess` IS IMPORTED DYNAMICALLY, AT ITS CALL SITE, AND ONLY THE TYPE IS
// STATIC. It is still the REAL function — a dynamic import changes WHEN the module
// loads, never WHICH function runs, so the anti-drift property this whole file rests on
// is untouched.
//
// Two reasons. 🔴 THEY ARE ORDERED BY WEIGHT, AND AN EARLIER VERSION OF THIS COMMENT
// HAD THEM THE OTHER WAY ROUND — corrected after review pointed out that the reason I
// led with is a TEST-ENVIRONMENT fact, not a production cost:
//  1. THE REAL REASON. The flag ships BASE-OFF, so in production today every request
//     refuses at gate (1) before any role resolve. A static import would make every one
//     of them pay module-eval of `app-listing-assets` + `app-listing.service` +
//     `cache-helpers` and their transitive deps in order to do nothing. The mint's own
//     neighbours already apply exactly this pattern for exactly this reason ("dynamic
//     import so the flag module isn't eager-loaded on the prod-mint import path").
//  2. HOW IT WAS FOUND, which is weaker than it first looked. `app-access.service` pulls
//     `app-listing-assets.service` → `app-listing.service` → `cache-helpers` →
//     `createLogger`, which reads `env.LOGGING` AT MODULE SCOPE — and that THREW in two
//     existing mint suites the moment a static edge existed. ⚠️ In production it could
//     not have thrown: the mint already imports `~/env/server` for the token keys. So
//     this was a test-fixture symptom that pointed at a real graph edge, not a
//     production failure — worth recording as the discovery route, not as the argument.
// Node's module cache makes a repeat `await import()` a resolved-promise microtask, so
// deferring does not move a per-request cost onto the hot path; the first private-run
// role resolve per pod pays the subgraph's module-eval inside one request, once.
//
// `import type` is erased, so the `AccessDb` type below creates NO load-time edge.
import type { AccessDb } from '~/server/services/blocks/app-access.service';
import type { PrivateRunAudience } from '~/shared/constants/block-scope.constants';

/**
 * THE ONE ACCESS PREDICATE FOR A PRIVATE RUN OF A DELISTED / SUSPENDED APP.
 *
 * ── WHY THERE IS EXACTLY ONE, AND WHY EVERY CALLER MUST USE IT ────────────────
 * 🔴 THE DEFECT THIS FILE EXISTS TO PREVENT IS AN SSR↔MINT ASYMMETRY, AND THAT
 * DEFECT HAS ALREADY HAPPENED ONCE ON THIS EXACT SURFACE. The dev-tunnel SSR route
 * mounts an owned app at ANY status (`resolveDevPageBlockForAuthor`), while the page
 * mint required `status: 'approved'` (`resolvePageBlock`) — so the page rendered and
 * then could not authenticate, and `tryDevTunnelOwnedNonApprovedMint` exists purely
 * to close that gap after the fact. Its own docblock records the asymmetry. A second
 * surface with two independently-written gates would regrow it.
 *
 * So: the SSR resolver and the PHASE 3 mint branch call THIS, and nothing else
 * decides who may privately run a delisted app. A behavioural test drives one fixture
 * through both and asserts they agree — because a structural ledger type-checks past
 * a wrong argument.
 *
 * ⚠️ THE CALLER COUNT IS **THREE**, NOT TWO, AND THIS LINE SAID TWO FOR LONGER THAN THE
 * ERROR SURVIVED ANYWHERE ELSE. `private-run-access.call-site-ledger` pins THREE:
 * the SSR route, the mint, and `private-run-impression.service.ts` — the analytics
 * impression gate, which takes no access decision and grants nothing (it reads
 * `allowed` and drops a telemetry row), which is why it cannot reproduce the
 * SSR↔MINT asymmetry this file exists to prevent and why it is nonetheless required
 * to share the predicate rather than hand-roll a lookalike.
 * 🔴 THE RETRACTION ALREADY EXISTED — in `private-run-impression.service.ts`, whose
 * docblock says in as many words that defining it elsewhere "would have … left the
 * ledger reporting 'exactly two callers' while being wrong". It was written in the
 * file the author was looking at, and the two files that ASSERT the count were never
 * swept. A correction lands where you were looking, not where a reader arrives from:
 * when you retract a count, grep the whole tree for it before you stop.
 *
 * ⚠️ NOT EVERY "two callers" PHRASE BELOW IS WRONG. The ones describing the SSR↔MINT
 * SEAM — the two surfaces that take an access decision and could DISAGREE — are
 * correct and deliberately unchanged; only claims about the LEDGER'S COUNT were.
 *
 * ── IT CALLS THE REAL ROLE RESOLVER, NOT A COPY ───────────────────────────────
 * 🔴 `resolveAppAccess` IS INVOKED, NEVER RE-IMPLEMENTED. The precedent is exact:
 * civitai #3594 wired a go-live gate at six sites by calling the real
 * `getDetailPrimaryAction` "so it cannot drift from what the page renders", and the
 * finding that justified it was a sixth site nobody had called a go-live path. Two
 * specific temptations are refused here:
 *   - Do NOT hand-roll `app.userId === viewer.id`. That misses the accepted-seat
 *     (editor) audience entirely and duplicates a predicate that already exists.
 *   - Do NOT call `hasAcceptedSeat` directly — it is module-private for a reason, and
 *     `app-access.service.ts` warns that its `status: ACCEPTED` filter "is the consent
 *     gate and is NOT optional. Callers must never widen this to 'a row exists'."
 *
 * ⚠️ NOTE WHAT `resolveAppAccess` DOES NOT DO: it is not status-aware (its docblock
 * says so explicitly — it selects `id`, `app.userId` and `appListing.id`, and returns
 * `owner | editor | null`). Every status, deploy, maturity and ban decision on this
 * surface is taken HERE, against the block row this file resolves separately. It also
 * applies no listing-status filter, which is exactly the behaviour the operator's
 * decision 3 wants — see the seat asymmetry note on `no-role` below.
 *
 * ── THE REASON IS FOR TESTS AND THE AUDIT LINE. IT MUST NEVER REACH HTTP ──────
 * 🔴 Both callers map EVERY `allowed: false` onto their own PRE-EXISTING bare
 * refusal — SSR `{ notFound: true }`, mint `'continue'` → the shared
 * `404 {"error":"Page app not found"}`. No new status code is introduced anywhere on
 * this feature. If a `reason` ever becomes a status code, a body, or a header, this
 * predicate becomes an existence oracle: `'approved'` vs `'no-app'` would tell an
 * unauthenticated prober whether a slug exists, and `'no-role'` vs `'no-app'` would
 * tell them a delisted app is there but not theirs. The mint's audit line is the ONLY
 * consumer of `reason` outside tests, and that line goes to Axiom and stdout.
 */

/**
 * Every refusal this predicate can produce, ordered as it FIRST evaluates them.
 *
 * ⚠️ NOT "exactly as it evaluates them", which is what this line used to claim and is not
 * true of one member: `viewer-ineligible` is produced at TWO positions — the free session
 * check at gate (2) and the authoritative primary re-read at gate (3.5), which sits AFTER
 * the block resolve. So a soft-deleted viewer whose session does not yet carry `deletedAt`,
 * probing a slug that does not exist, gets `no-app` rather than `viewer-ineligible`. That
 * is the intended ordering (an enumerable probe must not pay for the primary read), but it
 * means this tuple is an ORDERING OF REASONS, not a trace of evaluation. Nothing consumes
 * the order today — the mint test only filters the tuple for completeness — and that is
 * the only reason the stale wording was harmless rather than a bug generator.
 *
 * 🔴 A RUNTIME TUPLE, WITH THE TYPE DERIVED FROM IT — not a type with a hand-copied list
 * beside it. Types are erased, so a test that enumerates these reasons against a
 * hand-written array stays GREEN when a ninth member is added to the union and has no
 * coverage, under a comment claiming the enumeration is complete. The access-matrix test
 * derives its completeness check from this tuple, so adding a reason without a row is a
 * failing test rather than a silent gap. Same shape as `PRIVATE_RUN_AUDIENCES`.
 */
export const PRIVATE_RUN_REFUSAL_REASONS = [
  'flag-off',
  'viewer-ineligible',
  'no-app',
  'approved',
  'not-a-page',
  'no-role',
  'owner-banned',
  'not-deployed',
  'no-iframe-src',
] as const;

export type PrivateRunRefusalReason = (typeof PRIVATE_RUN_REFUSAL_REASONS)[number];

export type PrivateRunAccess =
  | {
      allowed: true;
      audience: PrivateRunAudience;
      block: PrivateRunPageBlockResolution;
    }
  | { allowed: false; reason: PrivateRunRefusalReason };

/**
 * Resolve whether `viewer` may privately run the non-approved page app named by `by`.
 *
 * ── GATE ORDER, AND WHY EACH POSITION IS LOAD-BEARING ─────────────────────────
 * The order is a REACHABILITY decision as much as a cost one. A guard that some
 * earlier check always rejects first never executes, so it survives a mutation sweep
 * while providing nothing — and the fix is placement, not another test.
 *
 *  1. `flag-off` — the kill-switch, before ANY database read. This is what makes
 *     "turn the flag off" a complete rollback: nothing is resolved, so there is no
 *     state to unwind and the pre-feature behaviour returns exactly.
 *  2. `viewer-ineligible` (SESSION) — anonymous, or a session that already says banned
 *     or soft-deleted. FREE, and before the app read so a signed-out prober cannot
 *     consume a query per slug.
 *  3. `no-app` / `approved` / `not-a-page` — the block resolve (one query).
 *     `approved` is tested BEFORE the role resolve so the approved case costs no
 *     second query, and because the public path owns it unconditionally: no role can
 *     make an approved app a private-run case.
 *  3.5 `viewer-ineligible` (AUTHORITATIVE) — the same reason, re-checked against the
 *     PRIMARY because the session is not authoritative for `deletedAt`. Deliberately
 *     AFTER the block resolve so an enumerable `no-app` probe does not pay for it.
 *  4. `no-role` — the shared role resolve. A moderator short-circuits it (the
 *     server-stamped session flag), so a mod who is neither owner nor collaborator
 *     still gets in — the audience the whole feature exists for.
 *  5. `owner-banned` — for the `owner` and `editor` audiences ONLY. Moderators keep
 *     access to a banned publisher's app deliberately: reviewing what a banned
 *     publisher shipped is the job. Placed AFTER the role resolve because it needs
 *     the audience to know whether it applies at all.
 *  6. `not-deployed` — and the placement is the whole reason its guard is
 *     testable. A private run serves the app's DEPLOYED bundle; an app with
 *     `currentVersionDeployedAt == null` has no origin behind it, so the iframe would
 *     time out and pollute the render metrics. If this sat before the role resolve,
 *     the "unrelated viewer + undeployed app" fixture would kill its mutant for the
 *     WRONG reason and the guard would never be shown to work on its own terms.
 *  7. `no-iframe-src` — nothing to host. Moved in from the SSR route, which applied it
 *     AFTER the predicate while the mint never applied it at all; last because it is the
 *     only gate that depends on nothing but the manifest.
 *
 * ── THE SEAT ASYMMETRY THAT MAKES THE `editor` AUDIENCE WORK ──────────────────
 * `AUTHORABLE_LISTING_STATUSES` blocks GRANTING a seat (or ACCEPTING an invite) on a
 * `removed` or `rejected` listing, but `resolveAppAccess` applies no listing-status
 * filter to READING one. So an ALREADY-ACCEPTED collaborator keeps private-run access
 * through a delist while no new collaborator can be added while it is down. That is
 * the intended behaviour and it is already the code's; this predicate inherits it
 * rather than re-deciding it, and `AUTHORABLE_LISTING_STATUSES` is NOT widened.
 *
 * A `pending` or `rejected` seat therefore yields `no-role`, because the `ACCEPTED`
 * filter inside `resolveAppAccess` is the consent gate.
 *
 * ── THE PRIMARY, NOT THE REPLICA ──────────────────────────────────────────────
 * `db` is threaded all the way into `resolveAppAccess` (its third positional
 * parameter). The mint passes `dbWrite` so a freshly-suspended, freshly-relisted or
 * freshly-seated row cannot be read through a replication-lag window — in either
 * direction. Reading the replica here would turn ordinary lag into a spurious refusal
 * on a collaborator's first private run, which is the same argument
 * `resolveListingAccess`'s own docblock makes for its `db` parameter.
 */
export async function resolvePrivateRunAccess(args: {
  /** Slug for the SSR route, appBlockId for the mint. Exactly one. */
  by: { slug: string } | { appBlockId: string };
  viewer: SessionUser | undefined | null;
  /**
   * Which pool to read through. The mint passes `'write'`; the SSR route takes the
   * default `'read'`. Spelled as the same `'read' | 'write'` discriminator every
   * `BlockRegistry` resolver takes, rather than as a client handle, so ONE value
   * selects the pool for the block read, the role resolve and the ban read together —
   * threading a handle for one and a string for another is how the three end up
   * disagreeing about which pool answered.
   */
  db?: 'read' | 'write';
  /**
   * The already-evaluated kill-switch.
   *
   * 🔴 PASSED IN, NOT READ HERE, AND THAT IS NOT LAZINESS. The flag must be evaluated
   * FOR THE CALLER on both surfaces, and each caller already holds the session it
   * would be evaluated against. Reading it inside this function would either need the
   * `SessionUser` to be re-threaded into the flag client here (duplicating what the
   * caller just did) or tempt a global eval — and a global eval returns the flag's
   * BASE value rather than denying, which is a measured property of this repo's Flipt
   * client, not a theoretical one. Keeping it a required parameter makes "did you
   * evaluate the flag for this caller?" a type error rather than a review question.
   */
  privateRunEnabled: boolean;
}): Promise<PrivateRunAccess> {
  const { by, viewer, privateRunEnabled } = args;
  const pool: 'read' | 'write' = args.db ?? 'read';
  // `dbWrite` is the same PrismaClient shape; `AccessDb` is declared as `typeof dbRead`
  // and `app-access.service.ts` imports only `dbRead`, so its own tests cast too.
  const db: AccessDb = pool === 'write' ? (dbWrite as unknown as AccessDb) : dbRead;

  // (1) KILL-SWITCH FIRST — before any read, so `false` is a complete rollback.
  if (!privateRunEnabled) return { allowed: false, reason: 'flag-off' };

  // (2) VIEWER ELIGIBILITY. Anonymous can never privately run: every audience is a
  // named relationship to the app or a moderator, and all three are self-bound. A
  // banned or soft-deleted viewer is refused here rather than deeper, mirroring the
  // page mint's own `bannedAt` / `deletedAt` gates.
  if (!viewer || typeof viewer.id !== 'number') {
    return { allowed: false, reason: 'viewer-ineligible' };
  }
  if (viewer.bannedAt || viewer.deletedAt) {
    return { allowed: false, reason: 'viewer-ineligible' };
  }

  // (3) THE BLOCK. Three named refusals (see the resolver's docblock for why these are
  // not one bare null).
  //
  // ⚠️ THIS COMMENT USED TO SAY "One query", AND THAT WAS WRONG — corrected because the
  // number is what the next person will price a change against. The schema does NOT
  // enable Prisma's `relationJoins`, so each nested to-one relation in a `select` is a
  // SEPARATE round trip: this resolve is THREE (the block row, its `app` for the owner
  // id, its `appListing` for the audit-only status). `resolveAppAccess` below re-reads
  // the same block with the same two relations, and the owner-ban read is a fourth
  // statement.
  //
  // ⚠️ THE WHOLE-RESOLVE FIGURE THIS COMMENT FIRST GAVE — "~7" — WAS ALSO WRONG, and
  // recording that matters because it was itself the correction to an earlier wrong
  // number and it forgot the viewer read added in the same change. Counted statement by
  // statement:
  //     moderator  4  = block 3 + viewer 1
  //     owner      8  = block 3 + viewer 1 + resolveAppAccess 3 + owner-ban 1
  //     editor     9  = the owner path + `hasAcceptedSeat` 1
  // All are single-row index lookups (`blockId` is unique, `id` is the pk), so the cost
  // is round-trip COUNT, not plan quality, and at this surface's volume — moderators and
  // owners of a handful of delisted apps — it is accepted rather than optimised. Dropping
  // the audit-only `appListing` relation is the cheapest single win (−1 per resolve). `block-approval.service.ts` deliberately avoids the same mechanism ten
  // lines from a near-identical select; if this surface ever gets real traffic, that is
  // the pattern to copy.
  //
  // 🔴🔴 OPERATOR RULING, 2026-10-01 — D4 BINDS PRE-APPROVAL ONLY. THIS IS A DECISION,
  // NOT AN OVERSIGHT AND NOT A TODO.
  //
  // The `approved` refusal below is also the reason the W14 per-listing visibility feature's
  // owner-invisibility guarantee STOPS AT THE APPROVAL BOUNDARY. A listing may be set to
  // `visibility: 'moderators'` at any eligible status (see `maxVisibilityForStatus`). On a
  // `draft`/`pending` listing a moderator's review run falls through to this predicate, is
  // admitted, mints the verified `privateRun` claim, and every owner-invisibility rail fires
  // — the analytics reads, the spend attribution, the author-fee payee resolver and the
  // `blockRenders` writer skip. On an `approved` listing it CANNOT: the public path owns that
  // status unconditionally, no claim is minted, and so:
  //
  //   🔴 A MODERATOR REVIEWING AN APPROVED LISTING SET TO `moderators` IS DEBITED BUZZ, AND
  //      THE PUBLISHER IS CREDITED THE AUTHOR FEE. The run also appears in that owner's
  //      analytics and spend attribution, exactly like any other run.
  //
  // Accepted on two grounds. The app is already APPROVED and publicly runnable by anyone
  // holding its slug, so the run is genuinely indistinguishable from real usage — the level
  // governs store DISCOVERY, not run access. And the alternative was to give the author-fee
  // payee resolver a second arm that consults the listing's level, which puts a blocking
  // listing read on the generation hot path; the readers on that path are fail-open by
  // contract precisely so they can never take a generation down.
  //
  // Narrowing D2 instead — refusing `moderators` on an approved listing — was considered and
  // REJECTED: the owner keeps free choice within the enum.
  //
  // 🔴 DO NOT "COMPLETE" THIS BY WIRING THE LISTING LEVEL INTO THE EXCLUSION RAILS. Those
  // rails are deliberately AUDIENCE-BLIND: they key on this one verified claim and nothing
  // else. Teaching any of them about `app_listings.visibility` reverses a ruling rather than
  // fixing a bug, and it is guarded —
  // `__tests__/app-listing-visibility.d4-ruling.test.ts` fails if a visibility symbol
  // appears in any of them. Revisit the ruling first.
  const resolved = await BlockRegistry.resolvePrivateRunPageBlock(by, { db: pool });
  if (!resolved.ok) return { allowed: false, reason: resolved.reason };
  const block = resolved.block;

  // (3.5) THE AUTHORITATIVE VIEWER RE-READ. The session check at (2) is a cheap
  // pre-filter, not the decision: a `SessionUser` may or may not carry `deletedAt`
  // depending on the auth path.
  //
  // ⚠️ IT LIVES IN THE PREDICATE RATHER THAN THE MINT, AND THAT IS THE FIX FOR AN
  // SSR↔MINT ASYMMETRY — in the one feature built to prevent those. The mint performed
  // this read and the SSR route did not, so a soft-deleted viewer whose session lacked
  // `deletedAt` got a FULL RENDER of a delisted app (name, page title, iframe origin,
  // declared scopes) and only then failed at the mint. No token, so the app could not
  // boot — but the single place the two callers disagreed produced a DISCLOSURE rather
  // than a refusal. Moving it in also removed one of four near-identical copies.
  //
  // 🔴 PLACED AFTER THE BLOCK RESOLVE, NOT BEFORE IT, AND THAT ORDER IS A COST DECISION.
  // It sat before it first, which DOUBLED the round trips on the `no-app` refusal — the
  // one refusal whose input space is UNBOUNDED and enumerable (any `page_<garbage>` id),
  // and therefore the one a prober drives. Nothing is emitted before either return, so
  // the ordering is unobservable to a caller; and the property the docblock claims for
  // gate (2) — "a signed-out prober cannot consume a query per slug" — is bought by the
  // FREE session pre-filter above, not by this read.
  //
  // 🔴 AND IT READS THE PRIMARY UNCONDITIONALLY, ignoring the caller's pool. This is a
  // SECURITY gate on a fact that changes the instant an account is banned or deleted, so
  // the replica's lag window is exactly the interval in which the answer matters most: a
  // just-banned viewer retrying. The SSR caller passes `db: 'read'` because its OTHER
  // reads are a render projection where lag is harmless; this one is not, so it opts out.
  // Without this the paragraph above would be FALSE on the very surface the move was for
  // — which review caught, and which is why the word "authoritative" now costs a
  // deliberate divergence from the caller's pool rather than being a claim about nothing.
  const viewerRow = await dbWrite.user.findUnique({
    where: { id: viewer.id },
    select: { deletedAt: true, bannedAt: true },
  });
  if (!viewerRow || viewerRow.deletedAt || viewerRow.bannedAt) {
    return { allowed: false, reason: 'viewer-ineligible' };
  }

  // (4) ROLE. A MODERATOR short-circuits the role resolve: `isModerator` is the
  // server-stamped session flag (the same authority the page mint's own moderator
  // branch uses, and which "can't be spoofed" per its comment), and a moderator is
  // typically neither the owner nor a collaborator — so requiring a role row would
  // refuse the audience this feature exists for.
  //
  // 🔴 THE MODERATOR CHECK IS *NOT* AN `isAppBlocksAuthorEnabled` CHECK. That flag
  // asks "is this caller an app author", which refuses a moderator who has never
  // published an app. It must not be composed into this path.
  let audience: PrivateRunAudience;
  if (viewer.isModerator === true) {
    audience = 'moderator';
  } else {
    // The REAL resolver, imported here rather than at module scope — see the import
    // block for why the edge is deferred and why that does not weaken anything.
    const { resolveAppAccess } = await import('~/server/services/blocks/app-access.service');
    const access = await resolveAppAccess(block.appBlockId, viewer.id, db);
    // `null` covers a dangling `app_id` (the real resolver fails closed on it), a
    // stranger, and a PENDING or REJECTED seat — the `ACCEPTED` filter is the consent
    // gate and is not widened here.
    if (!access || access.role == null) return { allowed: false, reason: 'no-role' };
    // 🔴 AN ASSIGNMENT, NOT A TERNARY, AND THE CHANGE IS A GUARD RATHER THAN A TIDY-UP.
    // This used to read `access.role === 'owner' ? 'owner' : 'editor'`, which rewrote a
    // value into itself: a non-null `AppAccess['role']` is exactly
    // `AppRole = 'owner' | 'editor'`. Because `AppRole` is a SUBSET of
    // `PrivateRunAudience` — asserted at compile time by `_appRoleSubsetWitness`, not by
    // how the union happens to be spelled — this line type-checks as a direct
    // assignment. (This comment used to say the type "is now declared as
    // `AppRole | 'moderator'`"; that declaration was reverted in the round-2 fixes and
    // the subset witness is what actually carries the property.) And a
    // future THIRD `AppRole` becomes a COMPILE ERROR here instead of being silently
    // collapsed into `'editor'`. That collapse would have been safe on power (editor is
    // the read-only audience) and wrong on truth: it would mislabel the mint's audit
    // line and the chrome copy for a role nobody had considered.
    audience = access.role;
  }

  // (5) PUBLISHER BAN — owner and editor only; moderators keep access by design.
  //
  // 🔴 THIS IS REQUIRED BECAUSE THE RUNTIME BAN MARKERS ARE TIME-BOXED. A publisher
  // ban arms Redis revocation markers (including `page_<appBlockId>`, which a
  // private-run token inherits for free by reusing that instance-id namespace), but
  // those markers expire after `MAX_BLOCK_TOKEN_LIFETIME_SECONDS` — measured 14400s,
  // i.e. 4 hours. After that window nothing downstream stops a MINT, so the only
  // durable refusal is this one. Making the ban durable at the row level is a
  // separate, already-tracked change; until then this branch is the gate.
  //
  // Keyed on the resolved OWNER's ban state, not the viewer's — the viewer was
  // already checked at (2). An editor is refused when the OWNER is banned even
  // though the editor personally is not: the app itself is what the ban took down.
  if (audience !== 'moderator' && block.ownerUserId != null) {
    const owner = await db.user.findUnique({
      where: { id: block.ownerUserId },
      select: { bannedAt: true },
    });
    if (owner?.bannedAt) return { allowed: false, reason: 'owner-banned' };
  }

  // (6) DEPLOY GATE — LAST, deliberately (see the order note above).
  //
  // 🔴 THE PUBLIC MINT'S EQUIVALENT ANSWERS `409 'Block is not yet deployed'`; THIS
  // ONE MUST NOT. A 409 here would be an existence oracle — it separates "this slug
  // exists but is undeployed" from "no such slug" for anyone who can reach the route.
  // The caller maps this to the same bare refusal as every other reason.
  if (block.currentVersionDeployedAt == null) {
    return { allowed: false, reason: 'not-deployed' };
  }

  // (7) NOTHING TO HOST. A resolved app whose manifest carries no usable `iframe.src`
  // has no origin to point the host at.
  //
  // ⚠️ THIS MOVED IN FROM THE SSR ROUTE, for the same reason the viewer re-read did: the
  // route refused on it AFTER calling the predicate and the mint never refused on it at
  // all, so the two callers could disagree — SSR 404s while the mint issues a token for
  // a page nobody can reach. That is the polarity the seam's own docblock names as the
  // second failure direction ("a token is mintable for a page nobody can reach"), and a
  // capability with no UI and no audit trail is worth closing even though it moves no
  // money. Both callers now inherit it.
  if (!block.iframeSrc) {
    return { allowed: false, reason: 'no-iframe-src' };
  }

  return { allowed: true, audience, block };
}
