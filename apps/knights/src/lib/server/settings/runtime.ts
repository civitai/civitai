import { REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';
import { createStoredSettingsSource, type StoredSettings } from './stored';

const source = createStoredSettingsSource({
  read: () => getSysRedis().get(REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES),
});

/** The settings saved on the moderator Config page, read at most every 30s. */
export const storedSettings = (): Promise<StoredSettings> => source.load();
