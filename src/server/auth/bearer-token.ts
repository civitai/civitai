import type { Session } from '~/types/session';
import { getSessionUser } from './session-user';
import { generateSecretHash } from '~/server/utils/key-generator';
import { dbRead, dbWrite } from '~/server/db/client';
import type { Subject } from '~/server/http/orchestrator/api-key-spend';
import type { BuzzLimit } from '~/server/schema/api-key.schema';

const LAST_USED_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour — don't update more frequently than this

export async function getSessionFromBearerToken(key: string) {
  const token = generateSecretHash(key.trim());

  // Look up the API key to get userId, tokenScope, and buzzLimit
  const now = new Date();
  const apiKey = await dbWrite.apiKey.findFirst({
    where: { key: token, OR: [{ expiresAt: { gte: now } }, { expiresAt: null }] },
    select: {
      id: true,
      userId: true,
      tokenScope: true,
      lastUsedAt: true,
      buzzLimit: true,
      clientId: true,
    },
  });
  if (!apiKey) return null;

  // Update lastUsedAt (debounced — at most once per hour, fire-and-forget)
  if (!apiKey.lastUsedAt || now.getTime() - apiKey.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    dbWrite.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: now } }).catch(() => {});
  }

  const user = (await getSessionUser({ userId: apiKey.userId })) as Session['user'];
  if (!user) return null;

  // Resolve subject + buzzLimit. OAuth-issued tokens use the consent
  // (userId + clientId) as the stable identifier across access-token rotations
  // and read their limit from OauthConsent. User-type API keys use the
  // ApiKey row's own id and buzzLimit.
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
    subject,
    tokenScope: apiKey.tokenScope,
    buzzLimit,
  } as Session & {
    apiKeyId: number;
    subject: Subject;
    tokenScope: number;
    buzzLimit: BuzzLimit | null;
  };
}
