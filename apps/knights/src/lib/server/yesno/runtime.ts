import { env } from '$env/dynamic/private';
import { storedSettings } from '../settings/runtime';
import { yesNoSettings, type YesNoSettings } from './config';

/** Read per call so a changed environment is picked up without a rebuild; the moderators' saved values are read at most every 30s. */
export const yesNoConfig = async (): Promise<YesNoSettings> =>
  yesNoSettings(env, await storedSettings());
