import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { ApiKeyType } from '~/shared/utils/prisma/enums';
import { dbWrite, dbRead } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import type {
  AddAPIKeyInput,
  BuzzLimit,
  DeleteAPIKeyInput,
  GetAPIKeyInput,
  GetUserAPIKeysInput,
} from '~/server/schema/api-key.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { bustBuzzLimitCache, deleteAuthSubject } from '~/server/http/orchestrator/api-key-spend';
import { revokeCivitaiUserTokens } from '~/server/services/orchestrator/civitai';
import { logToAxiom, safeError } from '~/server/logging/client';
import { evictCachedApiKeys } from '~/server/auth/api-key-principal-cache';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

export function getApiKey({ id, userId }: GetAPIKeyInput & { userId: number }) {
  return dbRead.apiKey.findFirst({
    where: { id, userId },
    select: {
      tokenScope: true,
      user: { select: simpleUserSelect },
    },
  });
}

export async function getUserApiKeys({
  take,
  skip,
  userId,
}: GetUserAPIKeysInput & { userId: number }) {
  const db = await getDbWithoutLag('userApiKeys', userId);
  const keys = await db.apiKey.findMany({
    take,
    skip,
    // An expired key no longer works, so the owner is not shown it.
    where: { userId, type: 'User', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: {
      id: true,
      tokenScope: true,
      name: true,
      createdAt: true,
      lastUsedAt: true,
      buzzLimit: true,
    },
  });
  return keys.filter((x) => x.name !== generationServiceCookie.name);
}

export async function addApiKey(
  {
    name,
    tokenScope,
    buzzLimit,
    userId,
    maxAge,
    type,
    key = generateKey(),
  }: AddAPIKeyInput & { userId: number; maxAge?: number; type?: ApiKeyType; key?: string },
  date = new Date()
) {
  const secret = generateSecretHash(key);
  const expiresAt = maxAge ? new Date(date.getTime() + maxAge * 1000) : undefined;

  await dbWrite.apiKey.create({
    data: {
      tokenScope,
      buzzLimit: buzzLimit ?? undefined,
      name,
      userId,
      key: secret,
      expiresAt,
      type,
    },
  });

  return key;
}

/**
 * The spend limit of an API key, read from the PRIMARY. `/api/v1/me` hands this to the orchestrator,
 * which caches it for its own TTL, so it must never come from the bearer path's short-lived row cache:
 * a lowered limit whose cache eviction failed would otherwise be picked up stale and held there.
 * `undefined` when the key no longer exists or has expired (revoked mid-request) — never `null`, which means "no cap".
 */
export async function readApiKeyBuzzLimit(id: number): Promise<BuzzLimit | null | undefined> {
  const row = await dbWrite.apiKey.findUnique({
    where: { id },
    select: { buzzLimit: true, expiresAt: true },
  });
  if (!row || (row.expiresAt && row.expiresAt < new Date())) return undefined;
  return (row.buzzLimit as BuzzLimit | null) ?? null;
}

export async function setApiKeyBuzzLimit({
  id,
  userId,
  buzzLimit,
}: {
  id: number;
  userId: number;
  buzzLimit: BuzzLimit | null;
}) {
  // Caller already verified the key belongs to the user; this update is the
  // source of truth that the orchestrator will re-fetch via /api/v1/me.
  const { key, ...updated } = await dbWrite.apiKey.update({
    where: { id, userId },
    data: { buzzLimit: buzzLimit ?? Prisma.DbNull },
    select: { id: true, userId: true, buzzLimit: true, key: true },
  });
  // The bearer path caches `buzzLimit` with the rest of the row.
  await evictCachedApiKeys([key]);

  // Best-effort: invalidate the orchestrator's cached limit. Failure is logged
  // but doesn't fail the user-facing mutation — the orchestrator's cache TTL
  // will eventually pick up the new value.
  try {
    await bustBuzzLimitCache({
      userId: updated.userId,
      subject: { type: 'apiKey', id: updated.id },
    });
  } catch (err) {
    // Axiom field cap: stick to known columns. Detail goes inside `error`.
    logToAxiom({
      type: 'oauth.bust-cache.failed',
      message: `bust-cache failed for apiKey ${updated.id} user ${updated.userId}`,
      error: safeError(err),
    }).catch(() => {});
  }

  return updated;
}

const AI_SERVICES_SCOPES = TokenScope.AIServicesRead | TokenScope.AIServicesWrite;

type MintApiKeyArgs = AddAPIKeyInput & { userId: number; maxAge?: number; type?: ApiKeyType };

/** Read from the primary: a ban must stop the next mint, not the one after the session cache expires. */
export async function assertAccountOpenForMint(userId: number, refusalMessage?: string) {
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, deletedAt: true },
  });
  // Default wording is not the session-facing one: a moderator acting on another account reaches this too.
  const refuse = (message: string) =>
    new TRPCError({ code: 'FORBIDDEN', message: refusalMessage ?? message });
  if (!user) throw refuse('This account does not exist');
  if (user.bannedAt) throw refuse('This account has been banned');
  if (user.deletedAt) throw refuse('This account has been deleted');
}

/**
 * The one way to create an API key for a user account: refuses a banned, deleted or missing account
 * from the primary, and checks again after the insert, expiring the user's keys if a ban or deletion
 * committed in between (its own revocation may not have seen the new row).
 */
export async function mintApiKey(
  args: MintApiKeyArgs,
  {
    refusalMessage,
    logName = 'mint-closed-account-expire',
    date = new Date(),
  }: { refusalMessage?: string; logName?: string; date?: Date } = {}
) {
  await assertAccountOpenForMint(args.userId, refusalMessage);
  const key = await addApiKey(args, date);
  try {
    await assertAccountOpenForMint(args.userId, refusalMessage);
  } catch (refusal) {
    if (!(refusal instanceof TRPCError)) throw refusal;
    // A failure here leaves the key for the ban's own revocation and its job to expire.
    await expireUserApiKeys(args.userId).catch((error) =>
      logToAxiom({
        type: 'error',
        name: logName,
        userId: args.userId,
        error: safeError(error),
      }).catch(() => null)
    );
    throw refusal;
  }
  return key;
}

export async function getTemporaryUserApiKey(args: MintApiKeyArgs) {
  const date = new Date();
  const key = await mintApiKey(args, { logName: 'mint-banned-account-expire', date });

  if (args.maxAge) {
    const { userId, type, name } = args;
    await dbWrite.apiKey.deleteMany({
      where: { userId, type, name, expiresAt: { lt: new Date(date.getTime() + 30000) } },
    });
    await dbWrite.apiKey.deleteMany({ where: { userId, type, name: 'generation-service' } });
  }

  return key;
}

/**
 * Delete the API keys matching `where` and evict them from the bearer-path cache, which is keyed by
 * the stored hash — so the hashes are read first. Use this, not `apiKey.deleteMany`, for any delete
 * that can REVOKE a personal or system key; `api-key-principal-cache.ledger.test.ts` lists every
 * ApiKey write in the repo and fails when one is added.
 */
export async function deleteApiKeys(where: Prisma.ApiKeyWhereInput) {
  const rows = await dbWrite.apiKey.findMany({
    where,
    select: { id: true, key: true, userId: true },
  });
  if (!rows.length) return { count: 0 };
  const result = await dbWrite.apiKey.deleteMany({
    where: { AND: [where, { id: { in: rows.map((row) => row.id) } }] },
  });
  await evictCachedApiKeys(rows.map((row) => row.key));
  // The orchestrator caches keys for auth too. revokeCivitaiUserTokens swallows its own errors.
  const userIds = [...new Set(rows.map((row) => row.userId))];
  await Promise.all(userIds.map((userId) => revokeCivitaiUserTokens({ userId })));
  return result;
}

/**
 * Revokes every live key the user holds by expiring it in place, so the rows survive as a record
 * of what the account held (a ban can be an evidence case). The auth paths refuse an expired row.
 * Evicts every key of the user from the bearer cache, not only the ones it expires, so a repeat
 * call also retries a failed eviction; then expires the orchestrator's cached auth for the user.
 */
export async function expireUserApiKeys(userId: number) {
  const now = new Date();
  const rows = await dbWrite.apiKey.findMany({
    where: { userId },
    select: { id: true, key: true, expiresAt: true },
  });
  const live = rows.filter((row) => !row.expiresAt || row.expiresAt > now);
  if (live.length) {
    await dbWrite.apiKey.updateMany({
      where: { id: { in: live.map((row) => row.id) } },
      data: { expiresAt: now },
    });
  }
  await evictCachedApiKeys(rows.map((row) => row.key));
  await forgetGenerationToken(userId);
  // Even with no live rows: an earlier attempt may have expired them and then failed this call.
  const orchestratorConfirmed = await revokeCivitaiUserTokens({ userId });
  return { expired: live.length, orchestratorConfirmed };
}

/**
 * Drops the user's cached generation token, which holds a key just expired: left for its hour, it
 * would be handed to the orchestrator after an unban or restore and refused. The next generation
 * call mints a fresh one. Never throws.
 */
export async function forgetGenerationToken(userId: number) {
  try {
    // Raced like a read: a half-open sysRedis must not stall the ban.
    const field = userId.toString();
    await withSysReadDeadline(
      Promise.all([
        sysRedis.hDel(REDIS_KEYS.GENERATION.TOKENS_OWNED, field),
        // The training studio's own cache, and the older shared key it still reads.
        sysRedis.hDel(REDIS_SYS_KEYS.GENERATION.ORCHESTRATOR_TOKENS, field),
        sysRedis.hDel(REDIS_SYS_KEYS.GENERATION.TOKENS, field),
      ])
    );
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'expire-user-api-keys-generation-token',
      userId,
      message: (error as Error).message,
    }).catch(() => null);
  }
}

/**
 * Expires the user's generation credentials: every System key and every app token carrying an
 * AI Services scope. Other app tokens, personal keys and the site session are left alone. The next
 * generation call that is allowed mints afresh.
 */
export async function expireGenerationCredentials(userId: number) {
  const now = new Date();
  const rows = await dbWrite.apiKey.findMany({
    where: { userId, type: { in: ['System', 'Access', 'Refresh'] } },
    select: { id: true, key: true, type: true, tokenScope: true, expiresAt: true },
  });
  const matched = rows.filter(
    (row) =>
      row.type === 'System' ||
      ((row.type === 'Access' || row.type === 'Refresh') &&
        (row.tokenScope & AI_SERVICES_SCOPES) !== 0)
  );
  const live = matched.filter((row) => !row.expiresAt || row.expiresAt > now);
  if (live.length) {
    await dbWrite.apiKey.updateMany({
      where: { id: { in: live.map((row) => row.id) } },
      data: { expiresAt: now },
    });
  }
  // Every matched key, not only the live ones: a repeat call retries an eviction an earlier one missed.
  if (matched.length) await evictCachedApiKeys(matched.map((row) => row.key));
  await forgetGenerationToken(userId);
  return { expired: live.length };
}

export async function deleteApiKey({ id, userId }: DeleteAPIKeyInput & { userId: number }) {
  const result = await deleteApiKeys({ userId, id });

  // Best-effort: tell the orchestrator the subject is gone so its Mongo
  // doesn't accumulate dangling spend records. Skipped silently if the
  // delete didn't actually match anything.
  if (result.count > 0) {
    deleteAuthSubject({ userId, subject: { type: 'apiKey', id } }).catch((err) => {
      logToAxiom({
        type: 'oauth.delete-subject.failed',
        message: `delete-subject failed for apiKey ${id} user ${userId}`,
        error: safeError(err),
      }).catch(() => {});
    });
  }

  return result;
}
