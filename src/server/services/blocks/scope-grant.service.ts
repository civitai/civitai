/**
 * A6 (audit HIGH / design-gaps C2) — per-user scope-grant consent.
 *
 * The consent ledger that closes the silent-scope-escalation gap. Token
 * issuance intersects the manifest/approved scope set with the user's granted
 * scopes for the app; a scope the app requests but the user has not granted is
 * withheld from the minted token and surfaced to the host as `needs_consent`.
 *
 * ⚠️ THIS HEADER SAID "Two write paths feed grants" UNTIL PER-SCOPE REVOKE SHIPPED.
 * THERE ARE NOW THREE, and the third one runs in the opposite direction:
 *   - install / subscribe (implicit first-consent) → `recordScopeGrant`
 *   - re-consent (the host surfaces the missing scopes; the user accepts)
 *     → `recordScopeGrant` again, which is additive (existing grants persist)
 *   - REVOKE (the viewer withdraws one permission on /apps/activity)
 *     → `revokeScopes`, which SUBTRACTS from `granted_scopes` and, crucially,
 *       ADDS to `revoked_scopes` — see that function for why removal alone does
 *       not hold.
 *
 * The read path (mint) is `getGrantedScopes`. A NULL/missing row means the
 * user has consented to nothing for this app (fail-closed → every scope
 * withheld). A non-NULL `revoked_at` is treated as an empty grant, and any scope
 * in `revoked_scopes` is subtracted from the granted set.
 *
 * 🔴 "NOTHING IN APPLICATION CODE EVER WRITES A NON-NULL `revoked_at`" WAS TRUE OF
 * EVERY EARLIER REVISION OF THIS FILE AND IS NOW RETRACTED. `revokeScopes` writes
 * one whenever a revoke empties the granted set. Comments elsewhere in the repo that
 * describe the revoked branch as unreachable, or as an "invariant guard", were
 * accurate when written and are wrong now; the ones this change could find are
 * corrected in place (`user-app-surface.service.ts`, the two Prisma schema files).
 *
 * `granted_scopes` is a set of block-scope strings (the SAME vocabulary as
 * app_blocks.approved_scopes / manifest.scopes — e.g. 'models:read:self'), so
 * the mint-time intersection is a direct set operation, not a bitmask op.
 */

import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { newAppUserScopeGrantId } from '~/server/utils/app-block-ids';

/**
 * The one scope in the vocabulary that can spend the viewer's Buzz, and therefore the
 * only one a `buzz_budget_per_day` bounds.
 *
 * Named rather than open-coded because a string literal repeated at N sites is a predicate
 * that will be wrong at N−1 of them the first time the vocabulary moves.
 *
 * ⚠️ NO COUNT AND NO LIST HERE, DELIBERATELY. This docblock once said "FOUR sites now branch
 * on it" and enumerated them, while `blocks.router.ts` alone still held ELEVEN identical
 * `claims.scopes.includes(...)` spend gates spelled as the literal. An enumeration covering 4
 * of 19 sites is worse than none — it stops the next person looking. Those eleven are swept;
 * `git grep "'ai:write:budgeted'"` is the authority on what remains.
 *
 * ⚠️ AND THE SURVIVORS ARE NOT WHAT THIS DOCBLOCK FIRST CLAIMED. It said they were "tag strings,
 * manifest keys and scope-LIST members"; in `blocks.router.ts` the four live ones are
 * `scope: 'ai:write:budgeted'` arguments passed to `recordScopeInvocation` — TELEMETRY LABELS
 * naming this same vocabulary item, which go silently wrong (mis-attributed activity rows) on
 * exactly the rename this constant exists for. Whether a value written to an audit store should be
 * coupled to the runtime constant is a judgement, not an obvious yes, so they are deliberately
 * left — but describing them as a different KIND of thing is checkably wrong, and a wrong
 * characterisation is what stops the next reader looking.
 *
 * ⚠️ THE CALL SHAPE IS SPELLED APART ABOVE ON PURPOSE. `analytics-bucket-labels.drift.test.ts`
 * greps RAW source for `recordScope` + `Invocation({` — comments included — to build a ledger of
 * files that CALL it. Writing the literal call shape in a COMMENT here therefore added this file
 * to that ledger and failed the guard. The guard should strip comments (it is in another slice);
 * rewording is the in-slice fix.
 */
export const CONSENT_SPEND_SCOPE = 'ai:write:budgeted';

/**
 * True for the ONE Prisma failure that means "this deploy is running ahead of its
 * migration": P2022 — the column named in the query does not exist in the database.
 *
 * Migrations in this project are applied BY HAND, per environment, so the image and
 * the schema are not deployed atomically and `buzz_budget_per_day` — or, since the
 * per-scope revoke landed, `revoked_scopes` / `revoked_scopes_at` — can legitimately
 * be absent from a database the current code is talking to. Every OTHER Prisma error
 * — connection loss, timeout, constraint violation — must still propagate: a bare
 * `catch` here would swallow real DB failures and silently return "no budget", which
 * is the fail-OPEN this whole feature exists to prevent.
 *
 * Narrow by CODE, not by message text. The message is a human string that upstream
 * is free to reword; the code is the contract.
 *
 * 🔴 `meta.code` IS CHECKED, AND IT WAS NOT — WHICH MADE EVERY TOLERANCE IN THIS MODULE
 * CONDITIONAL ON THE PRISMA ENGINE VERSION. `app-listing-source-repo.service.ts` carries a
 * same-named predicate that also matches `42703` and either code under `meta`, and its docblock
 * says why in words: 42703 "reaches us on a `$queryRaw` path **and is also what Prisma reports
 * in `meta.code` for some engine versions**" — on the TYPED client, which is all this module
 * uses. Its tests pin both shapes. This copy matched a bare `code === 'P2022'` only, so on such
 * an engine version: `readGrantRow`'s narrow retry never fires and the read 500s instead of
 * degrading to "nothing revoked", `revokeScopes` throws a raw 500 instead of
 * `PRECONDITION_FAILED` + `CONSENT_REVOKE_UNAVAILABLE_MESSAGE`, and `unrevokeData`'s whole
 * pre-migration branch is unreachable. Found by round-10 review, after this branch took the
 * predicate's consumers from **2 to 6 repo-wide (1 to 4 in this module)** — I did not write it, but
 * I multiplied what depends on it. ⚠️ An earlier draft said "2 to 4", which pairs the repo-wide
 * BEFORE with the in-module AFTER; either population is defensible, one of each is not.
 *
 * ⚠️ TWO COPIES OF ONE RULE, DELIBERATELY NOT CONSOLIDATED HERE. The sibling is in another
 * service with its own docblock and tests; unifying them is the right end state and is a
 * separate change. Closing condition: one exported predicate, both modules importing it, the
 * sibling's tests still green. Until then, a change to either MUST be mirrored — the narrow copy
 * is what produced the gap above, and a divergence regenerates it.
 */
export function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: unknown };
  if (e.code === 'P2022' || e.code === '42703') return true;
  if (e.meta && typeof e.meta === 'object') {
    const metaCode = (e.meta as { code?: unknown }).code;
    if (metaCode === '42703' || metaCode === 'P2022') return true;
  }
  return false;
}

/**
 * ONCE PER PROCESS, not once per deploy and not once globally — this is a
 * module-level boolean in one Node process, so a fleet of N pods emits up to N
 * lines and a restart re-arms it. That is deliberate and sufficient: the signal
 * wanted is "somebody is running ahead of the migration", which one line per pod
 * carries, and the alternative (a line per spend attempt) would bury it.
 *
 * `error` level on purpose. Reading past a missing column is CORRECT (see
 * `getConsentBuzzBudget`) but it is never an intended steady state — it means a
 * migration is outstanding, and the operator has to be told.
 */
let missingBudgetColumnLogged = false;
export function logMissingBudgetColumn(site: string, err: unknown): void {
  if (missingBudgetColumnLogged) return;
  missingBudgetColumnLogged = true;
  logToAxiom(
    {
      name: 'app-blocks-scope-grant',
      type: 'error',
      message:
        `app_user_scope_grants.buzz_budget_per_day is MISSING from this database — ` +
        `apply migration 20260910120000_app_user_scope_grant_buzz_budget. Consent budgets ` +
        `read as "not set" until it lands; the platform per-user daily Buzz cap still applies.`,
      site,
      code: (err as { code?: unknown } | null)?.code,
    },
    'webhooks'
  ).catch(() => {
    /* logging must never break a spend path */
  });
}

/**
 * ONCE PER PROCESS, exactly like {@link logMissingBudgetColumn} — see that function for
 * why per-process is the right cardinality and why this is `error` level.
 *
 * SEPARATE FLAG FROM THE BUDGET ONE ON PURPOSE. The two columns landed in different
 * migrations, so a database can legitimately have one and not the other, and a shared
 * flag would let whichever fired first suppress the other's line forever — leaving an
 * operator with the wrong migration name.
 */
let missingRevokedScopesColumnLogged = false;
export function logMissingRevokedScopesColumn(site: string, err: unknown): void {
  if (missingRevokedScopesColumnLogged) return;
  missingRevokedScopesColumnLogged = true;
  logToAxiom(
    {
      name: 'app-blocks-scope-grant',
      type: 'error',
      message:
        `app_user_scope_grants.revoked_scopes is MISSING from this database — ` +
        `apply migration 20260927120000_app_user_scope_grant_revoked_scopes. Per-scope ` +
        `revocations read as "none recorded" (the only state such a database can be in) ` +
        `and BOTH write halves refuse until it lands: the revoke mutation always, and a ` +
        `prompted RE-CONSENT whenever it does not cover every scope the row already granted ` +
        `(a whole-grant revoke cannot be migrated to per-scope suppressions without the column).`,
      site,
      code: (err as { code?: unknown } | null)?.code,
    },
    'webhooks'
  ).catch(() => {
    /* logging must never break a consent path */
  });
}

/**
 * The grant row as every READ in this module wants it: granted set, whole-grant revoke
 * flag, per-scope suppression list.
 *
 * 🔴 P2022-TOLERANT BY RETRY, NOT BY GUESSWORK. `revoked_scopes` is in a migration
 * applied BY HAND, so a running image can legitimately be talking to a database without
 * it. On P2022 this re-reads with the PRE-MIGRATION select and reports
 * `revokedScopes: []`. That is not a degraded fallback — if the column does not exist
 * then no revocation can ever have been recorded, so "none" is the TRUE and only
 * possible answer, and the behaviour is byte-identical to the world before this feature.
 * Any other Prisma failure still throws: for those the suppression list is UNKNOWN
 * rather than absent, and treating unknown as empty would be a fail-OPEN on a consent
 * gate.
 *
 * 🔴 THE RETRY COSTS A SECOND ROUND TRIP, AND "MID-MIGRATION" IS THE **DEFAULT STATE ON
 * DEPLOY**, NOT A NARROW WINDOW. This read "only in a database that is mid-migration" — true,
 * and it reads as rare. It is not: migrations here are applied by hand with nothing in CI or
 * the deploy running them, and review confirmed neither column exists on the production
 * cluster as this ships. So from deploy until a human applies it, EVERY call on the mint path,
 * the hub-claims path and the spend path pays two queries instead of one (three on the spend
 * path, which also reads the budget). The only signal is the once-per-process Axiom line
 * below. At current App Blocks volume that is free; the EXPECTATION was what was wrong.
 *
 * Post-migration it cannot fire: DDL replicates in the WAL, so a standby has the column as
 * soon as it replays; the only residual window is sub-second replay lag on `dbRead`.
 *
 * The alternative — always issuing the narrow select and widening later — would need a
 * process-wide "has the column" cache, i.e. state that is wrong for the whole window
 * either side of the ALTER.
 *
 * 🔴 DO NOT ADD `buzz_budget_per_day` TO THIS SELECT. It rides a DIFFERENT migration,
 * so folding the two together would make a database missing either column take this
 * file's fallback for both — and the mint path would then silently stop subtracting
 * revocations because a *budget* column was absent. `resolveConsentSpendPosture` reads
 * the budget, and takes its own P2022 branch for it.
 */
// Exported ONLY so `oauth-consent-sync.service.ts` can reuse it rather than clone it. It was
// private, and the clone that appeared two modules away was byte-level identical — same table,
// same where, same wide select, same P2022 test, same log, same narrow fallback — because this
// function was already parameterised by `client` and `site` for exactly that purpose.
export async function readGrantRow(
  client: typeof dbRead | typeof dbWrite,
  userId: number,
  appBlockId: string,
  site: string
): Promise<{ grantedScopes: string[]; revokedAt: Date | null; revokedScopes: string[] } | null> {
  const where = { userId_appBlockId: { userId, appBlockId } };
  try {
    return (await client.appUserScopeGrant.findUnique({
      where,
      select: { grantedScopes: true, revokedAt: true, revokedScopes: true },
    })) as { grantedScopes: string[]; revokedAt: Date | null; revokedScopes: string[] } | null;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    logMissingRevokedScopesColumn(site, err);
    const row = (await client.appUserScopeGrant.findUnique({
      where,
      select: { grantedScopes: true, revokedAt: true },
    })) as { grantedScopes: string[]; revokedAt: Date | null } | null;
    return row ? { ...row, revokedScopes: [] } : null;
  }
}

/**
 * `granted_scopes ∖ revoked_scopes`, with a non-NULL `revoked_at` collapsing to the empty
 * set — the ONE statement of what a grant row actually conveys.
 *
 * 🔴 IT IS A SHARED PROJECTION BECAUSE THE RULE HAD THREE HOMES AND ONE OF THEM WAS WRONG.
 * Review found `oauth-consent-sync.service.ts` reading the RAW `granted_scopes` column, so a
 * revoked scope was re-granted on the OAuth surface after any install re-unioned it; and the
 * permissions surface's copy carried the comment "🔴 MIRROR `getGrantedScopes` EXACTLY,
 * SUBTRACTION INCLUDED", which is the reliable tell that a rule has more than one home. The
 * mirror directly beside it (for the budget guards, "Mirror getConsentBuzzBudget's guards
 * EXACTLY") had ALREADY drifted — it omits `Number.isFinite` — and is inert only because the
 * column is an `Int?`. So: three statements, one wrong, one already drifted. Now one.
 *
 * Takes a ROW rather than two arrays so a caller cannot pass the granted set and forget the
 * other two fields — the exact omission that produced the OAuth hole.
 *
 * 🔴 `revokedScopes` IS OPTIONAL, and that is the pre-migration contract rather than
 * laxness: `readGrantRow`'s P2022 fallback and the permissions surface's stage-1 retry both
 * produce rows without it, on a database where the column does not exist and therefore no
 * revocation can ever have been recorded. `undefined` here means "none", which is the only
 * state such a database can be in — not a guess.
 */

export function liveGrantedScopes(row: {
  grantedScopes: string[] | null | undefined;
  revokedScopes?: string[] | null;
  revokedAt?: Date | null;
}): string[] {
  if (row.revokedAt) return [];
  const revoked = new Set(row.revokedScopes ?? []);
  return (row.grantedScopes ?? []).filter((s) => !revoked.has(s));
}

/**
 * The USABLE per-day consent budget on a grant row, or `null` when there is none.
 *
 * 🔴 DELIBERATELY BELOW `liveGrantedScopes`, NOT ABOVE IT. Inserting this between that
 * function's docblock and the function ORPHANED 22 lines of contract — including the
 * optional-`revokedScopes` pre-migration rule the OAuth mirror's P2022 fallback depends on —
 * onto this declaration instead, leaving `liveGrantedScopes` hovering undocumented. This file
 * already records the identical hazard on `WRITE_RETURN_SELECT` ("A docblock separated from its
 * function by another declaration documents that declaration instead") and it was walked into
 * anyway, three hundred lines later.
 *
 * 🔴 SHARED FOR THE SAME REASON `liveGrantedScopes` IS — and review found this rule had
 * ALREADY drifted between its two homes. `user-app-surface.service.ts` carried the comment
 * "Mirror getConsentBuzzBudget's guards EXACTLY" while omitting `Number.isFinite`, so the
 * display and the enforcement disagreed for a non-finite stored value. Inert today
 * (`buzz_budget_per_day` is an `Int?`, so `Infinity` cannot be stored, and `NaN > 0` is false
 * so NaN happens to agree) — but a comment asserting exactness beside an inexact copy reads as
 * coverage, which is worse than no comment.
 *
 * Guards the VALUE, not just its presence: a 0 or negative becomes a cap of 0 (deny
 * everything) and a NaN makes `total > NaN` always false, i.e. a corrupt row would silently
 * DISABLE the cap. Any unusable value reads as "no budget set", routing to the platform
 * ceiling — the behaviour every pre-column grant already had.
 */
export function usableConsentBudget(row: {
  buzzBudgetPerDay?: number | null;
  revokedAt?: Date | null;
}): number | null {
  if (row.revokedAt) return null;
  const budget = row.buzzBudgetPerDay;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return null;
  return Math.floor(budget);
}

/**
 * Returns the set of block-scope strings the user currently has granted for
 * the given app block: `granted_scopes` MINUS `revoked_scopes`. Empty set when there is
 * no grant row OR the whole grant has been revoked (fail-closed: mint withholds every
 * scope and signals consent).
 *
 * 🔴 THE SUBTRACTION IS DEFENCE IN DEPTH, AND IT IS LOAD-BEARING RATHER THAN BELT-AND-
 * BRACES. `recordScopeGrant` UNIONS its input into `granted_scopes`, and
 * `BlockRegistry.recordInstallConsent` feeds it the app's ENTIRE consent-gated effective
 * set unconditionally — so an install or subscribe AFTER a revoke puts the revoked scope
 * back into the granted array. Subtracting here is what makes that harmless: the array
 * may hold the scope, the grant does not convey it, and the next mint therefore puts it
 * in `partitionByConsent`'s `missing`, so the host surfaces `needs_consent` and the user
 * re-consents EXPLICITLY. An implicit install cannot resurrect a revoked permission.
 *
 * Deleting the subtraction is the mutation this file's install-resurrection test exists
 * to catch (`scope-grant.service.test.ts`, "recordInstallConsent does NOT resurrect…").
 */
export async function getGrantedScopes(opts: {
  userId: number;
  appBlockId: string;
  db?: 'read' | 'write';
}): Promise<Set<string>> {
  const client = opts.db === 'write' ? dbWrite : dbRead;
  const row = await readGrantRow(client, opts.userId, opts.appBlockId, 'getGrantedScopes');
  if (!row) return new Set();
  return new Set(liveGrantedScopes(row));
}

/**
 * Reads the per-(user, app) CONSENT BUDGET — the daily Buzz ceiling the viewer
 * themselves set for this app when they consented. `null` means the user set no
 * budget, in which case the app spends under the platform's own per-user daily
 * ceiling (`BLOCK_BUZZ_CAP_PER_DAY`) alone — the behaviour of every grant written
 * before the column existed.
 *
 * 🔴 A REVOKED GRANT STILL RETURNS `null` HERE, AND THE SPEND PATH NO LONGER READS
 * THIS FUNCTION. That is the fix for the inversion the next two paragraphs describe;
 * they are kept because the inversion is what the fix is FOR, not because it is live.
 *
 * ⚠️ RETRACTED AS A LIVE HAZARD, PRESERVED AS THE REASON. This paragraph used to end
 * "**the revoke drops the user's own ceiling BEFORE it drops the scope**", and that was
 * an accurate description of `reserveBlockBuzzSpendForClaims` at the time: it read this
 * function, saw `null`, and fell through to the platform ceiling
 * (`BLOCK_BUZZ_CAP_PER_DAY`) alone — so a user who set 500 Buzz/day on an app had that
 * LIFTED, not enforced, for the remainder of an already-minted token's life. (An earlier
 * revision than that said the opposite — *"a revoked user's token carries no
 * `ai:write:budgeted` and can reach no spend path at all"* — which is true only at the
 * NEXT MINT; block tokens are JWTs with no per-jti revocation and a 900s default lifetime,
 * 300s settings-scoped, 4h dev, per `block-token-lifetimes.ts`.)
 *
 * The spend path now calls {@link resolveConsentSpendPosture} instead, which reports
 * `revoked` as its OWN outcome, distinguishable from `no-budget`, and the reserve
 * function REFUSES on it. So `null` from this function means "no budget set" and nothing
 * else — 🔴 which is exactly why the revoked branch must keep returning it rather than
 * becoming a throw: the remaining callers (`oauth-consent-sync.service.ts`,
 * `listMyScopeGrants`' mirror of these guards) are DISPLAY / MIRROR paths where "no
 * ceiling to show" is the right answer for a grant that conveys nothing.
 *
 * `BlockRevocation` (`block-revocation.service.ts`) narrows the in-flight window — a
 * per-`blockInstanceId` Redis marker checked on the block-scope path — but read
 * what actually sets it before relying on it:
 *
 *  - 🔴 EXACTLY ONE CALL SITE EXISTS WHOSE *PURPOSE* IS REVOCATION, and it is new
 *    — this paragraph has already been wrong twice about what writes a marker.
 *    It first said `BlockRevocation` was "operator-invoked" (false), then that
 *    "there is no admin router, no tRPC procedure and no script" (also false, on
 *    the middle term), then that no call site's purpose was revocation (true
 *    until clawgate #618). What the tree shows now:
 *
 *    The INSTALL writer `revokeInstance` has two production call sites, both in
 *    `block-registry.service.ts` — `uninstallFromModel` and
 *    `toggleEnabled(false)` — and in both the marker is a SIDE EFFECT of a
 *    different operation. Both are reachable over tRPC (`blocks.router.ts`,
 *    `protectedProcedure`), and `assertCanManageBlocks` early-returns for
 *    moderators, so a moderator CAN cause a marker deliberately, against any
 *    user's install on any model. A SEPARATE writer, `revokeInstanceForBan`, has
 *    one call site — `revokeBlockInstancesForPublisher`
 *    (`blocks/publisher-ban-revocation.service.ts`, called from `toggleBan`) — and
 *    IS there to revoke: it marks every live instance of every block the banned
 *    user canonically owns, and leaves the installs themselves alone. The two use
 *    different Redis keyspaces so an install write can never overwrite a ban.
 *
 *    So: two routes to a marker carry a separate, user-visible outcome
 *    (uninstall / disable); the third is a moderation action against the
 *    publisher, not against the install.
 *
 *    🔴 HOW OFTEN THE MIDDLEWARE'S 403 BRANCH IS ACTUALLY EXERCISED IS NOT
 *    ESTABLISHED, AND THIS COMMENT NO LONGER GUESSES. Two successive drafts
 *    asserted it was HOT, each for a reason the next round refuted — first
 *    "a marker appears because a USER acted" (drawn from the false
 *    no-tRPC-procedure claim), then "ordinary users hit both paths routinely"
 *    (false: both mutations carry `enforceAppBlocksFlag`, and the live
 *    `app-blocks-enabled` flag is base-`false` with a moderators-only segment,
 *    so an ordinary user cannot reach either one). The conclusion outlived two
 *    dead justifications because each round replaced the reason and kept the
 *    claim.
 *
 *    🔴 DO NOT WRITE A THIRD. Nothing in this tree establishes the rate in
 *    either direction — it depends on live Flipt state and on install
 *    behaviour, neither of which is readable from source. If you need the
 *    number, measure it; do not derive it here.
 *  - it is per-INSTANCE, not per-user and not per-scope;
 *  - it FAILS OPEN (`isRevoked` swallows a Redis error and returns false);
 *  - writing `revoked_at` in Postgres sets no marker in THAT keyspace. ⚠️ "The two
 *    mechanisms do not know about each other" is now half-retracted: a per-scope
 *    revoke writes its OWN marker in a THIRD keyspace
 *    (`blocks/consent-revocation.service.ts`, `ConsentRevocation`), which the same
 *    middleware checks beside `isRevoked` and which FAILS CLOSED. `BlockRevocation`
 *    itself is still unaware of `revoked_at`, and deliberately so — see that module.
 *
 * ⚠️ THE REVOKED BRANCH IS REACHED BY ORDINARY PRODUCT USE. Two earlier revisions of
 * this paragraph are now both stale, and the sequence is worth keeping because each was
 * true when written. It first said nothing in the codebase ever SETS
 * `app_user_scope_grants.revoked_at`; it was then corrected to "only
 * `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql`, a committed,
 * hand-applied writer". Both are retracted: `revokeScopes` in this module sets a
 * non-NULL `revoked_at` whenever a user's revoke empties their granted set, and
 * `blocks.revokeScopes` exposes it to any authenticated viewer with the App Blocks
 * flag. This is no longer an operator-only state and must not be documented as one.
 *
 * 🔴 READS THE PRIMARY BY DEFAULT. This runs on the spend path, immediately after a
 * consent write that may have just LOWERED the budget: served off the replica, a
 * lag window would spend against the OLD, looser ceiling — the one direction a
 * money cap must never drift. The read is a single unique-index lookup.
 *
 * 🔴 A MISSING COLUMN (P2022) RETURNS `null`, AND THAT IS THE TRUE ANSWER, NOT A
 * FALLBACK. Migrations here are applied by hand, so an image can legitimately run
 * against a database that does not yet have `buzz_budget_per_day`. If the column
 * does not exist then no user can ever have set a budget — "no budget set" is not a
 * degraded guess, it is the only state the database can be in — and `null` routes to
 * exactly the same behaviour every pre-column grant already had: the platform's own
 * `BLOCK_BUZZ_CAP_PER_DAY` ceiling keeps enforcing, unchanged. Only P2022 is caught;
 * any other Prisma failure still throws, because for those the budget is UNKNOWN
 * rather than absent, and treating unknown as "no budget" would be a fail-open.
 */
export async function getConsentBuzzBudget(opts: {
  userId: number;
  appBlockId: string;
  db?: 'read' | 'write';
}): Promise<number | null> {
  const client = opts.db === 'read' ? dbRead : dbWrite;
  let row: { buzzBudgetPerDay: number | null; revokedAt: Date | null } | null;
  try {
    row = (await client.appUserScopeGrant.findUnique({
      where: { userId_appBlockId: { userId: opts.userId, appBlockId: opts.appBlockId } },
      select: { buzzBudgetPerDay: true, revokedAt: true },
    })) as { buzzBudgetPerDay: number | null; revokedAt: Date | null } | null;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    logMissingBudgetColumn('getConsentBuzzBudget', err);
    return null;
  }
  if (!row) return null;
  // The guards live in `usableConsentBudget` — see there for why the VALUE is guarded and for
  // the drifted mirror that made it shared.
  return usableConsentBudget(row);
}

/**
 * What the SPEND path needs to know about a viewer's consent for one app, as three
 * mutually exclusive outcomes.
 *
 *   `revoked`   — the viewer has withdrawn spend consent: either the whole grant is
 *                 revoked (`revoked_at`) or `ai:write:budgeted` is in `revoked_scopes`.
 *                 The caller must REFUSE.
 *   `no-budget` — spend is consented but the viewer set no per-app ceiling, so only the
 *                 platform's own `BLOCK_BUZZ_CAP_PER_DAY` applies. This includes the
 *                 no-grant-row case: a token that reached a spend gate carries the scope,
 *                 and "no row" carries no budget.
 *   `budget`    — spend is consented and bounded at `budget` per UTC day.
 */
export type ConsentSpendPosture =
  | { kind: 'revoked'; reason: 'grant_revoked' | 'spend_scope_revoked' }
  | { kind: 'no-budget' }
  | { kind: 'budget'; budget: number };

/**
 * The spend path's read of the consent ledger.
 *
 * 🔴 THIS EXISTS BECAUSE `null` COULD NOT SAY "REVOKED". `getConsentBuzzBudget` collapses
 * "the viewer set no ceiling" and "the viewer revoked spend" onto the same `null`, and
 * `reserveBlockBuzzSpendForClaims` read that `null` as *"no consent reservation"* and
 * fell through to the platform ceiling alone — so a revoke LOOSENED the viewer's own cap
 * for the remaining life of an already-minted token before it removed the scope. The two
 * states needed to be distinguishable before the reserve path could refuse one of them;
 * that is the whole content of this function. See `getConsentBuzzBudget`'s docblock for
 * the retracted description of the inversion.
 *
 * 🔴 A SIBLING RATHER THAN A CHANGED RETURN TYPE, deliberately. `getConsentBuzzBudget`
 * has two other callers — the OAuth consent mirror and the permissions surface's
 * guard-mirror — for which `null` is the correct display answer for a revoked grant
 * ("no ceiling to show"). Widening ITS return would have forced a decision at those two
 * sites that neither of them has any use for.
 *
 * 🔴 READS THE PRIMARY, for the same reason `getConsentBuzzBudget` does: it runs on the
 * spend path immediately after a consent write that may have just TIGHTENED or revoked,
 * and a replica-lag read would spend against the older, looser state — the one direction
 * a money gate must never drift. The `db` option exists for tests and for a caller that
 * is provably not on a write's heels; it is not the default.
 *
 * 🔴 TWO INDEPENDENT P2022 BRANCHES, ONE PER MIGRATION, AND MERGING THEM WOULD BE A
 * FAIL-OPEN. `revoked_scopes` and `buzz_budget_per_day` ride different hand-applied
 * migrations, so a database can have either without the other. The revocation read
 * degrades to "nothing revoked" (true — no column, no revocation) and the budget read
 * degrades to "no budget" (true — no column, no budget); a single shared catch would let
 * a missing BUDGET column suppress the REVOCATION check, which is the direction that
 * silently keeps spending.
 */
export async function resolveConsentSpendPosture(opts: {
  userId: number;
  appBlockId: string;
  db?: 'read' | 'write';
}): Promise<ConsentSpendPosture> {
  const client = opts.db === 'read' ? dbRead : dbWrite;
  const row = await readGrantRow(
    client,
    opts.userId,
    opts.appBlockId,
    'resolveConsentSpendPosture'
  );
  // 🔴 HAND-SPELLED ON PURPOSE — THE ONE PLACE THAT DOES NOT USE `liveGrantedScopes`, and the
  // reason is the return type. The projection COLLAPSES a whole-grant revoke and a per-scope
  // revoke of the spend scope into "conveys nothing"; this function has to tell them apart,
  // because `grant_revoked` and `spend_scope_revoked` produce different copy for the viewer.
  // Do not "consolidate" it — that loses the distinction. If the rule ever gains a third term,
  // this is the site that will silently miss it.
  if (row?.revokedAt) return { kind: 'revoked', reason: 'grant_revoked' };
  if ((row?.revokedScopes ?? []).includes(CONSENT_SPEND_SCOPE)) {
    return { kind: 'revoked', reason: 'spend_scope_revoked' };
  }
  // Reuses the budget reader rather than widening `readGrantRow`'s select, which keeps the
  // value guards and the budget column's OWN P2022 branch in exactly one place.
  //
  // ⚠️ THAT IS A CODE-ORGANISATION ARGUMENT, NOT A COST ONE, and the first wording blurred
  // them by opening "Costs a second indexed lookup". It DOES buy a second lookup on the same
  // unique key per spend attempt — measured during review at ~0.3 ms for the pair against a
  // 40-row table, noise beside the orchestrator call and the Buzz reserve on the same path.
  // If this path ever becomes hot the cheaper shape exists (one wider select plus a
  // `meta.column`-keyed narrowing retry), so do not cite the one-place argument as a
  // prohibition.
  const budget = await getConsentBuzzBudget(opts);
  return budget == null ? { kind: 'no-budget' } : { kind: 'budget', budget };
}

/**
 * 🔴 THE WRITES BELOW MUST NEVER READ A COLUMN BACK. Prisma's DEFAULT selection is
 * "every scalar", so a `create`/`update` with no `select` emits
 * `RETURNING … buzz_budget_per_day` — which makes an ordinary install / subscribe /
 * re-consent throw P2022 against a database that has not had the migration applied
 * yet, i.e. a 500 on every grant write from a deploy that lands first. MEASURED on
 * this PR's own preview environment before this select existed.
 *
 * `id` is picked because it is the primary key: it predates this feature, it can
 * never be the column a future migration is racing, and no caller uses the return
 * value (both writers return `void`). Do NOT widen this to include a column added by
 * a pending migration — the whole point is that these writes read nothing new.
 *
 * 🔴 KEEP THIS CONST ABOVE `recordScopeGrant`'s DOCBLOCK, NOT BETWEEN THEM. It was
 * introduced between that docblock and its function, which silently orphaned it:
 * TypeScript attaches a leading comment to the next DECLARATION, so the whole
 * `buzzBudgetPerDay` three-state contract stopped appearing on hover at every call
 * site. A docblock separated from its function by another declaration documents
 * that declaration instead.
 */
const WRITE_RETURN_SELECT = { id: true } as const;

/**
 * Records (or extends) a user's consent for an app block. ADDITIVE — scopes
 * the user already granted persist; the supplied scopes are unioned in. Writing
 * a grant also clears any prior `revoked_at` (re-granting un-revokes), and
 * stamps the version the consent was taken against.
 *
 * Called from the install / subscribe paths (implicit first-consent) and from
 * the re-consent path. Idempotent on (user, app_block) via the unique index;
 * concurrent first-writes manifest as a P2002 which we retry as an update.
 *
 * `scopes` is filtered to the app's currently-approved scope set by the caller
 * (install/subscribe already resolve the AppBlock manifest) — this service does
 * NOT re-derive the ceiling; it stores exactly what it is told the user
 * consented to. Unknown/garbage scopes simply never match at mint.
 *
 * ## `buzzBudgetPerDay` semantics — NOT additive, and deliberately not
 *
 * The scope set unions because "I already let you read my models" and "now also
 * spend my Buzz" are both true at once. A budget is a single number and cannot
 * union; it can only be kept or replaced. So:
 *
 *   - `buzzBudgetPerDay: <number>` → OVERWRITES the stored value. The user just
 *     told us what they want; the newest statement wins.
 *   - `buzzBudgetPerDay: null`     → OVERWRITES with "no budget" (an explicit
 *     clear — the user removed their limit).
 *   - key OMITTED (`undefined`)    → LEAVES the stored value untouched.
 *
 * That third case is the one that matters, and it is why this is `'buzzBudgetPerDay'
 * in opts` rather than a `!== undefined` test on the value. A re-consent for a NEW
 * scope (the host surfaces `needs_consent`, the user clicks Allow) sends only the
 * scopes; if an omitted budget were written through as NULL, accepting one extra
 * permission would silently wipe a spend limit the user had deliberately set —
 * a widening, performed by a dialog that said nothing about money.
 *
 * ## `clearRevocations` — and why it clears only what was CONSENTED TO
 *
 * 🔴 PASS IT ONLY FROM A PROMPTED CONSENT PATH. Exactly one caller sets it:
 * `blocks.grantScopes`, whose scope set comes from the consent modal the user just
 * accepted. `BlockRegistry.recordInstallConsent` MUST NOT — its set is the app's whole
 * consent-gated effective set, supplied unconditionally with no prompt, so honouring a
 * clear there would make an ordinary install silently undo a revoke. That asymmetry is
 * the entire point of the flag; it is not a convenience parameter.
 *
 * 🔴 AND IT CLEARS `revoked_scopes ∖ scopes`, NOT `[]`. A wholesale clear is the shape
 * this was first written as and it is wrong: a viewer who revoked `posts:write:self` and
 * later re-consents to `collections:read:private` would have BOTH restored by one dialog
 * that named only the second. The user is re-consenting to the scopes in front of them,
 * so only those scopes' suppressions lift. A test pins this
 * (`scope-grant.service.test.ts`, "clears ONLY the re-consented scope's revocation").
 *
 * 🔴 THE COLUMN IS TOUCHED ONLY WHEN THERE IS SOMETHING TO CLEAR, which is what keeps
 * re-consent working on a database that has not had the revocation migration applied.
 * The read below is P2022-tolerant and reports "nothing revoked" there, so the write
 * never names `revoked_scopes` and cannot 500. Do NOT "simplify" this to always writing
 * `revokedScopes: next` — the whole install/subscribe/re-consent surface is what breaks.
 */
export async function recordScopeGrant(opts: {
  userId: number;
  appBlockId: string;
  version: string;
  scopes: string[];
  /** Omit to leave any stored budget untouched; `null` explicitly clears it. */
  buzzBudgetPerDay?: number | null;
  /**
   * PROMPTED CONSENT ONLY. Lifts the per-scope suppression for the scopes in `scopes`
   * (and only those). See the docblock above — the install path must never pass it.
   */
  clearRevocations?: boolean;
}): Promise<{
  /**
   * The suppression list AFTER this write, but ONLY when `clearRevocations` was requested
   * AND something was actually lifted — otherwise `null`, meaning "no clear happened, so
   * there is nothing to re-publish".
   *
   * 🔴 `null` IS NOT `[]`. It has to be distinguishable, because the caller's use for this
   * is re-publishing the Redis marker: `[]` means "delete the marker, nothing is revoked
   * any more", while `null` means "this write did not touch revocations at all, leave the
   * marker alone". Collapsing them would make every ordinary install DELETE a live
   * suppression marker — reopening, in the Redis layer, exactly the resurrection hole the
   * `clearRevocations` asymmetry closes in Postgres.
   */
  revokedScopesAfterClear: string[] | null;
}> {
  const { userId, appBlockId, version } = opts;
  // Presence of the KEY, not truthiness of the value — see the doc above.
  const budgetSupplied = 'buzzBudgetPerDay' in opts;
  const budgetData = budgetSupplied ? { buzzBudgetPerDay: opts.buzzBudgetPerDay ?? null } : {};
  // Dedup + drop empties so the stored array stays clean.
  const incoming = Array.from(
    new Set(opts.scopes.filter((s) => typeof s === 'string' && s.length > 0))
  );
  const incomingSet = new Set(incoming);

  /**
   * Whether this write may clear a WHOLE-GRANT revoke (`revoked_at`).
   *
   * 🔴 GATED ON `clearRevocations`, AND IT USED TO BE UNCONDITIONAL — WHICH LEFT AN INSTALL
   * ABLE TO UN-REVOKE. Review found this after the sibling defect in `revokeScopes` was fixed:
   * `revoked_at` had TWO clearers and only one was closed. `recordInstallConsent` calls this
   * with no `clearRevocations`, from install and from subscribe, and an unconditional
   * `revokedAt: null` meant an ordinary install silently lifted a whole-grant revoke with no
   * consent prompt anywhere.
   *
   * The exposed population is the hand-written one — `revoked_at` set with `granted_scopes`
   * still populated — which is exactly what
   * `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql` STEP 2 produces to force a
   * fresh consent prompt. On such a row an install merged the whole consent-gated set back in,
   * cleared `revoked_at` and left `buzz_budget_per_day` untouched: the forced re-consent gone,
   * spend live again, the old ceiling back. Rows written by `revokeScopes` are NOT exposed,
   * because a full revoke also populates `revoked_scopes`, which survives the union — so the
   * residual was precisely the operator-written state.
   *
   * ⚠️ THE ONEOFF'S HEADER DOCUMENTS THE OLD BEHAVIOUR AS INTENDED ("Re-granting un-revokes
   * cleanly through the existing upsert"). That was a true statement about a world with no
   * user-facing revoke; it is not a licence for an UNPROMPTED path to do it now. A prompted
   * re-consent still clears it, which is the flow that oneoff actually wants.
   */
  function unrevokeData(priorGranted: string[] | undefined, priorRevoked: string[] | undefined) {
    if (!opts.clearRevocations) return {};
    // 🔴 A WHOLE-GRANT REVOKE IS **MIGRATED**, NOT LIFTED — and clearing it wholesale was the
    // same defect this flag exists to prevent, one level up.
    //
    // `revoked_at` means "everything on this row is withheld pending fresh consent". A viewer
    // re-consenting to ONE scope has said nothing about the others, so simply nulling the flag
    // restored every scope in `granted_scopes` — including `ai:write:budgeted` with its old
    // ceiling — from a dialog that named one. That is exactly the argument `revocationData`
    // below makes for clearing only `revoked_scopes ∖ scopes`; `revoked_at` is the whole-grant
    // version of it and was left wholesale.
    //
    // So: everything that WAS granted and is NOT being re-consented to becomes an explicit
    // per-scope suppression, and only then does the flag clear. Semantics preserved exactly —
    // "all withheld" becomes "all still withheld except the one you just allowed" — and the
    // result is expressible in the per-scope model the rest of this feature uses.
    const wasWholeGrantRevoked = Boolean(existingRevokedAt);
    if (!wasWholeGrantRevoked) return { revokedAt: null };
    // 🔴 ON A PRE-MIGRATION DATABASE THE MIGRATION IS NOT EXPRESSIBLE, SO THE CLEAR IS
    // CONDITIONAL INSTEAD OF WHOLESALE. `revoked_at` predates this migration; `revoked_scopes`
    // does not. So when the pre-write read fell back to the narrow select we can still SEE a
    // whole-grant revoke but cannot write the per-scope suppressions that would replace it —
    // and the two remaining options are not symmetric. Lifting the flag wholesale is the
    // fail-OPEN this function exists to close (it restores every scope in `granted_scopes`,
    // `ai:write:budgeted` at its old ceiling included, from a dialog that named a subset).
    //
    // What IS expressible is the case where there is nothing left to suppress: if the viewer
    // re-consented to everything the row had granted, the migration would have produced an
    // empty list anyway, so clearing the flag loses no information. A PARTIAL re-consent
    // REFUSES — the viewer stays withheld rather than over-granted, and is TOLD so.
    //
    // 🔴 IT REFUSES OUT LOUD, AND RETURNING `{}` HERE WAS A PERMANENT SILENT NO-OP. Round-5
    // review, measured over three identical "Allow" presses with a control: nothing touched
    // `revoked_at`, `grantScopes` answered `{ ok: true }` each time, and — unlike the round-4
    // defect — there is no second-click recovery, because `existingRevokedAt` never clears.
    //
    // ⚠️ THE MECHANISM HAS NOW BEEN WRITTEN DOWN WRONG TWICE. Rounds 5 and 6 both got it wrong
    // in the same direction — reaching for a property of the SCOPE SET when the operative fact is
    // a property of the DATABASE — so here is the whole ladder, because the wrong versions each
    // looked sufficient:
    //   (a) *"`granted_scopes` is union-only and never pruned"* — FALSE. `revokeScopes` prunes it:
    //       it writes `priorGrantedRaw ∖ incoming` back to the column.
    //   (b) *"the CEILING bounds both `incoming` and the revoke UI"* — HALF false, and the wrong
    //       half is load-bearing. `incoming` is genuinely `input.scopes ∩ ceiling`
    //       (`blocks.router.ts`), but `revokeScopes` has NO ceiling filter, deliberately: that
    //       mutation's own docblock argues narrowing is always safe and the ceiling MOVES (a
    //       publisher push replaces `manifest` without re-approval), so filtering would refuse to
    //       revoke exactly the scopes a viewer granted last month. `revokableScopes` is what the
    //       UI OFFERS, which is not an enforcement boundary. ⚠️ THE NEXT CLAUSE READ *"a client may
    //       send any known non-exempt scope"* AND IS RETRACTED: `blocks.revokeScopes` now also
    //       refuses a scope outside the viewer's LIVE granted set (`getGrantedScopes`, primary
    //       read), so the reachable set is narrower than the vocabulary — but still not the
    //       manifest ceiling, which is the only thing this bullet turns on. And revoking the stale
    //       scope WOULD empty the residual, via (a).
    //   (c) The operative fact: on a pre-migration database `revokeScopes` refuses OUTRIGHT. ⚠️ The
    //       MECHANISM stated here is now only half of it: `blocks.revokeScopes` reads the granted
    //       set FIRST, via `getGrantedScopes` → `readGrantRow`, which is P2022-TOLERANT and answers
    //       `revokedScopes: []` from its narrow fallback. So a NOT-HELD scope is refused earlier,
    //       with `BAD_REQUEST`, and only a HELD one reaches the sentence below. The conclusion is
    //       unchanged — there is still no revoke to perform — but this bullet has been rewritten
    //       twice already for exactly this kind of premise error, so the two paths are named.
    //       This service function has
    //       no early return before its read; that read selects `revokedScopes` and has no narrow
    //       fallback, so the P2022 is rethrown as `PRECONDITION_FAILED` — and the WRITE path
    //       converts the same error through the same helper. So there is no revoke to perform, and
    //       `incoming`'s ceiling bound closes the only other route. ⚠️ One sub-case is UNVERIFIED
    //       and a mock cannot settle it: with no matching row the refusal still holds, because
    //       Prisma rejects the query rather than returning rows. Whether that is row-INDEPENDENT at
    //       the database is not established anywhere in this repo, and at the mock boundary a P2022
    //       rejection is the entire observable, so an arm asserting it would be measuring the
    //       fixture. ⚠️ An earlier draft explained it as "Postgres raises 42703 at PARSE time" —
    //       withdrawn twice over: nothing in-tree measures when 42703 is raised, and it explained a
    //       real refusal with a mechanism from the wrong surface.
    //       🔴 THE WITHDRAWAL'S OWN FIRST DRAFT THEN MIS-ATTRIBUTED IT, by adopting a reviewer's
    //       file reference without re-deriving it. `app-access.service.ts` does NOT match
    //       `P2022 || 42703` — it matches `P2021 || 42P01` and deliberately REFUSES a column
    //       error, so that a half-applied schema surfaces instead of becoming a permanent silent
    //       zero. The predicate that pairs them is `app-listing-source-repo.service.ts`, and it
    //       also refutes "42703 never arises on the typed client": 42703 is what Prisma reports
    //       under `meta.code` on some engine versions. `isMissingColumnError` above now matches
    //       that shape; it did not, which is the gap that comment would have stopped anyone
    //       finding.
    // Hence "no viewer action can empty the residual" is true, and unreachable is the right word —
    // for reason (c). ⚠️ The residual becomes escapable the instant the migration lands, which is
    // harmless because this branch is unreachable by then. Stated because (b) would mislead
    // precisely the person who later relaxes the revoke refusal.
    //
    // 🔴 SO THE REFUSAL IS AS PERMANENT AS THE NO-OP WAS, AND THAT IS DELIBERATE — this round made
    // the dead end VISIBLE, it did not remove it. The closing condition is a human applying
    // migration `20260927120000_app_user_scope_grant_revoked_scopes`, which the viewer-facing
    // message points at ("not available on this environment yet … try again later"). The known
    // in-scope remedy, if that window is ever long enough to matter, is to intersect the residual
    // with the CURRENT ceiling: a stale out-of-ceiling scope is not mintable anyway (the mint
    // signs `partitionByConsent(declared, granted).signable`, and `declared` is derived from the
    // manifest ∩ `approvedScopes`), so lifting `revoked_at` while one sits in `granted_scopes`
    // grants the viewer nothing extra. It is NOT done here because it changes this function's
    // signature to take the ceiling, for a window that exists only until someone runs one ALTER.
    //
    // Round-4 review found this branch still taking the wholesale lift: `existingRevokedAt` was
    // assigned on the wide read only, so the narrow fallback left it `null` and the whole
    // migration was skipped — the one population it was written for (the `2026-09-16` oneoff's
    // hand-written rows, on a database that has not had the column added yet) was the one it
    // did not cover.
    if (!revokedScopesColumnAvailable) {
      const residual = (priorGranted ?? []).filter((x) => !incomingSet.has(x));
      if (residual.length > 0) {
        // 🔴 ITS OWN EVENT, NOT `logMissingRevokedScopesColumn`, AND NOT ONCE-PER-PROCESS.
        // Round-6 review: omitting a log line here left the refusal viewer-visible but
        // operator-INVISIBLE. That emitter is guarded by a module-level `once` flag, so a second
        // call is a silent no-op — it has already fired, on this request's degraded read or on an
        // earlier request's, since the flag is module-level — and its
        // `site` is the same string either way, so no event distinguished "a viewer was refused a
        // re-consent" from "a read degraded", and at most one fired per process lifetime. On a
        // surface whose whole thesis is that silent behaviour is the enemy, the refusal has to be
        // countable. Unguarded on purpose: the rate is bounded by a human pressing a button on a
        // mutation, not by traffic.
        logToAxiom(
          {
            name: 'app-blocks-scope-grant',
            // 🔴 `info`, AND IT HAS BEEN `error` THEN `warning`. `PRECONDITION_FAILED` is a member of
            // `CLIENT_FAULT_TRPC_CODES`, whose docblock in `~/server/logging/client` says these
            // "are NOT incidents and must never be logged at error severity, or they drown out
            // the real server-side failures on the error board" — and a line carrying
            // `type: 'error'` with no `level` key is findable as an error on that board (measured
            // in `@civitai/axiom`: `| type="error"` returns rows, and such lines resolve to
            // `detected_level="error"` 100% of the time).
            //
            // 🔴 THE CO-OCCURRENCE IS MEASURED; THE MECHANISM IS DELIBERATELY NOT ASSERTED. This
            // comment first said `type: 'error'` "is exactly what RESOLVES a line to
            // `detected_level="error"`" — which is theory #1 of three that `@civitai/axiom`'s own
            // docblock records as each having been refuted by the next round's measurement, under
            // a sign that says in words: do not add a fourth theory, and do not extend that
            // comment with a guess. Round-8 review caught it propagating here. If you need the
            // mechanism, measure it.
            //
            // The OPERATOR's actionable
            // cause (missing column, apply the migration) is already on that board once per
            // process via `logMissingRevokedScopesColumn`.
            //
            // ⚠️ AND THIS LINE IS NOT WHAT MAKES THE REFUSAL COUNTABLE — an earlier draft claimed
            // it was. `PRECONDITION_FAILED` is not in `[trpc].ts`'s onError early-return list, so
            // the refusal already reaches `buildCentralErrorLog` and is logged at `type: 'info'`
            // with `path`, `trpcType`, `user` and `input`; `wasServerFaultLogged` cannot dedupe a
            // hand-written call, so a refusal emits TWO `info` lines. What this one adds that the
            // chokepoint's does not carry is the MIGRATION NAME and `residualCount` — narrower,
            // and true.
            //
            // 🔴 `info` IS PRESCRIBED, NOT CHOSEN — AND ROUND 7 PICKED `warning` HAVING READ ONLY
            // HALF THE DOCBLOCK IT QUOTED. Twenty lines below the "never at error severity"
            // sentence, the same file names the severity for exactly this class: "CLIENT fault
            // (BAD_REQUEST / NOT_FOUND / CONFLICT / PRECONDITION_FAILED that still reach the
            // chokepoint) → the light `safeError` shape + `type: 'info'`, so normal user-feedback
            // rejections never flood the error stream" — and `buildCentralErrorLog` mechanically
            // returns only `'error' | 'info'`, never `'warning'`. Round 8 concluded "there is no
            // `info` convention" by comparing against a service that logs NOTHING, while the
            // governing text sat in the file already being quoted. `warning` was defensible (178
            // uses in `src/server`) but it was a judgement dressed as compliance, and it rested on
            // a second unmeasured claim — that `warning` does not reach the error board — which
            // nothing in this repo measures for any type other than `error`. Following the
            // prescription removes the claim instead of adding one.
            //
            // ⚠️ STRICTLY, THAT DOCBLOCK GOVERNS THE CHOKEPOINT'S OUTPUT, NOT A HAND-WRITTEN CALL —
            // so the direct precedent is what settles it: `endpoint-helpers.ts`'s
            // `logRestGenericizedClientFault` hand-writes `{ ...buildCentralErrorLog(e),
            // type: 'info', level: 'info' }` outside the chokepoint for exactly this class. And
            // whether `info` is HARDER TO FIND than `warning` is UNMEASURED HERE: both are
            // extracted from the same `type` field, so `| type="info"` and `| type="warning"` are
            // equally queryable, but whether the pipeline drops or samples a level is configured
            // in talos-infra, not this repo. Not asserted either way.
            type: 'info',
            message:
              `Refused a prompted RE-CONSENT: this database has no ` +
              `app_user_scope_grants.revoked_scopes, so a whole-grant revoke cannot be migrated ` +
              `to per-scope suppressions, and this consent did not cover every scope the row ` +
              `already granted. Apply migration ` +
              `20260927120000_app_user_scope_grant_revoked_scopes. NOTHING was written.`,
            site: 'recordScopeGrant:reconsent-refused',
            residualCount: residual.length,
          },
          'webhooks'
        ).catch(() => {
          /* logging must never break a consent path */
        });
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: CONSENT_RECONSENT_UNAVAILABLE_MESSAGE,
        });
      }
      // Nothing is withheld after this write — the honest value for the caller's marker publish.
      clearedTo = [];
      return { revokedAt: null };
    }
    // 🔴 `incoming` IS SUBTRACTED FROM **BOTH** SOURCES. Carrying `priorRevoked` forward verbatim
    // kept suppressing a scope the dialog DID name — so re-consenting to something the viewer had
    // previously revoked silently failed, which is the mirror image of the defect this function
    // was written to close. Caught by the migration test, not by reasoning.
    const carried = [...(priorGranted ?? []), ...(priorRevoked ?? [])].filter(
      (x) => !incomingSet.has(x)
    );
    const migrated = Array.from(new Set(carried));
    // 🔴 THE WRITE IS **UNCONDITIONAL**, AND GUARDING IT ON `migrated.length > 0` WAS A
    // SILENT NO-GRANT. Round-4 review, reproduced: the consent dialog sends the app's whole
    // consent-gated set (`blocks.router.ts` intersects the viewer's request with the app's
    // ceiling), so on a whole-grant-revoked row `incoming` covers everything and `migrated`
    // is `[]` — the guard then skipped the column, `revoked_scopes` kept the full list the
    // revoke had written, and `revoked_at` cleared anyway. Post-state: granted = all,
    // revoked = all, flag = null, so `liveGrantedScopes` returned NOTHING. The mutation
    // reported success and conveyed no scope; a SECOND identical click recovered (by then
    // `existingRevokedAt` is null so `revocationData` handles it), which is why the symptom
    // reads as "I had to press Allow twice" rather than as a failure.
    //
    // Writing `[]` is not redundant — it is the only thing that clears a suppression list the
    // revoke wrote. And the timestamp follows the list: `null` once nothing is withheld,
    // matching `revocationData`'s rule below so the two clear-capable paths cannot disagree
    // about what an empty list means.
    // 🔴 REPORT THE MIGRATION TO THE CALLER. This function writes `revoked_scopes` just as
    // `revocationData` does, so leaving `clearedTo` null here made `revokedScopesAfterClear`
    // claim "this write did not touch revocations" about a write that rewrote the whole list —
    // and the router skips `ConsentRevocation.publish` on `null`, so the suppressions this path
    // creates never reached in-flight tokens. Same round-4 review.
    clearedTo = migrated;
    return {
      revokedAt: null,
      revokedScopes: migrated,
      revokedScopesAt: migrated.length > 0 ? new Date() : null,
    };
  }

  /**
   * What the clear resolved to, for the return value. Stays `null` unless a clear was
   * requested AND actually lifted something — see the return type for why `null` and `[]`
   * must not be collapsed.
   *
   * 🔴 BOTH clear-capable paths assign it: `revocationData` (plain subtraction) and
   * `unrevokeData` (whole-grant migration). Only one of them runs per write — the migration
   * makes `revocationData` yield — so there is no ordering question, but a future third writer
   * of `revoked_scopes` MUST set this too or the router silently skips the marker publish.
   */
  let clearedTo: string[] | null = null;

  /**
   * The revocation half of the update payload — `{}` unless this is a prompted
   * re-consent that actually has a suppression to lift. Computed from the row so the
   * write can stay silent about the column when nothing changes.
   */
  function revocationData(priorRevoked: string[] | undefined): Record<string, unknown> {
    if (!opts.clearRevocations) return {};
    // 🔴 YIELD TO `unrevokeData` WHEN IT IS MIGRATING A WHOLE-GRANT REVOKE. Both functions can
    // write `revoked_scopes`, and the spread order puts this one LAST — so without this the
    // migration (prior ∪ everything-not-re-consented) would be overwritten by the plain
    // subtraction (prior ∖ incoming), silently restoring every scope the whole-grant revoke had
    // withheld. That is the defect `unrevokeData` was just written to close, reintroduced by the
    // neighbour. The migration already subtracts `incoming`, so it is a strict superset of what
    // this function would have written.
    if (existingRevokedAt) return {};
    const prior = priorRevoked ?? [];
    const next = prior.filter((s) => !incomingSet.has(s));
    if (next.length === prior.length) return {};
    clearedTo = next;
    // Only null the timestamp once the list is EMPTY: while anything is still revoked it
    // remains the honest "permissions last changed" value for this (user, app).
    return { revokedScopes: next, ...(next.length === 0 ? { revokedScopesAt: null } : {}) };
  }

  /**
   * The pre-write read. Widened to `revoked_scopes` ONLY when a clear is possible, so the
   * install/subscribe path issues exactly the query it always did — and, on a database
   * without the column, a prompted re-consent degrades to "nothing revoked" rather than
   * 500ing (see `readGrantRow` for why absent ⇒ none is the true answer, not a guess).
   */
  /** Set by `readExisting` when a clear is possible — `unrevokeData` branches on it. */
  let existingRevokedAt: Date | null = null;

  /**
   * 🔴 FALSE ONCE THE PRE-WRITE READ HAS FALLEN BACK TO THE NARROW SELECT, i.e. this database
   * has no `revoked_scopes` column. `unrevokeData` MUST NOT write that column when this is
   * false — the update would P2022 and 500 the consent mutation — so it takes a conditional
   * clear instead. Declared here rather than inferred from `existing.revokedScopes === undefined`
   * because `undefined` is also what a post-migration row with an empty list deserializes to on
   * the non-clear path, and conflating the two would gate a real write on a false negative.
   */
  let revokedScopesColumnAvailable = true;

  async function readExisting(): Promise<{
    id: string;
    grantedScopes: string[];
    revokedScopes?: string[];
    revokedAt?: Date | null;
  } | null> {
    const where = { userId_appBlockId: { userId, appBlockId } };
    if (!opts.clearRevocations) {
      return (await dbWrite.appUserScopeGrant.findUnique({
        where,
        select: { id: true, grantedScopes: true },
      })) as { id: string; grantedScopes: string[] } | null;
    }
    try {
      const row = (await dbWrite.appUserScopeGrant.findUnique({
        where,
        // `revokedAt` is selected ONLY on the clear-capable path — `unrevokeData` has to know
        // whether it is lifting a whole-grant revoke (and therefore must migrate the rest to
        // per-scope suppressions) or merely writing a redundant `null`.
        select: { id: true, grantedScopes: true, revokedScopes: true, revokedAt: true },
      })) as {
        id: string;
        grantedScopes: string[];
        revokedScopes: string[];
        revokedAt: Date | null;
      } | null;
      existingRevokedAt = row?.revokedAt ?? null;
      return row;
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
      logMissingRevokedScopesColumn('recordScopeGrant', err);
      revokedScopesColumnAvailable = false;
      // 🔴 `revokedAt` IS STILL SELECTED HERE — it predates this migration, so the narrow
      // fallback can read it for free, and `unrevokeData` needs it to tell a whole-grant revoke
      // from a redundant `null` write. Omitting it is what made the pre-migration population
      // take the wholesale lift.
      const narrow = (await dbWrite.appUserScopeGrant.findUnique({
        where,
        select: { id: true, grantedScopes: true, revokedAt: true },
      })) as { id: string; grantedScopes: string[]; revokedAt: Date | null } | null;
      existingRevokedAt = narrow?.revokedAt ?? null;
      return narrow;
    }
  }

  const existing = await readExisting();

  if (existing) {
    const merged = Array.from(new Set([...(existing.grantedScopes ?? []), ...incoming]));
    await dbWrite.appUserScopeGrant.update({
      where: { id: existing.id },
      data: {
        grantedScopes: merged,
        version,
        ...unrevokeData(existing.grantedScopes, existing.revokedScopes),
        ...budgetData,
        ...revocationData(existing.revokedScopes),
      },
      select: WRITE_RETURN_SELECT,
    });
    return { revokedScopesAfterClear: clearedTo };
  }

  try {
    await dbWrite.appUserScopeGrant.create({
      data: {
        id: newAppUserScopeGrantId(),
        userId,
        appBlockId,
        version,
        grantedScopes: incoming,
        ...budgetData,
        // No revocation data on a CREATE: a row that does not exist has nothing
        // suppressed, and naming the column here would 500 a first-ever consent on a
        // database that has not had the migration applied. The DB default is `{}`.
      },
      select: WRITE_RETURN_SELECT,
    });
  } catch (err) {
    // Concurrent first-write race on the (user, app_block) unique index →
    // fall through to an additive update so neither writer's scopes are lost.
    const code = (err as { code?: unknown })?.code;
    if (code !== 'P2002') throw err;
    const row = await readExisting();
    if (!row) throw err;
    const merged = Array.from(new Set([...(row.grantedScopes ?? []), ...incoming]));
    await dbWrite.appUserScopeGrant.update({
      where: { id: row.id },
      data: {
        grantedScopes: merged,
        version,
        ...unrevokeData(row.grantedScopes, row.revokedScopes),
        ...budgetData,
        ...revocationData(row.revokedScopes),
      },
      select: WRITE_RETURN_SELECT,
    });
  }
  return { revokedScopesAfterClear: clearedTo };
}

/** What a revoke actually did, for the caller's response + its side effects. */
export type RevokeScopesResult = {
  /** The scopes newly added to the suppression list by THIS call. */
  revoked: string[];
  /** The full suppression list after the write. */
  revokedScopes: string[];
  /** What the viewer still grants this app after the write. */
  grantedScopes: string[];
  /** True when the granted set is now empty, i.e. `revoked_at` was stamped. */
  fullyRevoked: boolean;
  /** True when this call also cleared the viewer's stored per-app Buzz ceiling. */
  budgetCleared: boolean;
};

/**
 * PER-SCOPE REVOKE — the viewer withdraws one permission from one app.
 *
 * 🔴 IT WRITES A SUPPRESSION RECORD, NOT JUST A REMOVAL, AND THAT IS THE WHOLE DESIGN.
 * Removing the scope from `granted_scopes` alone does not hold:
 * `BlockRegistry.recordInstallConsent` passes `consentGatedScopes(effectiveBlockScopes(…))`
 * — the app's ENTIRE consent-gated set, unconditionally, with no prompt — into
 * `recordScopeGrant`, which UNIONS it. So a removal-only revoke is silently undone by the
 * viewer's next install or subscribe of that app. `revoked_scopes` survives the union and
 * `getGrantedScopes` subtracts it, so the scope stops being conveyed even while the
 * granted array holds it again.
 *
 * 🔴 CONSENT-GATED SCOPES ONLY — THE CALLER MUST REFUSE AN EXEMPT ONE FIRST. This
 * function does not filter: it records whatever it is told. But `partitionByConsent`
 * signs a `CONSENT_EXEMPT_SCOPES` member on the exempt test ALONE, before it ever looks
 * at the grant, so a suppression entry for any exempt scope would be
 * accepted, stored, and enforce NOTHING. `blocks.revokeScopes` rejects them with a
 * specific error for exactly that reason — see `isConsentExemptScope`. Making revocation
 * override exemption is explicitly NOT the design: those exemptions have their own
 * server-side gates (min-trust, moderation, visibility/ownership, rate limits) and
 * changing that is a security-model change, not a UI one.
 *
 * WHAT IT WRITES:
 *   - `revoked_scopes`  ← prior ∪ incoming (the suppression list)
 *   - `granted_scopes`  ← prior ∖ incoming (so the ledger reads honestly today)
 *   - `revoked_scopes_at` ← now (app-level "permissions last changed"; NOT per-scope)
 *   - `revoked_at`      ← now IF the granted set is now empty, else NULL. Nothing left to
 *                         grant is the whole-grant revoke the original A6 migration
 *                         described as "a future per-scope revoke"; this is it.
 *   - `buzz_budget_per_day` ← NULL if `ai:write:budgeted` is among the revoked scopes.
 *                         A ceiling on a spend the app can no longer make bounds nothing,
 *                         and leaving it would resurrect as a live limit the moment a
 *                         later re-consent restored the scope — a number the user set in
 *                         a dialog they have since walked back.
 *
 * 🔴 CREATES A ROW IF NONE EXISTS, rather than no-op'ing — kept as a property of the SERVICE, and
 * ⚠️ NO LONGER REACHABLE THROUGH ITS ONLY CALLER. The paragraph here used to justify it with *"a
 * viewer can reach a revoke control for an app they hold no grant row for (an app whose scopes are
 * all exempt, an activity-only row, a grant that was never written because the flow
 * short-circuited)"*, and that reachability is GONE: `blocks.revokeScopes` now refuses any scope
 * outside the viewer's live granted set, and no grant row means an empty granted set, so the
 * refusal fires before this function is called. (The three cases named were themselves the defect —
 * a control on a permission never given — not a requirement.) The create branch stays because this
 * function's contract is "records whatever it is told" and a future caller may legitimately need
 * it: a row with `granted_scopes: []` and the suppression set is fail-closed and durable, which is
 * the right shape if a pre-emptive suppression is ever wanted deliberately. It is an invariant
 * guard today, not a live branch, and its tests should be read as such.
 *
 * 🔴 PRIMARY, NOT REPLICA, on both the read and the write — this is a read-modify-write
 * of a consent ledger. Off the replica a revoke issued moments after a consent would
 * compute its `granted_scopes ∖ incoming` from a pre-consent snapshot and write back a
 * set that silently drops the scope the user just granted.
 *
 * 🔴 A MISSING `revoked_scopes` COLUMN THROWS, LOUDLY, AND THAT IS THE OPPOSITE OF THE
 * READ PATH'S RULE. A read can honestly answer "nothing is revoked" against a database
 * that cannot store a revocation. A WRITE cannot: reporting success to a user who just
 * clicked "remove this permission" while persisting nothing is the worst outcome
 * available on this surface, strictly worse than an error they can act on. The P2022 is
 * caught only to rename it — the operator needs the migration, not Prisma's column
 * string.
 */
export async function revokeScopes(
  opts: {
    userId: number;
    appBlockId: string;
    scopes: string[];
  },
  /**
   * Internal. Bounds the P2002 re-entry below to ONE retry. The retry is logically
   * self-terminating — the second pass finds the row a concurrent writer created and
   * takes the `update` branch, which cannot raise P2002 — but "logically" is a claim
   * about code that can change, and an unbounded self-call on a write path is the kind
   * of loop that presents as a pod pegging a CPU rather than as a bug.
   */
  attempt = 0
): Promise<RevokeScopesResult> {
  const { userId, appBlockId } = opts;
  const incoming = Array.from(
    new Set(opts.scopes.filter((s) => typeof s === 'string' && s.length > 0))
  );
  const incomingSet = new Set(incoming);
  const where = { userId_appBlockId: { userId, appBlockId } };

  let existing: {
    id: string;
    grantedScopes: string[];
    revokedScopes: string[];
    revokedAt: Date | null;
  } | null;
  try {
    // 🔴 `revokedAt` IS SELECTED, AND ITS ABSENCE WAS A REPORTING BUG ON THE ONE ROW SHAPE
    // THIS FEATURE EXISTS FOR. Without it, a partial revoke on a row that ALREADY carried a
    // whole-grant revoke (the `2026-09-16` oneoff's state) returned `fullyRevoked: false` and
    // a non-empty `grantedScopes`, while `liveGrantedScopes` — and therefore every mint, the
    // OAuth mirror and the permissions page — correctly said the grant conveys nothing. The
    // router hands both fields straight to the client, so the UI would have contradicted
    // enforcement. It is also what makes the oneoff-row test able to exercise this at all.
    existing = (await dbWrite.appUserScopeGrant.findUnique({
      where,
      select: { id: true, grantedScopes: true, revokedScopes: true, revokedAt: true },
    })) as {
      id: string;
      grantedScopes: string[];
      revokedScopes: string[];
      revokedAt: Date | null;
    } | null;
  } catch (err) {
    throw rethrowMissingRevokedScopesColumn(err, 'revokeScopes:read');
  }

  // 🔴 TWO PRIOR SETS, BECAUSE THE WRITE AND THE REPORT WANT DIFFERENT ONES — and collapsing
  // them onto the projection destroyed an audit trail.
  //
  //   `priorGrantedRaw`      — the column as stored. The WRITE narrows this, so a row that was
  //                            already whole-grant revoked keeps its `granted_scopes` array
  //                            instead of being flattened to `[]`. The `2026-09-16` oneoff
  //                            deliberately preserves that array ("keeping the audit trail"),
  //                            and nothing is gained by discarding it: `revoked_at` stays set,
  //                            so `liveGrantedScopes` still reports the grant as conveying
  //                            nothing to every reader.
  //   `priorGrantedEffective`— what the grant actually CONVEYS. The REPORT uses this, so
  //                            `fullyRevoked` and the returned `grantedScopes` agree with every
  //                            other reader of the row rather than contradicting the mint.
  const priorGrantedRaw = existing?.grantedScopes ?? [];
  const priorGrantedEffective = existing ? liveGrantedScopes(existing) : [];
  const priorRevoked = existing?.revokedScopes ?? [];
  const nextGrantedStored = priorGrantedRaw.filter((s) => !incomingSet.has(s));
  const nextGranted = priorGrantedEffective.filter((s) => !incomingSet.has(s));
  const nextRevoked = Array.from(new Set([...priorRevoked, ...incoming]));
  const newlyRevoked = incoming.filter((s) => !priorRevoked.includes(s));
  const fullyRevoked = nextGranted.length === 0;
  // 🔴 `incomingSet`, NOT `nextRevoked` — THIS CALL'S scopes, not the accumulated list. A
  // viewer who already revoked spend and now withdraws something unrelated has nothing to
  // clear: the budget is already NULL. Keying on `nextRevoked` would name
  // `buzz_budget_per_day` in every subsequent write, which is a 500 on a database that has
  // not had THAT migration applied (a different, earlier hand-applied one) — and would
  // report `budgetCleared: true` for a call that cleared nothing.
  const budgetCleared = incomingSet.has(CONSENT_SPEND_SCOPE);
  const now = new Date();

  const data = {
    // The STORED array — see the two prior sets above.
    grantedScopes: nextGrantedStored,
    revokedScopes: nextRevoked,
    revokedScopesAt: now,
    // 🔴 SET, NEVER CLEARED — AND THE FIRST VERSION WROTE `: null` ON EVERY PARTIAL REVOKE,
    // WHICH MADE A REVOKE **GRANT** PERMISSIONS. Read this before "simplifying" it back to a
    // ternary.
    //
    // `revoked_at` non-NULL together with a NON-EMPTY `granted_scopes` is a REAL, INTENDED
    // production state, not an impossible one: `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql`
    // runs `SET revoked_at = now() WHERE 'ai:write:budgeted' = ANY (granted_scopes)` and
    // deliberately leaves the array intact, to force a fresh consent prompt while keeping the
    // audit trail (its own comment: "Re-granting restores them cleanly"). On such a row
    // `getGrantedScopes` returns {} and `resolveConsentSpendPosture` returns
    // `revoked/grant_revoked` — the app is withheld pending explicit re-consent.
    //
    // A `: null` here meant that withdrawing ANY scope — including one the viewer does not
    // even hold, which this service accepts on purpose — cleared that suspension and
    // re-granted every other scope on the row with no prompt, `ai:write:budgeted` among
    // them, with the old `buzz_budget_per_day` springing back alongside it. An action the
    // user reads as narrowing that widens: the same shape as the spend-path inversion this
    // whole change exists to fix.
    //
    // So the key is OMITTED unless this revoke empties the granted set. Omitting is what
    // Prisma reads as "leave the column alone"; a partial revoke must neither stamp it (that
    // would hide the app's remaining permissions from the permissions page, which skips rows
    // carrying it) nor clear it.
    // Stamped when this revoke empties the EFFECTIVE granted set. On a row that was already
    // whole-grant revoked that is trivially true, so the timestamp refreshes rather than being
    // cleared — which is the safe direction and keeps `revoked_at` monotonic in effect.
    ...(fullyRevoked ? { revokedAt: now } : {}),
    ...(budgetCleared ? { buzzBudgetPerDay: null } : {}),
  };

  try {
    if (existing) {
      await dbWrite.appUserScopeGrant.update({
        where: { id: existing.id },
        data,
        select: WRITE_RETURN_SELECT,
      });
    } else {
      // `version: ''` — the same placeholder `blocks.grantScopes` writes when an AppBlock
      // carries no version. This row records a REFUSAL, so there is no version the
      // consent was taken against; inventing one would make the staleness display lie.
      // A create has no prior row, so the omit-vs-clear distinction above does not apply —
      // `revoked_at` defaults to NULL and `data` supplies it only when this revoke is total.
      await dbWrite.appUserScopeGrant.create({
        data: { id: newAppUserScopeGrantId(), userId, appBlockId, version: '', ...data },
        select: WRITE_RETURN_SELECT,
      });
    }
  } catch (err) {
    // A concurrent first-write (an install landing in the same instant) takes the unique
    // index. Re-read and re-apply, so the revoke is not lost to a race with the very
    // union it is defending against.
    if ((err as { code?: unknown })?.code === 'P2002' && attempt === 0) {
      return revokeScopes(opts, attempt + 1);
    }
    throw rethrowMissingRevokedScopesColumn(err, 'revokeScopes:write');
  }

  return {
    revoked: newlyRevoked,
    revokedScopes: nextRevoked,
    grantedScopes: nextGranted,
    fullyRevoked,
    budgetCleared,
  };
}

/**
 * The message a VIEWER sees when they withdraw a permission before the manual-apply
 * migration has run on their environment.
 *
 * Exported so tests assert the exact string rather than a substring of their own invention,
 * and so a mutant that swaps the guard for a different error is killed by the MESSAGE rather
 * than merely by "something threw" — the same reason `SOURCE_REPO_UNAVAILABLE_MESSAGE` is
 * exported from `app-listing-source-repo.service.ts`, which is this repo's worked precedent
 * for an author-originated write gated on a hand-applied column.
 */
export const CONSENT_REVOKE_UNAVAILABLE_MESSAGE =
  'Withdrawing a permission is not available on this environment yet. Nothing was changed. Try again later.';

/**
 * The message a VIEWER sees when a prompted RE-CONSENT cannot be expressed on their
 * environment — the mirror of the constant above, for the other half of the same
 * hand-applied migration.
 *
 * 🔴 THIS EXISTS BECAUSE THE REFUSAL WAS SILENT, AND A SILENT REFUSAL IS THE SYMPTOM CLASS
 * THIS WHOLE ARC KEEPS PRODUCING. On a database without `revoked_scopes`, a whole-grant
 * revoke cannot be migrated to per-scope suppressions, so `unrevokeData` refuses to lift
 * `revoked_at` unless the re-consent covers everything the row granted. Round-5 review found
 * the population where that refusal is PERMANENT rather than momentary. ⚠️ TWO WRONG MECHANISMS
 * have been written here — see `unrevokeData`'s branch comment for the full ladder and why each
 * looked sufficient. The short form: `granted_scopes` IS pruned (by `revokeScopes`), and
 * `revokeScopes` has NO ceiling filter, so neither of those closes it. What closes it is that
 * `revokeScopes` refuses OUTRIGHT on a pre-migration database (P2022 → `PRECONDITION_FAILED`), so
 * no revoke can prune the stale scope, while `incoming = input.scopes ∩ ceiling` shuts the only
 * other route. The residual is then non-empty forever, and
 * `grantScopes` returned `{ ok: true }` on every press with nothing changed and no second-click
 * recovery, because `existingRevokedAt` never clears. Measured over three identical presses.
 *
 * The fail-closed DIRECTION is right and is not what changed; being invisible was. `revokeScopes`
 * already refuses this same database with `PRECONDITION_FAILED` and an exported message, so the
 * two halves of the feature now refuse symmetrically instead of one throwing and one lying.
 *
 * Thrown AFTER the read and BEFORE any write: the `update` is never issued, and on the P2002
 * race-retry path the `create` has already been REJECTED by the unique index, so no write has
 * succeeded on any path.
 *
 * ⚠️ THIS LINE SAID "before any query runs", WHICH IS FALSE — reads are queries. By the time the
 * throw fires, `readExisting` has issued one or two `findUnique` SELECTs (the wide one having
 * failed with P2022, then the narrow retry). The conclusion is unchanged and was verified on all
 * three paths; only the stated reason was wrong.
 */
export const CONSENT_RECONSENT_UNAVAILABLE_MESSAGE =
  'Updating this app’s permissions is not available on this environment yet. Nothing was changed. Try again later.';

/**
 * Turns a P2022 on the revocation columns into a refusal the VIEWER and the OPERATOR can
 * each act on, and passes everything else through untouched.
 *
 * 🔴 `PRECONDITION_FAILED`, NOT A BARE `Error` — AND THE FIRST VERSION THREW THE BARE ONE.
 * That mattered more than it looks: `src/server/trpc/client-safe-error.ts` replaces the
 * message of every `status >= 500 && status !== 503` with a generic one, so a bare `Error`
 * became `INTERNAL_SERVER_ERROR` and the carefully-worded migration text reached nobody —
 * the viewer got an opaque server error and could not tell "nothing was recorded" from
 * "recorded, enforcement lags". `PRECONDITION_FAILED` is a 4xx, so its message survives the
 * formatter, and it is the same code (and the same argument) `assertSourceRepoWritable`
 * uses: the value is not malformed and there is nothing the viewer can do — the environment
 * is not ready.
 *
 * The MIGRATION NAME goes to the operator via `logMissingRevokedScopesColumn` (Axiom, once
 * per process, error level) rather than into the viewer's error, because a migration
 * identifier is not actionable by them and this string is shown in a product surface.
 */
function rethrowMissingRevokedScopesColumn(err: unknown, site: string): unknown {
  if (!isMissingColumnError(err)) return err;
  logMissingRevokedScopesColumn(site, err);
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: CONSENT_REVOKE_UNAVAILABLE_MESSAGE,
  });
}

/**
 * Intersects the scopes the token would otherwise carry with the user's
 * granted scopes, returning the granted subset to sign + the withheld scopes
 * the host must re-consent for.
 *
 * `apps:storage:*` (per-user KV) is intentionally NOT consent-gated here — it is
 * an ambient-but-otherwise-gated scope with its own issuance-time / per-op check
 * (resolveStorageContext). Subjecting it to per-user consent would make the
 * publisher re-consent to their own block's storage on every version bump for
 * no security gain. The remaining user-resource scopes (user/ai/buzz/
 * social, models:write) flow through the consent gate.
 *
 * `apps:storage:shared:read` / `apps:storage:shared:write` (the SHARED, app-
 * global / cross-user datastore) are ALSO exempt — and, unlike the per-user
 * scopes, they are NOT publisher-only. Their governance is NOT a per-scope
 * consent prompt but the SERVER-SIDE controls in `resolveSharedContext`
 * (apps-shared.router.ts): a fail-closed min-trust gate (not-anon, not-banned,
 * not-muted, onboarding-complete, email-verified, account age ≥ 7d) plus
 * content moderation and one-vote / per-user-row / rate limits, all enforced at
 * every read/write REGARDLESS of the token scope. `shared:read` is reading
 * PUBLIC community data (anon-safe — the router allows anon reads by design);
 * `shared:write` is trust-gated PUBLIC posting/voting (the resolver rejects anon
 * and any ineligible caller before touching data, whether or not the scope is
 * present). A per-scope consent prompt would add nothing that the trust gate +
 * moderation don't already enforce — so, mirroring the per-user storage scopes,
 * these sign without a grant. (Pre-GA consideration, NOT built here: an EXPLICIT
 * shared-WRITE consent prompt if widening the audience beyond the trust gate.)
 *
 * `models:read:self` is ALSO exempt (allow-by-default): a low-sensitivity read
 * of the viewer's OWN models, and a no-op for an anon viewer (no user → nothing
 * to read), so it is safe in an anon token. Exempting it lets the block render
 * fully for a logged-in viewer with no upfront consent prompt; the consent gate
 * is reserved for the money / AI scopes (`ai:write:budgeted`, `buzz:read:self`),
 * which the host requests lazily on the first buzz-spending action (Generate)
 * rather than on load.
 *
 * `collections:read:self` / `collections:write:self` are exempt — but
 * `collections:read:private` is DELIBERATELY NOT (the read split, below). The
 * exempt pair's gate is SERVER-SIDE per op, not a per-scope consent prompt:
 * read:self covers own-PUBLIC + any PUBLIC collection (public data — nothing
 * sensitive to consent to), and the follow write is SELF-BOUND to the token
 * subject (a bookmark on the caller's OWN account). A per-scope consent prompt
 * would add nothing the visibility/ownership/subject checks don't already
 * enforce. Exempting them is ALSO the #3090 fix: a page-app token that declared a
 * consent-gated scope silently dropped it at mint (the user had no grant row) →
 * every op 403'd; consent-exempt scopes flow through partitionByConsent
 * unconditionally, so the minted PAGE token actually carries them end-to-end.
 *
 * `collections:read:private` (the subject's OWN PRIVATE collections) is the
 * CONSENT-GATED half of the read split and is INTENTIONALLY absent from this set:
 * reading a user's private collections IS sensitive, so it must flow through the
 * gated branch — the host surfaces it as `needs_consent`, the user grants it, and
 * only then does a token carry it. (This is the deliberate contrast to the #3090
 * exemption above: read:self always mints; read:private mints only after consent.)
 *
 * `posts:write:self` (create a REAL Post on the viewer's profile from an app's
 * own outputs) is likewise INTENTIONALLY ABSENT, for a strictly stronger version
 * of the `collections:read:private` reason. It is the first block scope that
 * writes PUBLIC, feed-visible, reward-earning content under the VIEWER'S name.
 * No server-side visibility/ownership check can substitute for it, because the
 * app IS acting on the subject's own account — ownership is satisfied by
 * construction, which is exactly what makes it dangerous rather than safe. So it
 * flows through the gated branch: the host surfaces it as `needs_consent`, the
 * user grants it, and only then does a token carry it.
 *
 * ⚠️ THE GRANT IS NOT THE WHOLE CONSENT. A one-time grant cannot inform about
 * content that differs on every call, so `blocks.createPostFromApp` is ALSO
 * gated on a per-post host-chrome confirm rendering the HOST-RESOLVED title /
 * detail / tags / image thumbnails / gallery target. Do NOT "simplify" that
 * confirm away as redundant with this grant — they answer different questions
 * ("may this app post as me at all" vs "may it post THIS").
 *
 * 🔴 MEMBERSHIP HERE MAKES A SCOPE UN-REVOKABLE, AND A REVOKE CONTROL ON ONE WOULD BE A
 * LIE. `partitionByConsent` below signs on `CONSENT_EXEMPT_SCOPES.has(scope) ||
 * grantedScopes.has(scope)` — the exempt test comes FIRST and never consults the grant —
 * so a suppression entry for a member of this set would be stored and enforce NOTHING.
 * `blocks.revokeScopes` therefore REFUSES every member of this set with a specific error rather than
 * accepting and silently doing nothing, and phase 3's UI must not offer a control for
 * them. Making revocation override exemption is deliberately NOT the design: each
 * exemption above rests on its own server-side gate (min-trust, moderation,
 * visibility/ownership, self-bound subject, rate limits), and removing the scope would
 * not remove those gates' subject matter — it would only break the #3090 page-token fix.
 * The scopes a revoke DOES reach are the gated ones: notably `ai:write:budgeted`,
 * `collections:read:private`, `posts:write:self`.
 */
const CONSENT_EXEMPT_SCOPES = new Set([
  // NOTE: block:settings:* is intentionally ABSENT — those scopes were removed
  // from the block-scope registry (decorative/unenforced). Do NOT re-add them
  // here: if a settings scope is ever reintroduced it must be reintroduced WITH
  // an explicit consent decision, not silently exempted (a stale exempt entry
  // would mint it consent-free the moment it re-entered the registry).
  'apps:storage:read',
  'apps:storage:write',
  // SHARED (cross-user) storage — governed by resolveSharedContext's server-side
  // min-trust gate + content moderation + rate limits, not per-scope consent.
  'apps:storage:shared:read',
  'apps:storage:shared:write',
  'models:read:self',
  // Collections — server-side visibility/ownership (read) + self-bound subject
  // (follow) are the gate; see the block collections endpoints. #3090: exempting
  // them guarantees they reach `claims.scopes` in the minted page token.
  'collections:read:self',
  'collections:write:self',
  // goods:read:self — the app's OWN sales ledger, filtered to this viewer. The
  // read is scoped to `claims.appBlockId` in the query, so it can only ever
  // return what the calling app itself sold; there is no third-party data to
  // consent to. Its sibling `goods:purchase:self` is deliberately ABSENT — money
  // out of the viewer's balance always needs an explicit grant.
  'goods:read:self',
  // apps:store:items:write — gated per call server-side; a consent gate here would only drop
  // the scope from tokens.
  'apps:store:items:write',
]);

export function partitionByConsent(
  requestedScopes: string[],
  grantedScopes: Set<string>
): { signable: string[]; missing: string[] } {
  const signable: string[] = [];
  const missing: string[] = [];
  for (const scope of requestedScopes) {
    if (CONSENT_EXEMPT_SCOPES.has(scope) || grantedScopes.has(scope)) {
      signable.push(scope);
    } else {
      missing.push(scope);
    }
  }
  return { signable, missing };
}

/**
 * The consent-gated subset of a scope list — the scopes that REQUIRE a grant
 * (i.e. excluding the consent-exempt publisher/ambient scopes). Used by the
 * install/subscribe paths so the implicit first-consent grant doesn't bother
 * recording exempt scopes (they're not consulted at mint anyway).
 */
export function consentGatedScopes(scopes: string[]): string[] {
  return scopes.filter((s) => !CONSENT_EXEMPT_SCOPES.has(s));
}

/**
 * Whether a scope is signed WITHOUT a grant, and therefore cannot be revoked.
 *
 * 🔴 ONE PREDICATE, THREE CONSUMERS, AND THAT IS WHY IT IS EXPORTED RATHER THAN
 * OPEN-CODED. `consentGatedScopes` (the install/anon-strip filter), `partitionByConsent`
 * (the mint) and `blocks.revokeScopes`'s refusal all have to agree about the same set
 * strings. Open-coded at the router it would drift from the set the mint actually
 * consults, and the drift is silent in the dangerous direction: a scope the router
 * thought was revokable gets a suppression entry that `partitionByConsent` never reads,
 * so the UI reports success and the app keeps the permission.
 *
 * Exported as a FUNCTION, not as the Set. The Set is mutable and a caller holding it
 * could add a member — which would consent-exempt a gated scope at mint, the one change
 * in this file that silently widens what a token carries.
 */
export function isConsentExemptScope(scope: string): boolean {
  return CONSENT_EXEMPT_SCOPES.has(scope);
}

/**
 * The exempt set, as a sorted array, for tests and for an error message that needs to
 * name what it refused. A COPY — see `isConsentExemptScope` for why the Set itself is
 * never handed out.
 */
export function consentExemptScopeList(): string[] {
  return Array.from(CONSENT_EXEMPT_SCOPES).sort();
}
