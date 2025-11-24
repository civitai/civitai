import type { Session } from 'next-auth';
import { getSessionUser } from './session-user';
import { generateSecretHash } from '~/server/utils/key-generator';

export async function getSessionFromBearerToken(key: string) {
  const token = generateSecretHash(key.trim());
  const user = (await getSessionUser({ token })) as Session['user'];
  if (!user) return null;
  return { user } as Session;
}
