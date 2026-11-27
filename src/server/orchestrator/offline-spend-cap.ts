import { sql } from 'kysely';
import type { NextApiRequest } from 'next';
import type { kyselyWrite } from '~/server/db/kyselyDb';

type KyselyWrite = typeof kyselyWrite;
import { readRequestBearerToken } from '~/server/auth/request-bearer-token';
import { getRequestCredential, type RequestCredential } from '~/server/auth/request-credential';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type { BuzzLimit } from '~/server/schema/api-key.schema';

// THE CALLER'S OWN KEY, sent to the orchestrator in place of the user's System token, so the
// orchestrator meters the work under that key's subject and holds it to that key's Buzz limit. Two
// cases, each behind its own flag:
//
// - An OAuth access token the auth hub minted from a refresh grant (`ApiKey.mintOrigin = 'refresh'`,
//   renewed by the app with no user present; flag `oauth-offline-grant`; apps/auth offline-grant.ts
//   mints them). Its limit is the consent's `buzzLimit`: the cap the user set on the consent screen's
//   "Stay connected while you're away" line, or later in Connected apps.
// - A personal API key (`User`) with a Buzz limit, used by its own user (flag
//   `user-key-buzz-limit-proxy`). Its limit is the one set on the key.
//
// Nothing is checked here before sending: the orchestrator enforces the limit when work would spend
// past it, and reads (get, query, cancel, whatif) keep working once the limit is spent. Its refusal
// becomes a message naming the limit (api-key-buzz-limit-refusal.ts).
//
// No limit (a null or empty `buzzLimit`) changes nothing: null has always meant "no limit" for this
// column (`buzzLimitSchema`). Flag off, another credential, or a moderator fetching another user's
// token: null, and getOrchestratorToken sends the System token as before. Only flag-on code reads
// `mintOrigin` (a no-type column, see schema.full.prisma).

/** What `getServerAuthSession` recorded on the request beside the credential. */
type RequestContext = { buzzLimit?: unknown; session?: { user?: { id?: number } } | null };

/** What the rule reads off one request. */
export interface OwnKeyRequest {
  /** The user the orchestrator token is for. */
  userId: number;
  credential: Pick<RequestCredential, 'subject' | 'apiKeyId' | 'apiKeyType'>;
  /** The request's session user; differs from `userId` on a moderator path. */
  sessionUserId: number | undefined;
  /** The key's or consent's limit as the bearer lookup read it (`req.context.buzzLimit`). */
  buzzLimit: BuzzLimit | null;
  /** Read only once the credential is one the rule can apply to. */
  bearerToken: () => string | undefined;
}

/** The rule's reads, passed in so it is testable without the database or Flipt. */
export interface OwnKeyReads {
  offlineGrantFlagOn: () => Promise<boolean>;
  userKeyFlagOn: () => Promise<boolean>;
  mintOrigin: (apiKeyId: number) => Promise<string | null>;
}

/**
 * The caller's own token when the request is a limited key the orchestrator should meter as itself,
 * else null. The cheap checks run first, so a request the rule cannot apply to reads neither Flipt nor
 * the database.
 */
export async function resolveOwnKeyToken(
  input: OwnKeyRequest,
  reads: OwnKeyReads
): Promise<string | null> {
  const { subject, apiKeyId, apiKeyType } = input.credential;
  const offlineGrant = subject?.type === 'oauth' && apiKeyType === 'Access';
  const userKey = subject?.type === 'apiKey' && apiKeyType === 'User';
  if (apiKeyId == null || (!offlineGrant && !userKey)) return null;
  // A moderator path can fetch a token for another user; the limit is the caller's own.
  if (input.sessionUserId !== input.userId) return null;
  if (!input.buzzLimit || input.buzzLimit.length === 0) return null;
  const bearerToken = input.bearerToken();
  if (!bearerToken) return null;

  if (userKey) return (await reads.userKeyFlagOn()) ? bearerToken : null;
  if (!(await reads.offlineGrantFlagOn())) return null;
  if ((await reads.mintOrigin(apiKeyId)) !== 'refresh') return null;
  return bearerToken;
}

/** The token to send the orchestrator for this request when it is the caller's own limited key; null otherwise. */
export function ownKeyOrchestratorToken(
  userId: number,
  req: NextApiRequest
): Promise<string | null> {
  const context = (req as NextApiRequest & { context?: RequestContext }).context;
  return resolveOwnKeyToken(
    {
      userId,
      credential: getRequestCredential(req),
      sessionUserId: context?.session?.user?.id,
      buzzLimit: (context?.buzzLimit ?? null) as BuzzLimit | null,
      bearerToken: () => readRequestBearerToken(req),
    },
    {
      offlineGrantFlagOn: () => isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT),
      userKeyFlagOn: () => isFlipt(FLIPT_FEATURE_FLAGS.USER_KEY_BUZZ_LIMIT_PROXY),
      mintOrigin: readMintOrigin,
    }
  );
}

/** Postgres `undefined_column`: the migration adding `ApiKey.mintOrigin` has not been applied. */
const UNDEFINED_COLUMN = '42703';

/**
 * The `mintOrigin` of an `Access` key, or null. Null too when the column does not exist yet (the
 * flag turned on before the manual migration), so that ordering mistake skips the cap instead of
 * breaking generation; any other error is thrown.
 */
export async function readMintOrigin(
  apiKeyId: number,
  executor?: Pick<KyselyWrite, 'selectFrom'>
): Promise<string | null> {
  // Loaded on first use: this module sits on getOrchestratorToken's import path, and the Kysely
  // module opens its pools at load.
  const db = executor ?? (await import('~/server/db/kyselyDb')).kyselyWrite;
  try {
    // primary: a refresh mints the token moments before the app first uses it, so a replica can
    // still lack the row, which would read as "no origin" and skip the cap.
    const row = await db
      .selectFrom('ApiKey')
      .select(sql<string | null>`"mintOrigin"`.as('mintOrigin'))
      .where('id', '=', apiKeyId)
      .where('type', '=', 'Access')
      .executeTakeFirst();
    return row?.mintOrigin ?? null;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === UNDEFINED_COLUMN) return null;
    throw err;
  }
}
