import { env } from '$env/dynamic/private';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';
import {
  createStoredShareSource,
  withStoredShare,
  yesNoSettings,
  type YesNoSettings,
} from './config';

const storedShare = createStoredShareSource({
  read: () => getSysRedis().get(REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES),
});

/** Read per call so a changed environment is picked up without a rebuild; the moderators' saved share is read at most every 30s. */
export const yesNoConfig = async (): Promise<YesNoSettings> =>
  withStoredShare(yesNoSettings(env), await storedShare.load());
