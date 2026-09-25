import { mintAppToken } from '@civitai/auth';
import { dbWrite } from '~/server/db/client';
import { simpleBuzzLimitToBudgets } from '~/server/schema/api-key.schema';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';
import { oauthScopeBitsFor } from '~/server/services/blocks/block-oauth-scope';
import { DEV_TUNNEL_SESSION_BUZZ_CAP } from '~/server/services/blocks/dev-tunnel-session';
import { writeOauthConsent } from '~/server/services/blocks/oauth-consent-sync.service';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';

const DEV_CLIENT_PREFIX = 'appdev-';

/** The OAuth client a never-submitted app borrows in its author's tunnel; a submitted app has its own. */
export function devTunnelClientId(userId: number, slug: string): string {
  return `${DEV_CLIENT_PREFIX}${userId}-${slug}`;
}

export function parseDevTunnelClientId(clientId: string): { userId: number; slug: string } | null {
  if (!clientId.startsWith(DEV_CLIENT_PREFIX)) return null;
  const match = /^(\d{1,12})-(.+)$/.exec(clientId.slice(DEV_CLIENT_PREFIX.length));
  if (!match) return null;
  const slug = match[2];
  if (slug.length < 3 || slug.length > 40 || !SLUG_REGEX.test(slug)) return null;
  return { userId: Number(match[1]), slug };
}

/** Which of `scopes` a consent bitmask covers; block-only scopes have no bit and pass through. */
export function scopesCoveredByConsent(scopes: readonly string[], consentScope: number): string[] {
  return scopes.filter((scope) => {
    const bit = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    return typeof bit !== 'number' || (consentScope & bit) === bit;
  });
}

export interface DevTunnelOauthMint {
  token: string;
  expiresAt: string;
}

/**
 * The author is the only viewer of their own tunnel, so consent is written for
 * them directly rather than collected through the dialog.
 */
export async function mintDevTunnelOauthToken(opts: {
  userId: number;
  clientId: string;
  scopes: readonly string[];
}): Promise<DevTunnelOauthMint> {
  const { userId, clientId, scopes } = opts;
  const scope = oauthScopeBitsFor([...scopes]);

  const dev = parseDevTunnelClientId(clientId);
  if (dev) {
    if (dev.userId !== userId) throw new Error('dev tunnel client belongs to another user');
    await dbWrite.oauthClient.upsert({
      where: { id: clientId },
      create: {
        id: clientId,
        secret: null,
        name: `Dev tunnel: ${dev.slug}`,
        description: 'Your own dev tunnel for this app. Only you can use it.',
        redirectUris: [],
        allowedOrigins: [],
        isConfidential: false,
        grants: [],
        allowedScopes: scope,
        userId,
      },
      update: { allowedScopes: scope },
      select: { id: true },
    });
  }

  const buzzLimit = scopes.includes('ai:write:budgeted')
    ? simpleBuzzLimitToBudgets({ limit: DEV_TUNNEL_SESSION_BUZZ_CAP, period: 'day' })
    : null;
  await writeOauthConsent({ userId, clientId, scope, buzzLimit });

  const minted = await mintAppToken({ userId, clientId, scope });
  return { token: minted.accessToken, expiresAt: minted.expiresAt };
}
