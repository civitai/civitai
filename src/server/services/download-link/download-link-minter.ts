import type { NextApiRequest } from 'next';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { dbRead, dbWrite } from '~/server/db/client';
import type { DownloadLinkCredential } from '~/server/services/download-link/download-link.store';
import {
  isAllowlistedMinter,
  secretEpoch,
} from '~/server/services/download-link/download-link.store';
import { getRequestCredential } from '~/server/auth/request-credential';
import { requestCarriesQueryToken } from '~/server/utils/request-query-token';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

export type MinterResolution =
  | { ok: true; credential: DownloadLinkCredential }
  | { ok: false; status: 401 | 403 };

/**
 * The credential minting download links: a `client_credentials` token carrying `DownloadLink` from
 * an OauthClient on `DOWNLOAD_LINK_CLIENT_IDS`, or an ApiKey on `DOWNLOAD_LINK_API_KEY_IDS`. The
 * token comes from the `Authorization` header only; cookies and `?token=` are never read.
 */
export async function resolveDownloadLinkMinter(req: NextApiRequest): Promise<MinterResolution> {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? BEARER_RE.exec(header) : null;
  if (!match || requestCarriesQueryToken(req)) return { ok: false, status: 401 };

  const session = await getSessionFromBearerToken(match[1], { allowClientCredentialsOnly: true });
  if (!session?.user) return { ok: false, status: 401 };

  if (session.subject.type === 'oauth') {
    const credential: DownloadLinkCredential = { kind: 'client', id: String(session.subject.id) };
    if (
      session.apiKeyType !== ApiKeyType.Access ||
      !Flags.hasFlag(session.tokenScope, TokenScope.DownloadLink) ||
      !isAllowlistedMinter(credential)
    )
      return { ok: false, status: 403 };
    // The token is the client acting as itself: issued to the client's owner, by a client that
    // holds the grant.
    const client = await dbRead.oauthClient.findUnique({
      where: { id: credential.id },
      select: { userId: true, grants: true, secret: true },
    });
    if (
      !client ||
      client.userId !== session.user.id ||
      !client.grants.includes('client_credentials')
    )
      return { ok: false, status: 403 };
    // Read after the secret: a rotation expires the client's tokens before changing it, so a
    // token still live here was not expired by a rotation whose secret was just read.
    const now = new Date();
    const tokenLive = await dbWrite.apiKey.findFirst({
      where: { id: session.apiKeyId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { id: true },
    });
    if (!tokenLive) return { ok: false, status: 401 };
    return { ok: true, credential: { ...credential, epoch: secretEpoch(client.secret) } };
  }

  const credential: DownloadLinkCredential = { kind: 'apikey', id: String(session.apiKeyId) };
  if (!isAllowlistedMinter(credential)) return { ok: false, status: 403 };
  return { ok: true, credential };
}

/**
 * The personal ApiKey a request authenticated with through its `Authorization` header, as a link
 * credential; null for anything else. Reads `req.context`, so it runs after the session resolves.
 */
export function headerApiKeyCredential(req: NextApiRequest): DownloadLinkCredential | null {
  if (!req.headers.authorization || requestCarriesQueryToken(req)) return null;
  const { apiKeyId, subject } = getRequestCredential(req);
  if (subject?.type !== 'apiKey' || apiKeyId == null) return null;
  return { kind: 'apikey', id: String(apiKeyId) };
}
