import { dbRead, dbWrite } from '~/server/db/client';
import type { SessionUser } from '~/types/session';
import { BlockRegistry } from '~/server/services/block-registry.service';
import type { PrivateRunPageBlockResolution } from '~/server/services/block-registry.service';
// 🔴 `resolveAppAccess` IS IMPORTED DYNAMICALLY, AT ITS CALL SITE, AND ONLY THE TYPE IS
// STATIC. It is still the REAL function — a dynamic import changes WHEN the module
// loads, never WHICH function runs, so the anti-drift property this whole file rests on
// is untouched.
//
// Two reasons, and the first is a measured breakage rather than a preference:
//  1. `app-access.service` pulls a heavy graph — `app-listing-assets.service` →
//     `app-listing.service` → `cache-helpers` → `createLogger`, which reads
//     `env.LOGGING` AT MODULE SCOPE. A static edge from this file therefore drags that
//     initialisation into every consumer of the private-run predicate, including the
//     page-token mint, and it threw in two existing mint suites the moment the edge
//     existed. That is a real signal about the edge, not a test-fixture problem to
//     paper over: the mint is the app-launch critical path and had no such dependency.
//  2. The flag ships BASE-OFF, so in production today every request refuses at gate (1)
//     before any role resolve. A static import would make every one of them pay to load
//     that graph in order to do nothing. The mint's own neighbours already apply exactly
//     this pattern for exactly this reason ("dynamic import so the flag module isn't
//     eager-loaded on the prod-mint import path").
//
// `import type` is erased, so the `AccessDb` type below creates NO load-time edge.
import type { AccessDb } from '~/server/services/blocks/app-access.service';
import type { PrivateRunAudience } from '~/shared/constants/block-scope.constants';

/**
 * THE ONE ACCESS PREDICATE FOR A PRIVATE RUN OF A DELISTED / SUSPENDED APP.
 *
 * ── WHY THERE IS EXACTLY ONE, AND WHY BOTH CALLERS MUST USE IT ────────────────
 * 🔴 THE DEFECT THIS FILE EXISTS TO PREVENT IS AN SSR↔MINT ASYMMETRY, AND THAT
 * DEFECT HAS ALREADY HAPPENED ONCE ON THIS EXACT SURFACE. The dev-tunnel SSR route
 * mounts an owned app at ANY status (`resolveDevPageBlockForAuthor`), while the page
 * mint required `status: 'approved'` (`resolvePageBlock`) — so the page rendered and
 * then could not authenticate, and `tryDevTunnelOwnedNonApprovedMint` exists purely
 * to close that gap after the fact. Its own docblock records the asymmetry. A second
 * surface with two independently-written gates would regrow it.
 *
 * So: the SSR resolver and the PHASE 3 mint branch call THIS, and nothing else
 * decides who may privately run a delisted app. `private-run-access.call-site-ledger`
 * pins that there are exactly two callers, and a behavioural test drives one fixture
 * through both and asserts they agree — because a structural ledger type-checks past
 * a wrong argument.
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

/** Ordered exactly as the predicate evaluates them; see `resolvePrivateRunAccess`. */
export type PrivateRunRefusalReason =
  | 'flag-off'
  | 'viewer-ineligible'
  | 'no-app'
  | 'approved'
  | 'not-a-page'
  | 'no-role'
  | 'owner-banned'
  | 'not-deployed';

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
 *  2. `viewer-ineligible` — anonymous, banned or soft-deleted VIEWER. Before the app
 *     read so a signed-out prober cannot consume a query per slug.
 *  3. `no-app` / `approved` / `not-a-page` — the block resolve (one query).
 *     `approved` is tested BEFORE the role resolve so the approved case costs no
 *     second query, and because the public path owns it unconditionally: no role can
 *     make an approved app a private-run case.
 *  4. `no-role` — the shared role resolve. A moderator short-circuits it (the
 *     server-stamped session flag), so a mod who is neither owner nor collaborator
 *     still gets in — the audience the whole feature exists for.
 *  5. `owner-banned` — for the `owner` and `editor` audiences ONLY. Moderators keep
 *     access to a banned publisher's app deliberately: reviewing what a banned
 *     publisher shipped is the job. Placed AFTER the role resolve because it needs
 *     the audience to know whether it applies at all.
 *  6. `not-deployed` — LAST, and the placement is the whole reason its guard is
 *     testable. A private run serves the app's DEPLOYED bundle; an app with
 *     `currentVersionDeployedAt == null` has no origin behind it, so the iframe would
 *     time out and pollute the render metrics. If this sat before the role resolve,
 *     the "unrelated viewer + undeployed app" fixture would kill its mutant for the
 *     WRONG reason and the guard would never be shown to work on its own terms.
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

  // (3) THE BLOCK. One query; three named refusals (see the resolver's docblock for
  // why these are not one bare null).
  const resolved = await BlockRegistry.resolvePrivateRunPageBlock(by, { db: pool });
  if (!resolved.ok) return { allowed: false, reason: resolved.reason };
  const block = resolved.block;

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
    audience = access.role === 'owner' ? 'owner' : 'editor';
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

  return { allowed: true, audience, block };
}
