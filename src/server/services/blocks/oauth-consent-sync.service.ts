import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { bustBuzzLimitCache, deleteAuthSubject } from '~/server/http/orchestrator/api-key-spend';
import { logToAxiom, safeError } from '~/server/logging/client';
import { simpleBuzzLimitToBudgets, type BuzzLimit } from '~/server/schema/api-key.schema';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';
import { consentGatedScopes, getConsentBuzzBudget } from './scope-grant.service';

export interface OauthConsentMirror {
  clientId: string;
  scope: number;
}

/**
 * OAuth bitmask for a set of CONSENTED block scopes; block-only scopes
 * (SKIP_OAUTH_CHECK, i.e. no bitmask bit) are skipped.
 *
 * 🔴 #5127 — this used to seed the bitmask with `TokenScope.UserRead`, mirroring
 * the mandatory-baseline invariant that `createOAuthTokenPair` documents. That
 * was the bug, because the `OauthConsent` row this bitmask lands in is the ONLY
 * thing standing between a caller and a minted token: the hub
 * (`apps/auth/src/routes/api/auth/oauth/app-token/+server.ts`) forces
 * `scope |= TokenScope.UserRead` and then refuses unless
 * `hasScope(consent.scope, scope)`. Seeding the bit here made that check validate
 * a record the platform had manufactured one step earlier, so an `auth: "oauth"`
 * block received a token that reads the viewer's email / emailVerified /
 * isModerator from `/api/v1/me` while the SAME mint response reported
 * `user:read:self` in `missingScopes`.
 *
 * The baseline invariant is untouched where it belongs — on the TOKEN. Both
 * `oauthScopeBitsFor` (mint request) and the hub itself still force the bit on,
 * so no OAuth token is ever scope-less. What changed is the CONSENT RECORD: it now
 * states only what the viewer actually granted.
 *
 * The consequence is deliberate and is the point of the fix: because every OAuth
 * app token carries `UserRead`, one can only be minted for a viewer who granted
 * `user:read:self`. Everyone else falls back to the block JWT with the
 * needs-consent signal (#5097's documented `consent_required` path), which the
 * host turns into a prompt via `resolveRequestConsent` + `BlockConsentModal`.
 *
 * KNOWN GAP (deliberately not papered over here): an `auth: "oauth"` manifest that
 * does not declare `user:read:self` at all can therefore never mint an OAuth token
 * — it silently keeps the block JWT, because there is no scope for the host to
 * prompt for. That manifest is misdeclared (the token it asked for unavoidably
 * carries `UserRead`), and the right place to say so is the manifest validator,
 * not a forced bit here.
 */
export function blockScopesToOauthScope(scopes: Iterable<string>): number {
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
 * Mirrors the viewer's block grant into the OauthConsent row the auth hub and
 * orchestrator read. Returns `null` — writing nothing — when there is nothing to
 * mirror, which the mint caller turns into `consent_required` and the block-JWT
 * fallback.
 */
export async function syncOauthConsentFromGrant(opts: {
  userId: number;
  appBlockId: string;
  /**
   * Scopes the caller will ask a token for. Only the CONSENT-EXEMPT ones are
   * mirrored from here: those need no grant by definition and the grant row never
   * records them. A consent-GATED scope passed in this list is IGNORED — the grant
   * row is the sole authority for those, so a caller cannot manufacture consent for
   * a scope the viewer never granted. (Today's only mint caller already pre-filters
   * through `partitionByConsent`, but that is the caller's guarantee, not this
   * function's; #5127 is what trusting the caller cost.)
   */
  scopes?: Iterable<string>;
}): Promise<OauthConsentMirror | null> {
  const { userId, appBlockId, scopes = [] } = opts;
  const [block, grant] = await Promise.all([
    dbRead.appBlock.findUnique({ where: { id: appBlockId }, select: { appId: true } }),
    // Primary: this runs right after the grant write it mirrors.
    dbWrite.appUserScopeGrant.findUnique({
      where: { userId_appBlockId: { userId, appBlockId } },
      select: { grantedScopes: true, revokedAt: true },
    }),
  ]);
  // 🔴 #5127: this read `grant?.revokedAt`, which is `undefined` — falsy — for a
  // viewer who has NEVER granted anything, so the guard did not fire and an
  // `OauthConsent` row was written for a viewer who consented to nothing. A MISSING
  // grant row and a REVOKED one are the same answer: there is no consent to mirror.
  // Both must write nothing and return null, so the caller reaches the
  // `consent_required` fallback instead of a manufactured record.
  if (!block || !grant || grant.revokedAt) return null;

  const clientId = block.appId;
  const requested = [...scopes];
  const gated = new Set(consentGatedScopes(requested));
  const consented = [...grant.grantedScopes, ...requested.filter((s) => !gated.has(s))];
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
