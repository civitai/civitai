import type { NextApiRequest, NextApiResponse } from 'next';

import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { dbRead } from '~/server/db/client';
import {
  resolveCatalogParentId,
  SubListingError,
  subListingErrorResponse,
} from '~/server/services/blocks/app-sub-listing.service';
import { requestCarriesQueryToken } from '~/server/utils/request-query-token';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';

export type CatalogCaller = { clientId: string; parentListingId: string };

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

/**
 * The caller of a `/api/v1/catalog/items` endpoint: an OAuth client acting as itself (a
 * `client_credentials` access token carrying `AppStoreCatalogWrite`), and the one off-site
 * listing linked to that client. The token comes from the `Authorization` header only; cookies
 * and `?token=` are never read.
 */
export async function resolveCatalogCaller(req: NextApiRequest): Promise<CatalogCaller> {
  const invalid = () =>
    new SubListingError(401, 'invalid_token', 'A valid catalog access token is required');
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? BEARER_RE.exec(header) : null;
  if (!match || requestCarriesQueryToken(req)) throw invalid();

  const session = await getSessionFromBearerToken(match[1], { allowClientCredentialsOnly: true });
  if (
    !session?.user ||
    session.apiKeyType !== ApiKeyType.Access ||
    session.subject.type !== 'oauth' ||
    typeof session.subject.id !== 'string'
  ) {
    throw invalid();
  }
  const clientId = session.subject.id;

  const insufficient = () =>
    new SubListingError(
      403,
      'insufficient_scope',
      'The token must be a client_credentials token carrying AppStoreCatalogWrite'
    );
  if (!Flags.hasFlag(session.tokenScope, TokenScope.AppStoreCatalogWrite)) throw insufficient();

  // The token is the client acting as itself: issued to the client's owner, by a client that
  // holds the grant.
  const client = await dbRead.oauthClient.findUnique({
    where: { id: clientId },
    select: { userId: true, grants: true },
  });
  if (
    !client ||
    client.userId !== session.user.id ||
    !client.grants.includes('client_credentials')
  ) {
    throw insufficient();
  }

  return { clientId, parentListingId: await resolveCatalogParentId(clientId) };
}

/**
 * A catalog endpoint: authenticates the caller, runs `handler` with it, and answers every
 * `SubListingError` (the caller's own or the handler's) with its status and code.
 */
export function catalogEndpoint(
  methods: readonly string[],
  handler: (req: NextApiRequest, res: NextApiResponse, caller: CatalogCaller) => Promise<void>
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (!req.method || !methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      await handler(req, res, await resolveCatalogCaller(req));
    } catch (err) {
      const mapped = subListingErrorResponse(err);
      if (!mapped) throw err;
      if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      res.status(mapped.status).json(mapped.body);
    }
  };
}
