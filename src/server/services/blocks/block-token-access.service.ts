import { TRPCError } from '@trpc/server';
import { sessionClient } from '~/server/auth/session-client';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import type { SessionUser } from '~/types/session';

/**
 * THE App-Blocks kill-switch for every BLOCK-TOKEN-authed runtime caller, on BOTH
 * front doors — the tRPC bridge procs in `blocks.router.ts`
 * (estimate/submit/poll/cancelWorkflow, updateUserSettings, `getMyViewer`, …) and
 * the REST handler `src/pages/api/v1/blocks/me.ts`.
 *
 * 🔴 WHY IT LIVES IN A SERVICE RATHER THAN IN `blocks.router.ts`, WHERE IT USED TO.
 * `/api/v1/blocks/me` and `blocks.getMyViewer` are two front doors to ONE capability
 * and their docblock claimed they mirrored each other; they did not — `me.ts` carried a
 * hardcoded `if (!user.isModerator)` 403 and NO flag gate, while `getMyViewer` had the
 * flag gate and no mod literal. Masked while the Flipt audience was mods-plus-a-cohort;
 * it would have diverged for every newly admitted user at the GA widen. The fix is not
 * a second copy of this predicate in the REST route — an open-coded predicate is how the
 * two came to disagree — so the function moved here and BOTH callers import it. A REST
 * route cannot import `blocks.router.ts` (it would drag the whole tRPC router into a
 * Next API bundle), which is why a plain service module and not an export from there.
 *
 * 🔴 THE SAME-NAMED TWIN IN `apps.router.ts` IS A DELIBERATE, DOCUMENTED DIVERGENCE — and
 * this paragraph is the CURRENT half of a pointer pair whose other half is stale.
 * `apps.router.ts`'s `assertAppBlocksEnabledForTokenUser` additionally takes a `StorageOp`
 * and increments `appStorageOpsCounter` on BOTH of its refusals, where this one takes only
 * a userId and counts nothing; its unhydratable-subject message is also
 * `'block token subject could not be resolved'` — a strict PREFIX-free substring of this
 * module's `'runtime block token subject…'`. Keep all of that when reconciling the two.
 * ⚠️ `apps.router.ts` names `blocks.router` four times (lines 40, 105, 112, 114, across two
 * docblocks); THREE of them — 105, 112, 114 — are about THIS function and are now stale.
 * Line 40 is about `assertViewerIsAppDeveloper`, which did NOT move and is still correct.
 * The three were left stale ON PURPOSE: that file is already prettier-dirty on `main`, so
 * editing one comment reformats ~780 unrelated lines of a security-sensitive storage
 * router. 🔴 Note they all write `blocks.router's`, never `blocks.router.ts`, so grepping
 * the filename there returns NOTHING and the staleness is invisible to the obvious search.
 * The fact is recorded HERE instead, in a file the move already touched, so a reconciler
 * who follows the stale pointer and finds nothing has somewhere current to land.
 *
 * WHY IT EXISTS AT ALL — `enforceAppBlocksFlag` (the middleware) evaluates the flag
 * against `ctx.user` (the request's SESSION user). The tRPC callers are
 * `publicProcedure` authenticated by a BLOCK JWT, NOT a civitai.com session: a
 * page-host call carries a session, but a `dev:live` (localhost) call is
 * block-token-only and has NO session cookie → `ctx.user` is `undefined`. The
 * live `app-blocks-enabled` flag is base-`false` with a `moderators` segment, so
 * a no-user (global) eval can never match the segment → resolves `false` →
 * UNAUTHORIZED "App Blocks not enabled", even when the token's subject IS a
 * moderator. The flag must therefore be evaluated against the TOKEN's subject
 * user, not `ctx.user`.
 *
 * The flag stays a real kill-switch (a flip still shuts these procs down) — we
 * only fix the IDENTITY it's evaluated against. This does NOT widen access: with
 * the flag base-`false` + `moderators`/cohort segments as it is today, it resolves
 * `true` only for an in-segment subject and a non-mod outside the cohort resolves
 * `false` → blocked.
 *
 * 🔴 CALLER CONTRACT, AND IT IS NOW A CONVENTION RATHER THAN A FILE-LOCAL INVARIANT.
 * `userId` MUST be the SELF-BOUND token subject — `parseSubjectUserId(claims.sub)` on a
 * verified token — never a value derived from client input. While this was a
 * module-private function in `blocks.router.ts` that was checkable by reading one file;
 * exported, it takes a bare `number` and nothing mechanical pins it (the bridge's
 * reachability guard, `no-unguarded-block-bridge-token.test.ts`, computes reachability
 * INSIDE `blocks.router.ts` only and names "verification performed in a module this file
 * does not read" as an explicitly open limit). Hand it an id from a request body and the
 * kill-switch is evaluated against a user who is not the token subject — which is not a
 * refusal bypass, but it IS the wrong audience decision. Both current callers self-bind;
 * a third must too.
 *
 * AN ANONYMOUS TOKEN (`sub:'anon'`) NEVER REACHES THIS FUNCTION. Every caller runs
 * `parseSubjectUserId(claims.sub)` and refuses on `null` first, so the no-subject case
 * handled below is a VANISHED user, not an anon caller. 🔴 NO CALL-SITE COUNT IS
 * RECORDED HERE, AND NONE SHOULD BE: the figure was wrong four rounds running, each
 * time by writing one down, and it went stale again the moment the REST route joined.
 * A grep for either identifier also matches this docblock's own prose, the import at
 * each call site, and a DIFFERENT function of the same name in `apps.router.ts` — so
 * the obvious re-derivation returns too many. Enumerate the call sites if you need the
 * number; what is invariant, and what this paragraph is actually for, is that no caller
 * reaches this gate with an unparsed or anonymous subject.
 *
 * WHAT EACH CALLER HAS ALREADY SPENT BEFORE THIS RUNS. Three belts are common to both
 * doors — token validity, per-instance revocation, and the backing app still `approved`
 * (`authorizeBlockBridgeToken` on the tRPC side, `withBlockScope` on the REST side).
 * ⚠️ THE SETS ARE NOT EQUAL, AND AN EARLIER DRAFT OF THIS SENTENCE SAID THEY WERE. The
 * REST wrapper additionally runs `enforceContextBinding` (`block-scope.middleware.ts`,
 * its only call site in `src/`). The bridge has no equivalent, so the REST door is the
 * STRICTER of the two — but note WHAT it is stricter about, because #5063 narrowed half
 * of it and this sentence used to overstate the other half:
 *   - UNKNOWN scopes: deny-by-default over EVERY scope on the token. Unchanged, still
 *     token-wide. An unknown scope string 403s on REST and is admitted on the bridge.
 *   - REQUEST-SHAPE bindings (`models:read:self` must match the request's `?id`, the
 *     `:self` scopes need a non-anon subject): run for the route's OWN `requiredScope`
 *     ONLY. Since #5063 a token "carrying extra scopes" is NOT refused on their account
 *     — that was the defect, not the feature. The extra scope must be the one the route
 *     requires for its binding to have any say.
 * Do not read "shares this gate" as "same pre-belt set".
 * Every other belt (the per-scope consent checks, budget cap, daily Buzz cap, the
 * per-(user, app) consent budget, reserveBlockBuzzSpend, getOrchestratorToken,
 * forced-SFW) is unchanged — this gate only decides which identity the FLAG sees.
 *
 * Resolves the FULL server-side SessionUser via `sessionClient.getSessionUserById`
 * (the hub-backed resolver; never a client-supplied value) so the segment match
 * can't be spoofed AND every property `buildFliptContext` consumes is real.
 *
 * ## Why the full SessionUser, not a trimmed `{ id, isModerator }` cast
 *
 * `isAppBlocksEnabled({ user })` feeds `user` to `buildFliptContext`, which
 * reads `id`, `isModerator`, AND `tier` (deriving `isMember` from `tier`). A
 * trimmed `getUserById({ select: { id, isModerator } })` cast to SessionUser
 * (the #2740 shape) leaves `tier` undefined → the Flipt context carries the
 * type-default `tier:'free'` / `isMember:'false'` instead of the user's real
 * subscription tier. That is correct TODAY only because the live
 * `app-blocks-enabled` flag segments solely on `isModerator`. The moment the
 * flag is widened to segment on `tier`/region, a stale-`free` context would
 * silently mis-gate a paying user. Resolving the real SessionUser here (whose
 * `tier` is derived from the highest active subscription — not a User column,
 * so it CANNOT be fetched by widening the select) makes the gate stay correct
 * across any future widening. Pre-GA security review hardening.
 */
export async function assertAppBlocksEnabledForTokenUser(userId: number): Promise<void> {
  // Full, authoritative SessionUser (cached; tier derived from active
  // subscriptions) so buildFliptContext sees the user's REAL tier/isMember, not
  // type-defaults. getSessionUserById returns the package SessionUser (loosely
  // typed at this boundary — cast as bearer-token.ts does) or null for a vanished
  // user. This is the LAST identity-shaped belt on most runtime procs now that the
  // author gate is off them, so its fail-closed posture is not backed up by a
  // second one — do not weaken it.
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  // 🔴 REFUSE AN UNHYDRATABLE SUBJECT OUTRIGHT, before the flag is consulted.
  // This used to pass `{ user: user ?? undefined }`, and the comment derived the
  // denial from "global eval → flag false → blocked". The premise holds (a no-user
  // eval carries entityId 'global' and an empty context, which no segment can
  // match) but the conclusion came from `app-blocks-enabled` being base-`false`,
  // not from the segment miss: a global eval returns the flag's own base value, so
  // a base-`enabled: true` GA flip would have let a token whose subject no longer
  // resolves through this gate. `isAppBlocksEnabled`'s no-user branch is KEPT for
  // its real machine caller, so the refusal has to live here. Mechanism + the
  // measurement against the real wasm engine: GLOBAL-EVAL SEMANTICS in
  // `app-blocks-flag.ts`. Distinct message so the two refusals stay separable.
  //
  // 🔴 WATCHLISTED as `block-token-subject-refusal` in
  // `scripts/compiled-branch-watchlist.mjs`. Unlike a type-level guard, this is a pure
  // runtime branch, so a bundler that drops it re-opens the exposure with the source
  // still correct — which is precisely what shipped in release 5.1.18 (civitai#3983).
  // MOVING this branch WITHIN its module is fine — the gate resolves its anchor from
  // source at run time, so line numbers do not matter. 🔴 MOVING IT TO ANOTHER MODULE IS
  // NOT: the watchlist entry pins `module:`, and this comment asserted the unqualified
  // "moving is fine" right up until the function was moved HERE out of
  // `blocks.router.ts`, at which point both anchors resolved to zero lines in the pinned
  // module. Update `module:` in the same commit as any such move.
  // DELETING it fails the production Docker build at
  // `assert-compiled-branches.mjs`. And 🔴 REWORDING THE MESSAGE BELOW IS A WATCHLIST
  // EDIT: that exact string IS this entry's anchor, so changing it makes the gate exit 2
  // ("no line contains this anchor") — a failure that reads like gate breakage rather
  // than like the copy change that caused it. Update the entry in the same commit.
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'runtime block token subject could not be resolved',
    });
  }
  if (!(await isAppBlocksEnabled({ user }))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
  }
}
