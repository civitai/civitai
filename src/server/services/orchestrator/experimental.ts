import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

type ExperimentalConfig = {
  userIds?: number[];
  permissions?: 'all' | 'mod';
};

export async function getExperimentalConfig(): Promise<ExperimentalConfig> {
  const config = await sysRedis.get(REDIS_SYS_KEYS.GENERATION.EXPERIMENTAL);
  return config ? JSON.parse(config) : {};
}

export async function setExperimentalConfig(data: ExperimentalConfig) {
  await sysRedis.set(REDIS_SYS_KEYS.GENERATION.EXPERIMENTAL, JSON.stringify(data));
}

export async function getExperimentalFlag({
  userId,
  isModerator = false,
}: {
  userId: number;
  isModerator?: boolean;
}) {
  const { userIds = [], permissions } = await getExperimentalConfig();
  const userIdMatch = userIds.indexOf(userId) > -1;
  const permissionsMatch = !permissions ? false : permissions === 'mod' ? isModerator : true;
  return userIdMatch || permissionsMatch;
}
