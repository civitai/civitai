import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { bustBuzzLimitCache, deleteAuthSubject } from '~/server/http/orchestrator/api-key-spend';
import { logToAxiom, safeError } from '~/server/logging/client';
import { simpleBuzzLimitToBudgets, type BuzzLimit } from '~/server/schema/api-key.schema';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  consentGatedScopes,
  getConsentBuzzBudget,
  isMissingColumnError,
  liveGrantedScopes,
  logMissingRevokedScopesColumn,
} from './scope-grant.service';

export interface OauthConsentMirror {
  clientId: string;
  scope: number;
}

/**
 * OAuth bitmask for a set of CONSENTED block scopes; block-only scopes
 * (SKIP_OAUTH_CHECK, i.e. no bitmask bit) contribute nothing.
 *
 * 🔴 #5127 — THE SEED IS LOAD-BEARING, DO NOT PUT IT BACK. This used to start at
 * `TokenScope.UserRead`, mirroring the mandatory-baseline invariant that
 * `createOAuthTokenPair` documents. Two things depend on it now starting at 0, and
 * the second is easy to miss:
 *
 *  1. ROW CONTENTS. The `OauthConsent` row this lands in is the only thing between
 *     a caller and a minted token — the hub's `app-token` route forces
 *     `scope |= TokenScope.UserRead` and then refuses unless
 *     `hasScope(consent.scope, scope)`. Seeding the bit made that check validate a
 *     record the platform had manufactured one step earlier.
 *  2. THE MINT PREDICATE in `syncOauthConsentFromGrant` below, which asks
 *     `blockScopesToOauthScope(grant.grantedScopes) & TokenScope.UserRead`. With the
 *     seed restored that mask is ALWAYS non-zero, so the predicate can never fire
 *     and the guard becomes vacuous while still reading like a guard. The seed drop
 *     is what makes it reachable at all.
 *
 * The baseline invariant is untouched where it belongs — on the TOKEN. Both
 * `oauthScopeBitsFor` (the mint request) and the hub itself still force the bit on,
 * so no OAuth token is ever scope-less.
 *
 * Module-private on purpose: the only legitimate consumers are in this file. Export
 * it again and the seed becomes someone else's invariant to break.
 */
function blockScopesToOauthScope(scopes: Iterable<string>): number {
  let scope = 0;
  for (const s of scopes) {
    const bit = BLOCK_SCOPE_TO_OAUTH_BIT[s];
    if (typeof bit === 'number') scope |= bit;
  }
  return scope;
}

function sameLimit(a: BuzzLimit | null, b: BuzzLimit | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The grant row this mirror needs, P2022-tolerant.
 *
 * 🔴 WITHOUT THIS THE MIRROR HARD-FAILED ON THE PRE-MIGRATION DATABASE — which is production
 * as this ships. Widening the select to `revoked_scopes` (correct, and the point of the fix)
 * made this the ONE reader of these columns with no fallback, inside a `Promise.all` whose
 * rejection propagates out of `syncOauthConsentFromGrant`. Its callers do not catch:
 * `block-tokens/index.ts` awaits it on the OAuth mint AND on the page-load mint, and
 * `blocks.grantScopes` awaits it after a successful consent write. So between deploy and a
 * human applying the migration, every mint for an `auth: "oauth"` app 500'd instead of
 * degrading — and the migration header in the same commit asserted "the revoke MUTATION is
 * therefore unavailable until this lands; nothing else is", which that made false.
 *
 * `liveGrantedScopes` was given an OPTIONAL `revokedScopes` precisely so a narrow-select row
 * works here: absent column ⇒ no revocation can ever have been recorded ⇒ `undefined` means
 * "none", which is the only state such a database can be in. Only P2022 is caught; anything
 * else still propagates, because for those the suppression list is UNKNOWN rather than absent.
 */
async function readGrantForMirror(
  userId: number,
  appBlockId: string
): Promise<{ grantedScopes: string[]; revokedAt: Date | null; revokedScopes?: string[] } | null> {
  const where = { userId_appBlockId: { userId, appBlockId } };
  try {
    return (await dbWrite.appUserScopeGrant.findUnique({
      where,
      select: { grantedScopes: true, revokedAt: true, revokedScopes: true },
    })) as { grantedScopes: string[]; revokedAt: Date | null; revokedScopes: string[] } | null;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    logMissingRevokedScopesColumn('syncOauthConsentFromGrant', err);
    return (await dbWrite.appUserScopeGrant.findUnique({
      where,
      select: { grantedScopes: true, revokedAt: true },
    })) as { grantedScopes: string[]; revokedAt: Date | null } | null;
  }
}

/**
 * Mirrors the viewer's block grant into the OauthConsent row the auth hub and
 * orchestrator read. Returns `null` — writing NOTHING — whenever the viewer's
 * consent cannot support an OAuth token, which the mint caller turns into
 * `consent_required` and the block-JWT fallback.
 *
 * 🔴 #5127 — "writes nothing" is the contract, not an optimisation. A row this
 * function writes that cannot mint is worse than no row: it is listed to the viewer
 * by `oauthConsent.getConnectedApps` as an app they authorized, it carries a
 * `buzzLimit`, and it would begin minting the moment anything ever ORed `UserRead`
 * into it. Both refusal arms below therefore write nothing rather than write a
 * narrower row.
 */
export async function syncOauthConsentFromGrant(opts: {
  userId: number;
  appBlockId: string;
  /**
   * Scopes the caller will ask a token for. Only the CONSENT-EXEMPT ones are
   * mirrored from here: those need no grant by definition and the grant row never
   * records them.
   *
   * A consent-GATED scope in this list is IGNORED. ⚠️ DEFENCE IN DEPTH WITH NO
   * REACHABLE PATH TODAY — not coverage: the only mint caller passes
   * `partitionByConsent(...).signable`, so every gated scope this filter would strip
   * is already present in the grant's LIVE set, read from the same `dbWrite`
   * client. It is kept because the grant row is the right sole authority for gated
   * scopes, so a FUTURE caller passing a raw manifest list cannot ask this function
   * to assert `AIServicesWrite` / `BuzzRead` / `SocialTip` consent that does not
   * exist. `UserRead` specifically does not rely on it — the mint predicate below
   * reads `grant.grantedScopes` directly.
   */
  scopes?: Iterable<string>;
}): Promise<OauthConsentMirror | null> {
  const { userId, appBlockId, scopes = [] } = opts;
  const [block, grant] = await Promise.all([
    dbRead.appBlock.findUnique({ where: { id: appBlockId }, select: { appId: true } }),
    // Primary: this runs right after the grant write it mirrors.
    //
    // 🔴 `revokedScopes` IS SELECTED AND SUBTRACTED BELOW. Omitting it was a live fail-open:
    // this is the ONE read of the grant row that did not honour the per-scope suppression
    // list, on the surface the revoke mutation itself calls "a SECOND ENFORCEMENT SURFACE".
    // The chain review found: viewer revokes `ai:write:budgeted` (row loses it from
    // `granted_scopes`, gains it in `revoked_scopes`, `buzz_budget_per_day` → NULL, mirror
    // deleted) → viewer installs the app again → `recordInstallConsent` UNIONS the whole
    // consent-gated set back into `granted_scopes` → the next mint calls this function,
    // which read the RAW column and wrote an `OauthConsent` row carrying
    // `TokenScope.AIServicesWrite` with `buzzLimit: null`. `src/server/auth/bearer-token.ts`
    // resolves every OAuth bearer's spend ceiling from that `buzzLimit`, so the viewer's
    // revoke had removed their own cap and left it removed DURABLY — which is exactly what
    // `revokeOauthConsentForBlock` exists to prevent.
    readGrantForMirror(userId, appBlockId),
  ]);
  // 🔴 #5127: this read `grant?.revokedAt`, which is `undefined` — falsy — for a
  // viewer who has NEVER granted anything, so the guard did not fire and an
  // `OauthConsent` row was written for a viewer who consented to nothing. A MISSING
  // grant row and a REVOKED one are the same answer: there is no consent to mirror.
  // Both must write nothing and return null, so the caller reaches the
  // `consent_required` fallback instead of a manufactured record.
  if (!block || !grant || grant.revokedAt) return null;

  // 🔴 THE LIVE GRANTED SET, `granted_scopes ∖ revoked_scopes` — the same projection
  // `getGrantedScopes` applies, and the reason the whole design can say "a scope listed in
  // `revoked_scopes` is subtracted at EVERY read". Everything below reads `live`, never
  // `grant.grantedScopes`.
  //
  // ⚠️ NOT `getGrantedScopes` ITSELF, deliberately: that would be a THIRD round trip to the
  // same unique key (this function already reads the row, in parallel with the AppBlock
  // read, precisely to avoid one). The projection is shared instead — see
  // `liveGrantedScopes` in `scope-grant.service.ts`, which both callers use, so the rule has
  // one statement rather than two that agree by coincidence.
  const live = liveGrantedScopes(grant);

  // 🔴 #5127, SECOND SHAPE — a grant row EXISTS but does not carry the baseline. The
  // guard above is not enough: for a viewer who granted, say, `ai:write:budgeted` but
  // not `user:read:self` (exactly the "a v2 manifest adds a scope" case the per-user
  // grant gate exists for), the row written below would be one the hub can never mint
  // against, while the same mint response reports `user:read:self` as missing. Refuse
  // here instead, so no unmintable row is written at all — see the contract above for
  // why a narrower row is worse than none.
  //
  // Reads the GRANT alone: the caller-supplied `scopes` must not be able to answer this.
  // Depends on `blockScopesToOauthScope` starting at 0 — restore the `UserRead` seed and this
  // mask is always non-zero and the guard never fires.
  if (!(blockScopesToOauthScope(live) & TokenScope.UserRead)) return null;

  const clientId = block.appId;
  const requested = [...scopes];
  const gated = new Set(consentGatedScopes(requested));
  const consented = [...live, ...requested.filter((s) => !gated.has(s))];
  const scope = blockScopesToOauthScope(consented);
  const budget = await getConsentBuzzBudget({ userId, appBlockId });
  const buzzLimit = simpleBuzzLimitToBudgets(
    budget == null ? null : { limit: budget, period: 'day' }
  );

  await writeOauthConsent({ userId, clientId, scope, buzzLimit });
  return { clientId, scope };
}

export async function writeOauthConsent(opts: {
  userId: number;
  clientId: string;
  scope: number;
  buzzLimit: BuzzLimit | null;
}): Promise<void> {
  const { userId, clientId, scope, buzzLimit } = opts;
  const existing = await dbWrite.oauthConsent.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { buzzLimit: true },
  });
  await dbWrite.oauthConsent.upsert({
    where: { userId_clientId: { userId, clientId } },
    create: { userId, clientId, scope, buzzLimit: buzzLimit ?? Prisma.DbNull },
    update: { scope, buzzLimit: buzzLimit ?? Prisma.DbNull },
    select: { id: true },
  });

  if (existing && !sameLimit(existing.buzzLimit as BuzzLimit | null, buzzLimit)) {
    try {
      await bustBuzzLimitCache({ userId, subject: { type: 'oauth', id: clientId } });
    } catch (err) {
      logToAxiom({
        type: 'oauth.bust-cache.failed',
        message: `bust-cache failed for oauth client ${clientId} user ${userId}`,
        error: safeError(err),
      }).catch(() => undefined);
    }
  }
}

export async function revokeOauthConsentForBlock(opts: {
  userId: number;
  appBlockId: string;
}): Promise<void> {
  const { userId, appBlockId } = opts;
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { appId: true },
  });
  if (!block) return;
  const clientId = block.appId;

  // Without this a still-valid hub token would outlive the consent and read back a null
  // buzzLimit, i.e. spend with no consent cap.
  await dbWrite.apiKey.deleteMany({
    where: { userId, clientId, type: { in: ['Access', 'Refresh'] } },
  });
  await dbWrite.oauthConsent.deleteMany({ where: { userId, clientId } });

  deleteAuthSubject({ userId, subject: { type: 'oauth', id: clientId } }).catch((err) => {
    logToAxiom({
      type: 'oauth.delete-subject.failed',
      message: `delete-subject failed for oauth client ${clientId} user ${userId}`,
      error: safeError(err),
    }).catch(() => undefined);
  });
  await invalidateCivitaiUser({ userId });
}
