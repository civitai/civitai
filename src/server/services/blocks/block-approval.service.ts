import { dbRead } from '~/server/db/client';
import type { AppBlockRestApprovalRefusal } from '~/server/metrics/app-block-runtime.metrics';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * WHY THIS IS ITS OWN MODULE rather than a private function inside
 * `block-scope.middleware.ts`. The middleware is imported by test harnesses and by
 * tooling that only want its pure routing helpers (`normalizeEndpoint`,
 * `enforceContextBinding`, `verifyBlockToken`), and a top-level `dbRead` import there
 * would make a working Prisma client a load-time prerequisite for all of them. The
 * middleware's own `loadAllowedOrigins` dodges that with a dynamic `await import`; a
 * separate module does the same job AND gives the five existing `withBlockScope` suites
 * a single one-line `vi.mock` seam — the same seam they already use for
 * `block-revocation.service`, which is the sibling check this one sits next to.
 */

/**
 * THE APPROVED-STATUS GATE for the REST half of the App Blocks runtime — the
 * counterpart of `assertAppBlockApproved` in `block-bridge-auth.service.ts`, which
 * does the same job for the tRPC bridge.
 *
 * WHY IT EXISTS. `verifyBlockToken` answers ONE question — is this a token we signed,
 * for this issuer/audience, not yet expired. Revocation — the check that runs one step
 * before this one at the call site in `withBlockScope` — answers a second: has the
 * INSTALL been torn down. Neither can see a MODERATOR SUSPENSION, because the two
 * takedown signals are deliberately disjoint:
 *
 *   - REVOCATION is written by uninstall and toggle-off only (`block-registry.service`).
 *   - `app_blocks.status` is flipped by mod delist and owner unpublish
 *     (`flipBackingBlockStatus`, `offsite-moderation.service`), which writes NO
 *     revocation marker — and must not, because conflating a moderator action with a
 *     user action would change uninstall semantics.
 *
 * So until this gate existed, a suspended app kept serving every `withBlockScope`
 * route for the remaining life of any already-minted token, while the tRPC bridge
 * refused.
 *
 * THE SIZE OF THAT, and the two claims are of DIFFERENT strengths — stated separately
 * because merging them would overstate the weaker one:
 *   - TRACED, by reading each call graph at the commit that added this: of the 13 page
 *     routes that wrap `withBlockScope`, 11 have nothing anywhere below them that reads
 *     `app_blocks.status`. The two that do — `shared-storage/top` and
 *     `shared-storage/increment` — refuse INCIDENTALLY, because they delegate to
 *     `resolveSharedContext`, which reads the status itself. They now refuse here first,
 *     one step earlier and for the stated reason.
 *   - EXECUTED, in `src/tests/api/v1/blocks/suspended-app-rest-refusal.test.ts`, on the
 *     two that carry a real side effect: at the base revision, a suspended app driving
 *     `POST /api/v1/blocks/tip` CALLED `createBuzzTipTransactionHandler`, and one driving
 *     `POST /api/v1/blocks/collections/:id/follow` CALLED `addContributorToCollection`.
 *     Not inferred from the wrapper — the spies recorded the calls.
 *
 * THE WINDOW THIS CLOSES IS BOUNDED, AND SAYING SO IS PART OF THE JUSTIFICATION. The
 * mint endpoint already requires `status === 'approved'`
 * (`src/pages/api/v1/block-tokens/index.ts` — "Block is not approved"), so a
 * suspended app can never obtain a NEW token. What was open was the tail of the tokens it
 * already held: 900s default, 300s settings-scoped, 4h dev
 * (`src/server/services/block-token-lifetimes.ts`). Fifteen minutes of Buzz leaving an
 * account through an app a moderator has just taken down is the case this is for.
 *
 * 🔴 THE ONE EXEMPTION — `claims.dev === true`, the same predicate `assertAppBlockApproved`
 * applies on the bridge, and chosen so the two paths cannot drift rather than re-decided
 * on its own merits. Run-for-real moderator REVIEW tokens are `dev: true`, and review is the one
 * surface that MUST work on a NON-approved app; the owner dev-tunnel mint (#3285) signs
 * a real `apb_` id for an app that is deliberately suspended/pending/deprecated so its
 * owner can diagnose it back into review; and the pending / local-manifest / review
 * mints sign a synthetic `pubreq_…` / `page_local_…` / `ephemeral-…` id with no backing
 * row to be approved at all. A gate without this exemption breaks all three. Dev tokens
 * remain revocable (every such mint stamps a revocable instance id, and the revocation
 * check at the call site is NOT exempted), mod/dev-cohort gated at mint, forced-SFW and
 * budget-capped.
 *
 * 🔴 HOW THIS RECONCILES WITH THE OTHER TWO RESOLVERS, which apply visibly different
 * rules — they are not three policies, they are one policy plus two structural
 * narrowings, and reading them as policy disagreements is the mistake to avoid:
 *   - `resolveStorageContext` (apps.router) exempts ONLY `reviewRunForReal`, not `dev`
 *     generally. Per-user KV has to resolve to a real Postgres SCHEMA; a plain dev token
 *     names no schema that exists, so there is nothing a wider exemption could route to.
 *   - `resolveSharedContext` (apps-shared.router) exempts nothing. Shared storage is
 *     cross-user, app-global state, and run-for-real never grants
 *     `apps:storage:shared:*` at all — so again there is no case to exempt.
 * Both are STRICTER than this gate for a reason about their target, not about approval.
 *
 * 🔴 POSTURE: FAIL-CLOSED, which is the OPPOSITE of the revocation check that runs one
 * step before it, and the difference is deliberate. `BlockRevocation.isRevoked` fails OPEN by
 * construction — a Redis incident must not take every block down, and the exposure is
 * bounded by the token lifetime instead of by Redis recovery time. This gate is a DB
 * read, and a replica it cannot reach leaves us unable to establish that the app is
 * still allowed to run at all, so it refuses (503). Two checks, two postures, on one
 * path; that is a property of the primitives, not an inconsistency.
 *
 * COST: one indexed `dbRead.appBlock.findUnique` on the `(appId, blockId)` unique, on
 * the replica, per block-JWT REST request. A dev token skips it entirely. The tRPC
 * bridge already pays exactly this per bridge call including `pollWorkflow`, so this is
 * the same bill on a lower-volume surface, not a new class of cost.
 *
 * WHAT IT DOES NOT BUY, stated because the gate is uniform and the value is not. The
 * clearest case is `/api/v1/models/:id`: it is dual-auth, and the block-JWT branch
 * differs from the anonymous one ONLY in skipping the origin cache — same builder, same
 * arguments, same body. Refusing a suspended app there removes NO exposure, because an
 * unauthenticated caller can already fetch that body. It inherits the gate to keep ONE
 * rule at ONE place, not because it was leaking. The unscoped catalog routes are the
 * same argument one step weaker — their bodies are public but maturity-clamped per
 * token, so a block does not get strictly nothing extra there.
 */
export async function resolveRestApprovalVerdict(
  claims: BlockTokenClaims
): Promise<'ok' | 'dev_exempt' | AppBlockRestApprovalRefusal> {
  if (claims.dev === true) return 'dev_exempt';
  try {
    const block = await dbRead.appBlock.findUnique({
      where: { appId_blockId: { appId: claims.appId, blockId: claims.blockId } },
      select: { status: true },
    });
    if (!block) return 'not_found';
    return block.status === 'approved' ? 'ok' : 'not_approved';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[block-scope] approved-status lookup failed; refusing: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return 'lookup_failed';
  }
}
