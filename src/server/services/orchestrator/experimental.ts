import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

type ExperimentalConfig = {
  userIds?: number[];
  permissions?: ('all' | 'mod' | 'non-member' | 'member')[];
};

export async function getExperimentalConfig(): Promise<ExperimentalConfig> {
  try {
    const config = await sysRedis.get(REDIS_SYS_KEYS.GENERATION.EXPERIMENTAL);
    return config ? JSON.parse(config) : {};
  } catch (e) {
    return {};
  }
}

export async function setExperimentalConfig(data: ExperimentalConfig) {
  await sysRedis.set(REDIS_SYS_KEYS.GENERATION.EXPERIMENTAL, JSON.stringify(data));
}

export async function getExperimentalFlag({
  userId,
  isModerator = false,
  isMember = false,
}: {
  userId: number;
  isModerator?: boolean;
  isMember?: boolean;
}) {
  const { userIds = [], permissions } = await getExperimentalConfig();
  if (isModerator && permissions?.includes('mod')) return true;
  if (userIds.indexOf(userId) > -1) return true;
  if (permissions?.includes('member') && isMember) return true;
  if (permissions?.includes('non-member') && !isMember) return true;
  if (permissions?.includes('all')) return true;
  return false;
}
