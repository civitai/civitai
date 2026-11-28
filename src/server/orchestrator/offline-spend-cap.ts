import { sql } from 'kysely';
import type { NextApiRequest } from 'next';
import type { kyselyWrite } from '~/server/db/kyselyDb';

type KyselyWrite = typeof kyselyWrite;
import { readRequestBearerToken } from '~/server/auth/request-bearer-token';
import { getRequestCredential, type RequestCredential } from '~/server/auth/request-credential';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type { BuzzLimit } from '~/server/schema/api-key.schema';
import { TRPCError } from '@trpc/server';
import {
  getBuzzLimitForSubject,
  type BuzzSpendEntry,
  type Subject,
} from '~/server/http/orchestrator/api-key-spend';
import { OFFLINE_BUZZ_CAP_REACHED } from '~/server/orchestrator/api-key-buzz-limit-refusal';

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
// Null has always meant "no limit" for the `buzzLimit` column (`buzzLimitSchema`). Only flag-on code
// reads `mintOrigin` (a no-type column, see schema.full.prisma).

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
  return (await reads.mintOrigin(apiKeyId)) === 'refresh' ? bearerToken : null;
}

/** The orchestrator's spend snapshot for a subject; null when it tracks none. */
export type SpendRead = (userId: number, subject: Subject) => Promise<BuzzSpendEntry | null>;

/**
 * Refuses a spend on work already running (a boost, an unlock) for a capped offline OAuth token whose
 * cap is spent, or has less left than the spend's price when that is known. The orchestrator does not hold such a spend to the cap, so it is checked here. A
 * snapshot that cannot be read refuses too. Every other request, including a personal key, passes.
 */
export async function assertOfflineCapLeftForRunningWork(
  input: OwnKeyRequest,
  reads: OwnKeyReads & { spend: SpendRead },
  /** The spend's price when the caller knows it (a boost): refused when it is more than is left. */
  cost?: number
) {
  const { subject } = input.credential;
  if (subject?.type !== 'oauth') return;
  if (!(await resolveOwnKeyToken(input, reads))) return;
  const snapshot = await reads.spend(input.userId, subject).then(
    (entry) => ({ entry }),
    () => null
  );
  const remaining = (snapshot?.entry?.rules ?? [])
    .filter((rule) => rule.limit > 0)
    .map((rule) => rule.remaining);
  const left = remaining.length ? Math.min(...remaining) : Infinity;
  if (!snapshot || left <= 0 || (cost != null && cost > left))
    throw new TRPCError({ code: 'FORBIDDEN', message: OFFLINE_BUZZ_CAP_REACHED });
}

function ownKeyRequest(userId: number, req: NextApiRequest): OwnKeyRequest {
  const context = (req as NextApiRequest & { context?: RequestContext }).context;
  return {
    userId,
    credential: getRequestCredential(req),
    sessionUserId: context?.session?.user?.id,
    buzzLimit: (context?.buzzLimit ?? null) as BuzzLimit | null,
    bearerToken: () => readRequestBearerToken(req),
  };
}

const ownKeyReads: OwnKeyReads = {
  offlineGrantFlagOn: () => isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT),
  userKeyFlagOn: () => isFlipt(FLIPT_FEATURE_FLAGS.USER_KEY_BUZZ_LIMIT_PROXY),
  mintOrigin: (id) => readMintOrigin(id),
};

/** `assertOfflineCapLeftForRunningWork` for this request. */
export function offlineCapLeftForRunningWork(userId: number, req: NextApiRequest, cost?: number) {
  return assertOfflineCapLeftForRunningWork(
    ownKeyRequest(userId, req),
    { ...ownKeyReads, spend: (id, subject) => getBuzzLimitForSubject({ userId: id, subject }) },
    cost
  );
}

/** The token to send the orchestrator for this request when it is the caller's own limited key; null otherwise. */
export function ownKeyOrchestratorToken(
  userId: number,
  req: NextApiRequest
): Promise<string | null> {
  return resolveOwnKeyToken(ownKeyRequest(userId, req), ownKeyReads);
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
