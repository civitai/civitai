import type { Session } from '~/types/session';
import { sessionClient } from './session-client';
import { generateSecretHash } from '~/server/utils/key-generator';
import { dbRead, dbWrite } from '~/server/db/client';
import type { Subject } from '~/server/http/orchestrator/api-key-spend';
import type { BuzzLimit } from '~/server/schema/api-key.schema';
import { allowsModeratorWriteKeys, isSystemAccountMeta } from '@civitai/auth';
import { refuseModerationAccountSession } from '~/server/auth/moderation-account';
import { holdsModeratorAccess } from '~/server/auth/moderator-access';
import { isOrchestratorServiceToken } from '~/server/auth/orchestrator-service-token';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import {
  CLIENT_CREDENTIALS_ONLY_SCOPES,
  TokenScopePresets,
} from '~/shared/constants/token-scope.constants';
import {
  cacheApiKey,
  claimLastUsedWrite,
  readCachedApiKey,
  releaseLastUsedWrite,
  startLookup,
} from './api-key-principal-cache';

export type BearerTokenOptions = {
  /** Accept a client-credentials token; only the catalog endpoints pass this. */
  allowClientCredentialsOnly?: boolean;
};

/**
 * The session a bearer credential stands for, or null. A client-credentials token is
 * single-purpose: it resolves to no session unless the caller opts in.
 */
export async function getSessionFromBearerToken(key: string, options: BearerTokenOptions = {}) {
  // A per-provider download token (`<provider>:<secret>`) is accepted by the download route alone
  // and never stands for a session. No API key contains `:`.
  if (key.includes(':')) return null;
  // The orchestrator service token is not an API key; answer as for any unknown key without the
  // lookup.
  if (isOrchestratorServiceToken(key.trim())) return null;
  const token = generateSecretHash(key.trim());

  const now = new Date();
  const lookup = startLookup();
  // Personal and system keys are served from a short-lived Redis copy of this row; see
  // api-key-principal-cache.ts for what may be cached and how a revocation evicts it. A miss, a
  // revoked or expired entry, or any Redis error reads the primary exactly as before.
  const cached = await readCachedApiKey(token, now);
  let apiKey = cached.apiKey;
  if (!apiKey) {
    apiKey = await dbWrite.apiKey.findFirst({
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
        expiresAt: true,
      },
    });
    if (apiKey && cached.fill) await cacheApiKey(token, apiKey, lookup);
  }
  if (!apiKey) return null;
  if (
    !options.allowClientCredentialsOnly &&
    ((apiKey.tokenScope ?? 0) & CLIENT_CREDENTIALS_ONLY_SCOPES) !== 0
  ) {
    return null;
  }

  // Update lastUsedAt (debounced — at most once per hour per key, fire-and-forget)
  if (await claimLastUsedWrite(apiKey, now)) {
    const id = apiKey.id;
    dbWrite.apiKey
      .update({ where: { id }, data: { lastUsedAt: now } })
      .catch(() => releaseLastUsedWrite(id));
  }

  const user = (await sessionClient.getSessionUserById(apiKey.userId)) as Session['user'] | null;
  if (!user) return null;

  // Banned users get NO API/bearer access. Deleted users are already excluded by the hub producer (deletedAt
  // is null), but a
  // ban leaves the row intact (so the SESSION/cookie path can still render a "you're banned" page) — the
  // bearer/API path must reject it CENTRALLY here, mirroring tRPC's isAuthed ban check, so a banned user's
  // OAuth token or personal API key can't keep hitting any /api/v1 handler that forgets to re-check.
  if (user.bannedAt) return null;
  if (refuseModerationAccountSession(user, 'bearer-token')) return null;
  // A system account with moderator access authenticates with read-only keys only, unless an admin
  // has allowed it write keys. Both are read from the primary, not the session copy, so a grant
  // counts as soon as it lands.
  if (
    isSystemAccountMeta(user.meta) &&
    ((apiKey.tokenScope ?? 0) & ~TokenScopePresets.ReadOnly) !== 0
  ) {
    const access = await dbWrite.user.findUnique({
      where: { id: user.id },
      select: { meta: true, isModerator: true, roles: { select: { role: true } } },
    });
    if (
      !access ||
      (!allowsModeratorWriteKeys(access.meta) &&
        (await holdsModeratorAccess({
          isModerator: access.isModerator,
          roles: access.roles.map(({ role }) => role),
        })))
    )
      return null;
  }

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
    // A cached row went through JSON, so its date may be a string.
    expiresAt: apiKey.expiresAt ? new Date(apiKey.expiresAt) : null,
  } as Session & {
    apiKeyId: number;
    apiKeyType: ApiKeyType;
    subject: Subject;
    tokenScope: number;
    buzzLimit: BuzzLimit | null;
    /** When the credential stops being accepted; null for one that never expires. */
    expiresAt: Date | null;
  };
}
