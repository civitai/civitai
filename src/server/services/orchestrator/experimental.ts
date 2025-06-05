import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

type ExperimentalConfig = {
  /** users that should use experimental flag when making requests to the orchestrator */
  userIds?: number[];
  permissions?: ('all' | 'mod' | 'non-member' | 'member')[];
  /** currently used to allow users to make prohibited requests without getting reported */
  testing?: number[];
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

export async function getExperimentalFlags({
  userId,
  isModerator = false,
  isMember = false,
}: {
  userId: number;
  isModerator?: boolean;
  isMember?: boolean;
}) {
  const { userIds = [], permissions, testing = [] } = await getExperimentalConfig();
  let experimental = false;
  if (isModerator && permissions?.includes('mod')) experimental = true;
  if (userIds.indexOf(userId) > -1) experimental = true;
  if (permissions?.includes('member') && isMember) experimental = true;
  if (permissions?.includes('non-member') && !isMember) experimental = true;
  if (permissions?.includes('all')) experimental = true;

  return {
    experimental,
    testing: testing.indexOf(userId) > -1,
  };
}
