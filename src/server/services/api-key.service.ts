import { prisma } from '~/server/db/client';
import {
  AddAPIKeyInput,
  DeleteAPIKeyInput,
  GetAPIKeyInput,
  GetUserAPIKeysInput,
} from '~/server/schema/api-key.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';

export function getApiKey({ id }: GetAPIKeyInput) {
  return prisma.apiKey.findUnique({
    where: { id },
    select: {
      scope: true,
      user: { select: simpleUserSelect },
    },
  });
}

export function getUserApiKeys({ take, skip, userId }: GetUserAPIKeysInput & { userId: number }) {
  return prisma.apiKey.findMany({
    take,
    skip,
    where: { userId },
    select: {
      id: true,
      scope: true,
      name: true,
      createdAt: true,
    },
  });
}

export async function addApiKey({ name, scope, userId }: AddAPIKeyInput & { userId: number }) {
  const key = generateKey();
  const secret = generateSecretHash(key);

  await prisma.apiKey.create({
    data: {
      scope,
      name,
      userId,
      key: secret,
    },
  });

  return key;
}

export function deleteApiKey({ id, userId }: DeleteAPIKeyInput & { userId: number }) {
  return prisma.apiKey.deleteMany({
    where: {
      userId,
      id,
    },
  });
}
