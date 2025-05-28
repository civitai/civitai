import type { ApiKeyType } from '~/shared/utils/prisma/enums';
import { dbWrite, dbRead } from '~/server/db/client';
import type {
  AddAPIKeyInput,
  DeleteAPIKeyInput,
  GetAPIKeyInput,
  GetUserAPIKeysInput,
} from '~/server/schema/api-key.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

export function getApiKey({ id }: GetAPIKeyInput) {
  return dbRead.apiKey.findUnique({
    where: { id },
    select: {
      scope: true,
      user: { select: simpleUserSelect },
    },
  });
}

export async function getUserApiKeys({
  take,
  skip,
  userId,
}: GetUserAPIKeysInput & { userId: number }) {
  const keys = await dbRead.apiKey.findMany({
    take,
    skip,
    where: { userId, type: 'User' },
    select: {
      id: true,
      scope: true,
      name: true,
      createdAt: true,
    },
  });
  return keys.filter((x) => x.name !== generationServiceCookie.name);
}

export async function addApiKey(
  {
    name,
    scope,
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
      scope,
      name,
      userId,
      key: secret,
      expiresAt,
      type,
    },
  });

  return key;
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

export function deleteApiKey({ id, userId }: DeleteAPIKeyInput & { userId: number }) {
  return dbWrite.apiKey.deleteMany({
    where: {
      userId,
      id,
    },
  });
}
