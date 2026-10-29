import { env } from '$env/dynamic/private';
import { hiddenCheckSettings, type HiddenCheckSettings } from './config';

/** Read per call so a changed environment is picked up without a rebuild. */
export const hiddenSettings = (): HiddenCheckSettings => hiddenCheckSettings(env);
