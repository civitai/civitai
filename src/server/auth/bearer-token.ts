import type { Session } from '~/types/session';
import { sessionClient } from './session-client';
import { generateSecretHash } from '~/server/utils/key-generator';
import { dbRead, dbWrite } from '~/server/db/client';
import type { Subject } from '~/server/http/orchestrator/api-key-spend';
import type { BuzzLimit } from '~/server/schema/api-key.schema';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { CLIENT_CREDENTIALS_ONLY_SCOPES } from '~/shared/constants/token-scope.constants';

const LAST_USED_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour — don't update more frequently than this

export type BearerTokenOptions = {
  /** Accept a client-credentials token; only the catalog endpoints pass this. */
  allowClientCredentialsOnly?: boolean;
};

/**
 * The session a bearer credential stands for, or null. A client-credentials token is
 * single-purpose: it resolves to no session unless the caller opts in.
 */
export async function getSessionFromBearerToken(key: string, options: BearerTokenOptions = {}) {
  const token = generateSecretHash(key.trim());

  const now = new Date();
  const apiKey = await dbWrite.apiKey.findFirst({
    where: {
      key: token,
      // Refresh tokens share this table and scope with their access token but are not bearer
      // credentials. Allowlisted so a new key type is refused until deliberately added.
      type: { in: [ApiKeyType.System, ApiKeyType.User, ApiKeyType.Access] },
      OR: [{ expiresAt: { gte: now } }, { expiresAt: null }],
    },
    select: {
      id: true,
      userId: true,
      tokenScope: true,
      lastUsedAt: true,
      buzzLimit: true,
      clientId: true,
      type: true,
    },
  });
  if (!apiKey) return null;
  if (
    !options.allowClientCredentialsOnly &&
    ((apiKey.tokenScope ?? 0) & CLIENT_CREDENTIALS_ONLY_SCOPES) !== 0
  ) {
    return null;
  }

  // Update lastUsedAt (debounced — at most once per hour, fire-and-forget)
  if (!apiKey.lastUsedAt || now.getTime() - apiKey.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    dbWrite.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: now } }).catch(() => {});
  }

  const user = (await sessionClient.getSessionUserById(apiKey.userId)) as Session['user'] | null;
  if (!user) return null;

  // Banned users get NO API/bearer access. Deleted users are already excluded by the hub producer (deletedAt
  // is null), but a
  // ban leaves the row intact (so the SESSION/cookie path can still render a "you're banned" page) — the
  // bearer/API path must reject it CENTRALLY here, mirroring tRPC's isAuthed ban check, so a banned user's
  // OAuth token or personal API key can't keep hitting any /api/v1 handler that forgets to re-check.
  if (user.bannedAt) return null;

  // OAuth-issued tokens key their subject on clientId (stable across access-token
  // rotations) and read their limit from the user's OauthConsent. Other keys use
  // the ApiKey row's own id and buzzLimit.
  let subject: Subject;
  let buzzLimit: BuzzLimit | null;
  if (apiKey.clientId) {
    subject = { type: 'oauth', id: apiKey.clientId };
    const consent = await dbRead.oauthConsent.findUnique({
      where: { userId_clientId: { userId: apiKey.userId, clientId: apiKey.clientId } },
      select: { buzzLimit: true },
    });
    buzzLimit = (consent?.buzzLimit as BuzzLimit | null) ?? null;
  } else {
    subject = { type: 'apiKey', id: apiKey.id };
    buzzLimit = (apiKey.buzzLimit as BuzzLimit | null) ?? null;
  }

  return {
    user,
    apiKeyId: apiKey.id,
    apiKeyType: apiKey.type,
    subject,
    tokenScope: apiKey.tokenScope,
    buzzLimit,
  } as Session & {
    apiKeyId: number;
    apiKeyType: ApiKeyType;
    subject: Subject;
    tokenScope: number;
    buzzLimit: BuzzLimit | null;
  };
}
