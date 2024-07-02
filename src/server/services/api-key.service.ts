import { ApiKeyType } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
import {
  AddAPIKeyInput,
  DeleteAPIKeyInput,
  GetAPIKeyInput,
  GetUserAPIKeysInput,
} from '~/server/schema/api-key.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';

export function getApiKey({ id }: GetAPIKeyInput) {
  return dbRead.apiKey.findUnique({
    where: { id },
    select: {
      scope: true,
      user: { select: simpleUserSelect },
    },
  });
}

export function getUserApiKeys({ take, skip, userId }: GetUserAPIKeysInput & { userId: number }) {
  return dbRead.apiKey.findMany({
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
}

export async function addApiKey({
  name,
  scope,
  userId,
  maxAge,
  type,
}: AddAPIKeyInput & { userId: number; maxAge?: number; type?: ApiKeyType }) {
  const key = generateKey();
  const secret = generateSecretHash(key);
  const expiresAt = maxAge ? new Date(new Date().getTime() + maxAge * 1000) : undefined;

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
  const key = await addApiKey(args);

  if (args.maxAge) {
    const { userId, type, name } = args;
    const date = new Date();
    await dbWrite.apiKey.deleteMany({ where: { userId, type, name, expiresAt: { lt: date } } });
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
