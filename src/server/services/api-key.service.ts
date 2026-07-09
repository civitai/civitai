import { Prisma } from '@prisma/client';
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
import { bustBuzzLimitCache, deleteAuthSubject } from '~/server/http/orchestrator/api-key-spend';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { logToAxiom, safeError } from '~/server/logging/client';

export function getApiKey({ id }: GetAPIKeyInput) {
  return dbRead.apiKey.findUnique({
    where: { id },
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
    where: { userId, type: 'User' },
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
  }: AddAPIKeyInput & { userId: number; maxAge?: number; type?: ApiKeyType },
  date = new Date()
) {
  const key = generateKey();
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
  const updated = await dbWrite.apiKey.update({
    where: { id, userId },
    data: { buzzLimit: buzzLimit ?? Prisma.DbNull },
    select: { id: true, userId: true, buzzLimit: true },
  });

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

export async function getTemporaryUserApiKey(
  args: AddAPIKeyInput & { userId: number; maxAge?: number; type?: ApiKeyType }
) {
  const date = new Date();
  const key = await addApiKey(args, date);

  if (args.maxAge) {
    const { userId, type, name } = args;
    await dbWrite.apiKey.deleteMany({
      where: { userId, type, name, expiresAt: { lt: new Date(date.getTime() + 30000) } },
    });
    await dbWrite.apiKey.deleteMany({ where: { userId, type, name: 'generation-service' } });
  }

  return key;
}

export async function deleteApiKey({ id, userId }: DeleteAPIKeyInput & { userId: number }) {
  const result = await dbWrite.apiKey.deleteMany({
    where: { userId, id },
  });

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

    // Expire the deleted key in the orchestrator: it caches the user's API
    // keys for auth, so without this the key keeps working until the cache
    // TTL lapses. invalidateCivitaiUser swallows its own errors.
    await invalidateCivitaiUser({ userId });
  }

  return result;
}
