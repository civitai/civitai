import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { bustBuzzLimitCache, deleteAuthSubject } from '~/server/http/orchestrator/api-key-spend';
import { logToAxiom, safeError } from '~/server/logging/client';
import { simpleBuzzLimitToBudgets, type BuzzLimit } from '~/server/schema/api-key.schema';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { getConsentBuzzBudget } from './scope-grant.service';

export interface OauthConsentMirror {
  clientId: string;
  scope: number;
}

/** OAuth bitmask for a set of block scopes; block-only scopes (no bit) are skipped. */
export function blockScopesToOauthScope(scopes: Iterable<string>): number {
  let scope: number = TokenScope.UserRead;
  for (const s of scopes) {
    const bit = BLOCK_SCOPE_TO_OAUTH_BIT[s];
    if (typeof bit === 'number') scope |= bit;
  }
  return scope;
}

function sameLimit(a: BuzzLimit | null, b: BuzzLimit | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Mirrors the viewer's block grant into the OauthConsent row the auth hub and orchestrator read. */
export async function syncOauthConsentFromGrant(opts: {
  userId: number;
  appBlockId: string;
  /** Scopes the caller will ask a token for; consent-exempt ones never reach the grant row. */
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
  if (!block || grant?.revokedAt) return null;

  const clientId = block.appId;
  const scope = blockScopesToOauthScope([...(grant?.grantedScopes ?? []), ...scopes]);
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
