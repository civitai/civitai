import { env } from '$env/dynamic/private';
import { storedSettings } from '../settings/runtime';
import { hiddenCheckSettings, type HiddenCheckSettings } from './config';

/** Read per call so a changed environment is picked up without a rebuild; the moderators' saved values are read at most every 30s. */
export const hiddenSettings = async (): Promise<HiddenCheckSettings> =>
  hiddenCheckSettings(env, await storedSettings());
